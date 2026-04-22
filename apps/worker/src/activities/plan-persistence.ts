import { and, eq, inArray } from "drizzle-orm";

import type {
  AgentRun,
  Artifact,
  DependencyEdge,
  Plan,
  RepoSnapshot,
  SpecDocument,
  UUID,
} from "@pm-go/contracts";
import {
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
import { createSpanWriter, withSpan } from "@pm-go/observability";

export interface PlanPersistenceDeps {
  db: PmGoDb;
}

export interface PersistPlanResult {
  planId: UUID;
  phaseCount: number;
  taskCount: number;
}

export interface PlanPersistenceActivities {
  persistPlan(plan: Plan): Promise<PersistPlanResult>;
  persistAgentRun(run: AgentRun): Promise<string>;
  persistArtifact(artifact: Artifact): Promise<string>;
  loadSpecDocument(specDocumentId: string): Promise<SpecDocument>;
  loadRepoSnapshot(repoSnapshotId: string): Promise<RepoSnapshot>;
}

/**
 * Build the set of persistence activities used by planning workflows.
 *
 * Every function is idempotent by construction (except `persistArtifact`,
 * which is append-only per contract) and wraps multi-row work in a single
 * transaction so partial writes cannot leak into downstream workflows.
 */
export function createPlanPersistenceActivities(
  deps: PlanPersistenceDeps,
): PlanPersistenceActivities {
  const { db } = deps;

  return {
    async persistPlan(plan: Plan): Promise<PersistPlanResult> {
      const sink = createSpanWriter({ db, planId: plan.id }).writeSpan;
      return withSpan(
        "worker.activities.plan-persistence.persistPlan",
        {
          planId: plan.id,
          phaseCount: plan.phases.length,
          taskCount: plan.tasks.length,
        },
        async () => persistPlanImpl(db, plan),
        { sink },
      );
    },

    async persistAgentRun(run: AgentRun): Promise<string> {
      return persistAgentRunImpl(db, run);
    },

    async persistArtifact(artifact: Artifact): Promise<string> {
      const planId = artifact.planId;
      const sink = planId
        ? createSpanWriter({ db, planId }).writeSpan
        : undefined;
      return withSpan(
        "worker.activities.plan-persistence.persistArtifact",
        {
          ...(planId ? { planId } : {}),
          ...(artifact.taskId ? { taskId: artifact.taskId } : {}),
          kind: artifact.kind,
        },
        async () => persistArtifactImpl(db, artifact),
        sink ? { sink } : {},
      );
    },

    async loadSpecDocument(specDocumentId: string): Promise<SpecDocument> {
      return loadSpecDocumentImpl(db, specDocumentId);
    },

    async loadRepoSnapshot(repoSnapshotId: string): Promise<RepoSnapshot> {
      return loadRepoSnapshotImpl(db, repoSnapshotId);
    },
  };
}

// Underscore-prefixed implementations factored out so the wrapped
// `withSpan` callable closes over a stable function reference; keeps
// each public method body short while preserving the original logic
// verbatim.
async function persistPlanImpl(
  db: PmGoDb,
  plan: Plan,
): Promise<PersistPlanResult> {
  return db.transaction(async (tx) => {
        // 1. Plan row — upsert by id so re-planning cycles update in place.
        await tx
          .insert(plans)
          .values({
            id: plan.id,
            specDocumentId: plan.specDocumentId,
            repoSnapshotId: plan.repoSnapshotId,
            title: plan.title,
            summary: plan.summary,
            status: plan.status,
            risks: plan.risks,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
          })
          .onConflictDoUpdate({
            target: plans.id,
            set: {
              title: plan.title,
              summary: plan.summary,
              status: plan.status,
              risks: plan.risks,
              updatedAt: plan.updatedAt,
            },
          });

        // 2. Phase rows — upsert by id. Optional timestamps and ids map to
        //    nullable columns, so coerce `undefined` to `null` explicitly.
        for (const phase of plan.phases) {
          await tx
            .insert(phases)
            .values({
              id: phase.id,
              planId: plan.id,
              index: phase.index,
              title: phase.title,
              summary: phase.summary,
              status: phase.status,
              integrationBranch: phase.integrationBranch,
              baseSnapshotId: phase.baseSnapshotId,
              taskIdsOrdered: phase.taskIds,
              mergeOrder: phase.mergeOrder,
              phaseAuditReportId: phase.phaseAuditReportId ?? null,
              startedAt: phase.startedAt ?? null,
              completedAt: phase.completedAt ?? null,
            })
            .onConflictDoUpdate({
              target: phases.id,
              set: {
                index: phase.index,
                title: phase.title,
                summary: phase.summary,
                status: phase.status,
                integrationBranch: phase.integrationBranch,
                baseSnapshotId: phase.baseSnapshotId,
                taskIdsOrdered: phase.taskIds,
                mergeOrder: phase.mergeOrder,
                phaseAuditReportId: phase.phaseAuditReportId ?? null,
                startedAt: phase.startedAt ?? null,
                completedAt: phase.completedAt ?? null,
              },
            });
        }

        // 3. Task rows — upsert by id. Includes nested jsonb fields.
        for (const task of plan.tasks) {
          await tx
            .insert(planTasks)
            .values({
              id: task.id,
              planId: task.planId,
              phaseId: task.phaseId,
              slug: task.slug,
              title: task.title,
              summary: task.summary,
              kind: task.kind,
              status: task.status,
              riskLevel: task.riskLevel,
              fileScope: task.fileScope,
              acceptanceCriteria: task.acceptanceCriteria,
              testCommands: task.testCommands,
              budget: task.budget,
              reviewerPolicy: task.reviewerPolicy,
              requiresHumanApproval: task.requiresHumanApproval,
              maxReviewFixCycles: task.maxReviewFixCycles,
              branchName: task.branchName ?? null,
              worktreePath: task.worktreePath ?? null,
            })
            .onConflictDoUpdate({
              target: planTasks.id,
              set: {
                planId: task.planId,
                phaseId: task.phaseId,
                slug: task.slug,
                title: task.title,
                summary: task.summary,
                kind: task.kind,
                status: task.status,
                riskLevel: task.riskLevel,
                fileScope: task.fileScope,
                acceptanceCriteria: task.acceptanceCriteria,
                testCommands: task.testCommands,
                budget: task.budget,
                reviewerPolicy: task.reviewerPolicy,
                requiresHumanApproval: task.requiresHumanApproval,
                maxReviewFixCycles: task.maxReviewFixCycles,
                branchName: task.branchName ?? null,
                worktreePath: task.worktreePath ?? null,
              },
            });
        }

        // 4. Dependency edges — collect across every phase, dedupe by
        //    (from, to) since the edge set is a graph, not a multiset.
        const edges: DependencyEdge[] = [];
        const seen = new Set<string>();
        for (const phase of plan.phases) {
          for (const edge of phase.dependencyEdges) {
            const key = `${edge.fromTaskId}:${edge.toTaskId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push(edge);
          }
        }

        const planTaskIds = plan.tasks.map((t) => t.id);

        // 5. Prune stale edges. Only edges whose `from_task_id` belongs to
        //    this plan and that are absent from the new edge set are
        //    removed. Edges originating in other plans stay untouched.
        if (planTaskIds.length > 0) {
          const existing = await tx
            .select({
              fromTaskId: taskDependencies.fromTaskId,
              toTaskId: taskDependencies.toTaskId,
            })
            .from(taskDependencies)
            .where(inArray(taskDependencies.fromTaskId, planTaskIds));

          const stale = existing.filter(
            (row) => !seen.has(`${row.fromTaskId}:${row.toTaskId}`),
          );

          for (const row of stale) {
            await tx
              .delete(taskDependencies)
              .where(
                and(
                  eq(taskDependencies.fromTaskId, row.fromTaskId),
                  eq(taskDependencies.toTaskId, row.toTaskId),
                ),
              );
          }
        }

        // 4 (continued). Upsert the current edges. `onConflictDoUpdate`
        // fires on the composite PK (from_task_id, to_task_id).
        for (const edge of edges) {
          await tx
            .insert(taskDependencies)
            .values({
              fromTaskId: edge.fromTaskId,
              toTaskId: edge.toTaskId,
              reason: edge.reason,
              required: edge.required,
            })
            .onConflictDoUpdate({
              target: [
                taskDependencies.fromTaskId,
                taskDependencies.toTaskId,
              ],
              set: {
                reason: edge.reason,
                required: edge.required,
              },
            });
        }

        return {
          planId: plan.id,
          phaseCount: plan.phases.length,
          taskCount: plan.tasks.length,
        };
      });
}

async function persistAgentRunImpl(db: PmGoDb, run: AgentRun): Promise<string> {
  // Contract-optional fields land as NULL, not the string "undefined".
  // Using explicit `?? null` keeps Drizzle's insert-arg type happy under
  // `exactOptionalPropertyTypes`, which forbids passing `undefined`
  // where the column is typed as `string | null`.
  const values = {
    id: run.id,
    taskId: run.taskId ?? null,
    workflowRunId: run.workflowRunId,
    role: run.role,
    depth: run.depth,
    status: run.status,
    riskLevel: run.riskLevel,
    executor: run.executor,
    model: run.model,
    promptVersion: run.promptVersion,
    sessionId: run.sessionId ?? null,
    parentSessionId: run.parentSessionId ?? null,
    permissionMode: run.permissionMode,
    budgetUsdCap:
      run.budgetUsdCap !== undefined ? String(run.budgetUsdCap) : null,
    maxTurnsCap: run.maxTurnsCap ?? null,
    turns: run.turns ?? null,
    inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null,
    cacheCreationTokens: run.cacheCreationTokens ?? null,
    cacheReadTokens: run.cacheReadTokens ?? null,
    costUsd: run.costUsd !== undefined ? String(run.costUsd) : null,
    stopReason: run.stopReason ?? null,
    outputFormatSchemaRef: run.outputFormatSchemaRef ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    errorReason: run.errorReason ?? null,
  };

  // Resolve the owning planId via the linked task (if any) so the span
  // sink has a valid FK target. agent_runs without a task linkage are
  // plan-level (e.g. planner runs) and skip the span — `withSpan`
  // tolerates a missing sink.
  let planId: string | null = null;
  if (run.taskId) {
    const [taskRow] = await db
      .select({ planId: planTasks.planId })
      .from(planTasks)
      .where(eq(planTasks.id, run.taskId))
      .limit(1);
    planId = taskRow?.planId ?? null;
  }
  const sink = planId
    ? createSpanWriter({ db, planId }).writeSpan
    : undefined;

  return withSpan(
    "worker.activities.plan-persistence.persistAgentRun",
    {
      ...(planId ? { planId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
      role: run.role,
      runId: run.id,
    },
    async () => {
      await db
        .insert(agentRuns)
        .values(values)
        .onConflictDoUpdate({
          target: agentRuns.id,
          set: {
            taskId: values.taskId,
            workflowRunId: values.workflowRunId,
            role: values.role,
            depth: values.depth,
            status: values.status,
            riskLevel: values.riskLevel,
            executor: values.executor,
            model: values.model,
            promptVersion: values.promptVersion,
            sessionId: values.sessionId,
            parentSessionId: values.parentSessionId,
            permissionMode: values.permissionMode,
            budgetUsdCap: values.budgetUsdCap,
            maxTurnsCap: values.maxTurnsCap,
            turns: values.turns,
            inputTokens: values.inputTokens,
            outputTokens: values.outputTokens,
            cacheCreationTokens: values.cacheCreationTokens,
            cacheReadTokens: values.cacheReadTokens,
            costUsd: values.costUsd,
            stopReason: values.stopReason,
            outputFormatSchemaRef: values.outputFormatSchemaRef,
            startedAt: values.startedAt,
            completedAt: values.completedAt,
            errorReason: values.errorReason,
          },
        });
      return run.id;
    },
    sink ? { sink } : {},
  );
}

async function persistArtifactImpl(
  db: PmGoDb,
  artifact: Artifact,
): Promise<string> {
  // Artifacts are append-only: no upsert, no onConflict behaviour. A
  // duplicate id surfaces as a DB error, which is the correct signal
  // that the caller attempted to re-emit an immutable artifact.
  await db.insert(artifacts).values({
    id: artifact.id,
    taskId: artifact.taskId ?? null,
    planId: artifact.planId ?? null,
    kind: artifact.kind,
    uri: artifact.uri,
    createdAt: artifact.createdAt,
  });
  return artifact.id;
}

async function loadSpecDocumentImpl(
  db: PmGoDb,
  specDocumentId: string,
): Promise<SpecDocument> {
  const rows = await db
    .select()
    .from(specDocuments)
    .where(eq(specDocuments.id, specDocumentId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `loadSpecDocument: no spec_documents row with id ${specDocumentId}`,
    );
  }
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    body: row.body,
    createdAt: row.createdAt,
  };
}

async function loadRepoSnapshotImpl(
  db: PmGoDb,
  repoSnapshotId: string,
): Promise<RepoSnapshot> {
  const rows = await db
    .select()
    .from(repoSnapshots)
    .where(eq(repoSnapshots.id, repoSnapshotId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `loadRepoSnapshot: no repo_snapshots row with id ${repoSnapshotId}`,
    );
  }
  // `exactOptionalPropertyTypes` forbids `repoUrl: undefined` on the
  // contract shape, so only attach the key when it has a value.
  return {
    id: row.id,
    repoRoot: row.repoRoot,
    ...(row.repoUrl !== null ? { repoUrl: row.repoUrl } : {}),
    defaultBranch: row.defaultBranch,
    headSha: row.headSha,
    languageHints: row.languageHints,
    frameworkHints: row.frameworkHints,
    buildCommands: row.buildCommands,
    testCommands: row.testCommands,
    ciConfigPaths: row.ciConfigPaths,
    capturedAt: row.capturedAt,
  };
}
