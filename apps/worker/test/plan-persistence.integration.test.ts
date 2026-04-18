import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { asc, eq, sql } from "drizzle-orm";

import type { Plan, RepoSnapshot, SpecDocument } from "@pm-go/contracts";
import { validatePlan } from "../../../packages/contracts/src/validators/orchestration-review/plan.js";
import {
  createDb,
  closeDb,
  agentRuns,
  artifacts,
  phases,
  planTasks,
  plans,
  repoSnapshots,
  specDocuments,
  taskDependencies,
  type PmGoDb,
} from "@pm-go/db";
import { createPlanPersistenceActivities } from "../src/activities/plan-persistence.js";

// ---------------------------------------------------------------------------
// Fixtures — same disk-loading pattern as the unit test and spec-intake tests.
// ---------------------------------------------------------------------------

const planFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const specDocumentFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/spec-document.json",
    import.meta.url,
  ),
);
const repoSnapshotFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/repo-snapshot.json",
    import.meta.url,
  ),
);

const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));
const specDocumentFixture: SpecDocument = JSON.parse(
  readFileSync(specDocumentFixturePath, "utf8"),
);
const repoSnapshotFixture: RepoSnapshot = JSON.parse(
  readFileSync(repoSnapshotFixturePath, "utf8"),
);

// The plan fixture points at its own specDocumentId and repoSnapshotId — the
// core fixtures use different UUIDs. Seed rows under the plan's IDs so the
// foreign keys resolve without mutating the shared fixtures.
const seedSpec: SpecDocument = {
  ...specDocumentFixture,
  id: planFixture.specDocumentId,
};
const seedRepo: RepoSnapshot = {
  ...repoSnapshotFixture,
  id: planFixture.repoSnapshotId,
};

const databaseUrl = process.env["DATABASE_URL_TEST"];

// ---------------------------------------------------------------------------
// Helpers — schema lifecycle. Rather than depending on a migration bundle we
// may not control, we drop and rebuild the full Phase 2 table set against the
// test database each run. This mirrors `packages/db/test/round-trip.test.ts`.
// ---------------------------------------------------------------------------

async function resetSchema(db: PmGoDb): Promise<void> {
  await db.execute(sql`DROP TABLE IF EXISTS "artifacts" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "agent_runs" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "task_dependencies" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "plan_tasks" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "phases" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "plans" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "repo_snapshots" CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS "spec_documents" CASCADE`);
  // Enums — drop with IF EXISTS to stay idempotent across test runs.
  await db.execute(sql`DROP TYPE IF EXISTS "spec_document_source"`);
  await db.execute(sql`DROP TYPE IF EXISTS "plan_status"`);
  await db.execute(sql`DROP TYPE IF EXISTS "phase_status"`);
  await db.execute(sql`DROP TYPE IF EXISTS "risk_level"`);
  await db.execute(sql`DROP TYPE IF EXISTS "task_kind"`);
  await db.execute(sql`DROP TYPE IF EXISTS "task_status"`);
  await db.execute(sql`DROP TYPE IF EXISTS "agent_permission_mode"`);
  await db.execute(sql`DROP TYPE IF EXISTS "agent_role"`);
  await db.execute(sql`DROP TYPE IF EXISTS "agent_run_status"`);
  await db.execute(sql`DROP TYPE IF EXISTS "agent_stop_reason"`);
  await db.execute(sql`DROP TYPE IF EXISTS "artifact_kind"`);

  // Enum types — kept in the same order as the canonical migration bundle.
  await db.execute(
    sql`CREATE TYPE "spec_document_source" AS ENUM ('manual', 'imported')`,
  );
  await db.execute(
    sql`CREATE TYPE "plan_status" AS ENUM ('draft', 'auditing', 'approved', 'blocked', 'executing', 'completed', 'failed')`,
  );
  await db.execute(
    sql`CREATE TYPE "phase_status" AS ENUM ('pending', 'planning', 'executing', 'integrating', 'auditing', 'completed', 'blocked', 'failed')`,
  );
  await db.execute(sql`CREATE TYPE "risk_level" AS ENUM ('low', 'medium', 'high')`);
  await db.execute(
    sql`CREATE TYPE "task_kind" AS ENUM ('foundation', 'implementation', 'review', 'integration', 'release')`,
  );
  await db.execute(
    sql`CREATE TYPE "task_status" AS ENUM ('pending', 'ready', 'running', 'in_review', 'fixing', 'ready_to_merge', 'merged', 'blocked', 'failed')`,
  );
  await db.execute(
    sql`CREATE TYPE "agent_permission_mode" AS ENUM ('default', 'acceptEdits', 'bypassPermissions', 'plan')`,
  );
  await db.execute(
    sql`CREATE TYPE "agent_role" AS ENUM ('planner', 'partitioner', 'implementer', 'auditor', 'integrator', 'release-reviewer', 'explorer')`,
  );
  await db.execute(
    sql`CREATE TYPE "agent_run_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'timed_out', 'canceled')`,
  );
  await db.execute(
    sql`CREATE TYPE "agent_stop_reason" AS ENUM ('completed', 'budget_exceeded', 'turns_exceeded', 'timeout', 'canceled', 'error', 'scope_violation')`,
  );
  await db.execute(
    sql`CREATE TYPE "artifact_kind" AS ENUM ('plan_markdown', 'review_report', 'completion_audit_report', 'completion_evidence_bundle', 'test_report', 'event_log', 'patch_bundle', 'pr_summary')`,
  );

  // Tables — minimum fields required by the activity under test.
  await db.execute(sql`
    CREATE TABLE "spec_documents" (
      "id" uuid PRIMARY KEY NOT NULL,
      "title" text NOT NULL,
      "source" "spec_document_source" NOT NULL,
      "body" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE "repo_snapshots" (
      "id" uuid PRIMARY KEY NOT NULL,
      "repo_root" text NOT NULL,
      "repo_url" text,
      "default_branch" text NOT NULL,
      "head_sha" text NOT NULL,
      "language_hints" text[] NOT NULL,
      "framework_hints" text[] NOT NULL,
      "build_commands" text[] NOT NULL,
      "test_commands" text[] NOT NULL,
      "ci_config_paths" text[] NOT NULL,
      "captured_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE "plans" (
      "id" uuid PRIMARY KEY NOT NULL,
      "spec_document_id" uuid NOT NULL REFERENCES "spec_documents"("id"),
      "repo_snapshot_id" uuid NOT NULL REFERENCES "repo_snapshots"("id"),
      "title" text NOT NULL,
      "summary" text NOT NULL,
      "status" "plan_status" NOT NULL,
      "risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE "phases" (
      "id" uuid PRIMARY KEY NOT NULL,
      "plan_id" uuid NOT NULL REFERENCES "plans"("id") ON DELETE CASCADE,
      "index" integer NOT NULL,
      "title" text NOT NULL,
      "summary" text NOT NULL,
      "status" "phase_status" NOT NULL,
      "integration_branch" text NOT NULL,
      "base_snapshot_id" uuid NOT NULL REFERENCES "repo_snapshots"("id"),
      "task_ids_ordered" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "merge_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "phase_audit_report_id" uuid,
      "started_at" timestamp with time zone,
      "completed_at" timestamp with time zone,
      CONSTRAINT "phases_plan_id_index_unique" UNIQUE ("plan_id", "index")
    )
  `);
  await db.execute(sql`
    CREATE TABLE "plan_tasks" (
      "id" uuid PRIMARY KEY NOT NULL,
      "plan_id" uuid NOT NULL REFERENCES "plans"("id") ON DELETE CASCADE,
      "phase_id" uuid NOT NULL REFERENCES "phases"("id") ON DELETE CASCADE,
      "slug" text NOT NULL,
      "title" text NOT NULL,
      "summary" text NOT NULL,
      "kind" "task_kind" NOT NULL,
      "status" "task_status" NOT NULL,
      "risk_level" "risk_level" NOT NULL,
      "file_scope" jsonb NOT NULL,
      "acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "test_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "budget" jsonb NOT NULL,
      "reviewer_policy" jsonb NOT NULL,
      "requires_human_approval" boolean DEFAULT false NOT NULL,
      "max_review_fix_cycles" integer DEFAULT 2 NOT NULL,
      "branch_name" text,
      "worktree_path" text,
      CONSTRAINT "plan_tasks_plan_id_slug_unique" UNIQUE ("plan_id", "slug")
    )
  `);
  await db.execute(sql`
    CREATE TABLE "task_dependencies" (
      "from_task_id" uuid NOT NULL REFERENCES "plan_tasks"("id") ON DELETE CASCADE,
      "to_task_id" uuid NOT NULL REFERENCES "plan_tasks"("id") ON DELETE CASCADE,
      "reason" text NOT NULL,
      "required" boolean DEFAULT true NOT NULL,
      PRIMARY KEY ("from_task_id", "to_task_id")
    )
  `);
  await db.execute(sql`
    CREATE TABLE "agent_runs" (
      "id" uuid PRIMARY KEY NOT NULL,
      "task_id" uuid REFERENCES "plan_tasks"("id") ON DELETE SET NULL,
      "workflow_run_id" text NOT NULL,
      "role" "agent_role" NOT NULL,
      "depth" integer NOT NULL,
      "status" "agent_run_status" NOT NULL,
      "risk_level" "risk_level" NOT NULL,
      "executor" text DEFAULT 'claude' NOT NULL,
      "model" text NOT NULL,
      "prompt_version" text NOT NULL,
      "session_id" text,
      "parent_session_id" text,
      "permission_mode" "agent_permission_mode" NOT NULL,
      "budget_usd_cap" numeric(10, 4),
      "max_turns_cap" integer,
      "turns" integer,
      "input_tokens" integer,
      "output_tokens" integer,
      "cache_creation_tokens" integer,
      "cache_read_tokens" integer,
      "cost_usd" numeric(10, 6),
      "stop_reason" "agent_stop_reason",
      "output_format_schema_ref" text,
      "started_at" timestamp with time zone,
      "completed_at" timestamp with time zone,
      CONSTRAINT "agent_runs_depth_range" CHECK ("depth" >= 0 AND "depth" <= 2)
    )
  `);
  await db.execute(sql`
    CREATE TABLE "artifacts" (
      "id" uuid PRIMARY KEY NOT NULL,
      "task_id" uuid REFERENCES "plan_tasks"("id") ON DELETE CASCADE,
      "plan_id" uuid REFERENCES "plans"("id") ON DELETE CASCADE,
      "kind" "artifact_kind" NOT NULL,
      "uri" text NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "artifacts_task_or_plan_present" CHECK (("task_id" IS NOT NULL) OR ("plan_id" IS NOT NULL))
    )
  `);
}

async function seedPrerequisites(db: PmGoDb): Promise<void> {
  await db.insert(specDocuments).values({
    id: seedSpec.id,
    title: seedSpec.title,
    source: seedSpec.source,
    body: seedSpec.body,
    createdAt: seedSpec.createdAt,
  });
  await db.insert(repoSnapshots).values({
    id: seedRepo.id,
    repoRoot: seedRepo.repoRoot,
    repoUrl: seedRepo.repoUrl ?? null,
    defaultBranch: seedRepo.defaultBranch,
    headSha: seedRepo.headSha,
    languageHints: seedRepo.languageHints,
    frameworkHints: seedRepo.frameworkHints,
    buildCommands: seedRepo.buildCommands,
    testCommands: seedRepo.testCommands,
    ciConfigPaths: seedRepo.ciConfigPaths,
    capturedAt: seedRepo.capturedAt,
  });
}

// Reconstruct a `Plan` from the row-shape records. We rebuild phases and
// tasks in the order the fixture declares them (by index / original
// ordering) so array-level deep equality works without sorting the
// fixture itself.
async function loadPlanFromDb(
  db: PmGoDb,
  planId: string,
): Promise<Plan> {
  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  if (!planRow) {
    throw new Error(`no plan row with id ${planId}`);
  }

  const phaseRows = await db
    .select()
    .from(phases)
    .where(eq(phases.planId, planId))
    .orderBy(asc(phases.index));

  const taskRows = await db
    .select()
    .from(planTasks)
    .where(eq(planTasks.planId, planId));

  // Preserve the fixture's task declaration order by re-indexing against it.
  const fixtureTaskOrder = new Map<string, number>();
  planFixture.tasks.forEach((t, i) => fixtureTaskOrder.set(t.id, i));
  taskRows.sort((a, b) => {
    const ai = fixtureTaskOrder.get(a.id) ?? 0;
    const bi = fixtureTaskOrder.get(b.id) ?? 0;
    return ai - bi;
  });

  // Fetch edges scoped to this plan's tasks and group them by originating
  // phase so the reconstructed Plan mirrors the fixture's per-phase edge
  // arrays. We look up `fromTaskId -> phaseId` from the already-loaded tasks.
  const taskIds = taskRows.map((t) => t.id);
  const edgeRows = taskIds.length
    ? await db
        .select()
        .from(taskDependencies)
        .where(
          sql`${taskDependencies.fromTaskId} IN (${sql.join(
            taskIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
    : [];

  const taskIdToPhase = new Map<string, string>();
  for (const t of taskRows) taskIdToPhase.set(t.id, t.phaseId);

  const edgesByPhase = new Map<
    string,
    Array<{
      fromTaskId: string;
      toTaskId: string;
      reason: string;
      required: boolean;
    }>
  >();
  for (const e of edgeRows) {
    const phaseId = taskIdToPhase.get(e.fromTaskId);
    if (!phaseId) continue;
    const list = edgesByPhase.get(phaseId) ?? [];
    list.push({
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      reason: e.reason,
      required: e.required,
    });
    edgesByPhase.set(phaseId, list);
  }

  const rebuilt: Plan = {
    id: planRow.id,
    specDocumentId: planRow.specDocumentId,
    repoSnapshotId: planRow.repoSnapshotId,
    title: planRow.title,
    summary: planRow.summary,
    status: planRow.status,
    phases: phaseRows.map((p) => {
      const phase: Plan["phases"][number] = {
        id: p.id,
        planId: p.planId,
        index: p.index,
        title: p.title,
        summary: p.summary,
        status: p.status,
        integrationBranch: p.integrationBranch,
        baseSnapshotId: p.baseSnapshotId,
        taskIds: p.taskIdsOrdered,
        dependencyEdges: edgesByPhase.get(p.id) ?? [],
        mergeOrder: p.mergeOrder,
      };
      if (p.phaseAuditReportId !== null) {
        phase.phaseAuditReportId = p.phaseAuditReportId;
      }
      if (p.startedAt !== null) phase.startedAt = p.startedAt;
      if (p.completedAt !== null) phase.completedAt = p.completedAt;
      return phase;
    }),
    tasks: taskRows.map((t) => {
      const task: Plan["tasks"][number] = {
        id: t.id,
        planId: t.planId,
        phaseId: t.phaseId,
        slug: t.slug,
        title: t.title,
        summary: t.summary,
        kind: t.kind,
        status: t.status,
        riskLevel: t.riskLevel,
        fileScope: t.fileScope,
        acceptanceCriteria: t.acceptanceCriteria,
        testCommands: t.testCommands,
        budget: t.budget,
        reviewerPolicy: t.reviewerPolicy,
        requiresHumanApproval: t.requiresHumanApproval,
        maxReviewFixCycles: t.maxReviewFixCycles,
      };
      if (t.branchName !== null) task.branchName = t.branchName;
      if (t.worktreePath !== null) task.worktreePath = t.worktreePath;
      return task;
    }),
    risks: planRow.risks,
    createdAt: planRow.createdAt,
    updatedAt: planRow.updatedAt,
  };
  return rebuilt;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)(
  "plan-persistence integration round-trip",
  () => {
    it("round-trips the plan fixture with idempotent re-persistence", async () => {
      const db: PmGoDb = createDb(databaseUrl as string);
      try {
        await resetSchema(db);
        await seedPrerequisites(db);

        const activities = createPlanPersistenceActivities({ db });
        const result = await activities.persistPlan(planFixture);
        expect(result).toEqual({
          planId: planFixture.id,
          phaseCount: planFixture.phases.length,
          taskCount: planFixture.tasks.length,
        });

        const reconstructed = await loadPlanFromDb(db, planFixture.id);
        expect(validatePlan(reconstructed)).toBe(true);
        expect(reconstructed).toEqual(planFixture);

        // Idempotency — re-persist, re-read, assert row counts unchanged.
        const beforePhaseCount = (
          await db.select().from(phases).where(eq(phases.planId, planFixture.id))
        ).length;
        const beforeTaskCount = (
          await db
            .select()
            .from(planTasks)
            .where(eq(planTasks.planId, planFixture.id))
        ).length;

        await activities.persistPlan(planFixture);

        const afterPhaseCount = (
          await db.select().from(phases).where(eq(phases.planId, planFixture.id))
        ).length;
        const afterTaskCount = (
          await db
            .select()
            .from(planTasks)
            .where(eq(planTasks.planId, planFixture.id))
        ).length;
        expect(afterPhaseCount).toBe(beforePhaseCount);
        expect(afterTaskCount).toBe(beforeTaskCount);

        // Cleanup — delete the plan. Cascades clear phases/tasks/edges.
        await db.delete(plans).where(eq(plans.id, planFixture.id));
      } finally {
        // Leave the schema in place for subsequent runs; drop artefacts so
        // no rows leak across test invocations.
        await db
          .execute(sql`TRUNCATE TABLE "artifacts", "agent_runs" CASCADE`)
          .catch(() => undefined);
        await closeDb(db);
      }
    });
  },
);

// Suppress `no-unused-vars` on the `agentRuns`/`artifacts` table imports — they
// are referenced to keep the schema-reset logic honest about every table the
// activity can touch. Remove this shim once those tables are exercised
// directly from integration tests.
void agentRuns;
void artifacts;
