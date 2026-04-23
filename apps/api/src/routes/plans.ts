import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";

import {
  validatePlan,
  type CompletionAuditWorkflowInput,
  type DependencyEdge,
  type FinalReleaseWorkflowInput,
  type Phase,
  type Plan,
  type Risk,
  type SpecToPlanWorkflowInput,
  type Task,
  type UUID,
} from "@pm-go/contracts";
import { auditPlan } from "@pm-go/planner";
import {
  artifacts,
  completionAuditReports,
  mergeRuns,
  phases,
  planTasks,
  plans,
  taskDependencies,
  type PmGoDb,
} from "@pm-go/db";

import { approveSubject } from "./approvals.js";
import { toIso } from "../lib/timestamps.js";

/**
 * Dependencies for the /plans route group.
 *
 * V1 convention: `planId === specDocumentId` because there is exactly one
 * plan per spec. The Temporal workflow is started with workflowId
 * `plan-${specDocumentId}` so re-posting for the same spec is a no-op on
 * the Temporal side.
 */
export interface PlansRouteDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
  artifactDir: string;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createPlansRoute(deps: PlansRouteDeps) {
  const app = new Hono();

  // GET /plans — summary list ordered by updatedAt DESC.
  //
  // Deliberately a narrow projection (id/title/status/risks/
  // updatedAt/completionAuditReportId) so a dashboard landing page
  // renders in a single round-trip without pulling full phase/task
  // trees. Callers who need the full `Plan` use `GET /plans/:id`.
  app.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: plans.id,
        title: plans.title,
        summary: plans.summary,
        status: plans.status,
        risks: plans.risks,
        completionAuditReportId: plans.completionAuditReportId,
        createdAt: plans.createdAt,
        updatedAt: plans.updatedAt,
      })
      .from(plans)
      .orderBy(desc(plans.updatedAt));

    return c.json(
      {
        plans: rows.map((row) => ({
          id: row.id,
          title: row.title,
          summary: row.summary,
          status: row.status,
          risks: (row.risks ?? []) as Risk[],
          completionAuditReportId: row.completionAuditReportId,
          createdAt: toIso(row.createdAt),
          updatedAt: toIso(row.updatedAt),
        })),
      },
      200,
    );
  });

  // POST /plans — start SpecToPlanWorkflow
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      specDocumentId?: unknown;
      repoSnapshotId?: unknown;
      requestedBy?: unknown;
    } | null;

    if (!body || typeof body !== "object") {
      return c.json({ error: "missing JSON body" }, 400);
    }
    if (!isUuid(body.specDocumentId)) {
      return c.json({ error: "specDocumentId must be a UUID" }, 400);
    }
    if (!isUuid(body.repoSnapshotId)) {
      return c.json({ error: "repoSnapshotId must be a UUID" }, 400);
    }
    const requestedBy =
      typeof body.requestedBy === "string" && body.requestedBy.trim().length > 0
        ? body.requestedBy
        : "api";

    const input: SpecToPlanWorkflowInput = {
      specDocumentId: body.specDocumentId,
      repoSnapshotId: body.repoSnapshotId,
      requestedBy,
    };

    const handle = await deps.temporal.workflow.start("SpecToPlanWorkflow", {
      args: [input],
      taskQueue: deps.taskQueue,
      workflowId: `plan-${body.specDocumentId}`,
    });

    // V1 convention: planId === specDocumentId (1:1 per spec).
    return c.json(
      {
        planId: body.specDocumentId,
        workflowRunId: handle.firstExecutionRunId,
      },
      202,
    );
  });

  // POST /plans/:planId/audit — deterministic audit over the stored plan
  app.post("/:planId/audit", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }

    const plan = await loadPlanById(deps.db, planId);
    if (!plan) {
      return c.json({ error: `plan ${planId} not found` }, 404);
    }

    const outcome = auditPlan(plan);
    return c.json(
      {
        planId: outcome.planId,
        approved: outcome.approved,
        revisionRequested: outcome.revisionRequested,
        findings: outcome.findings,
      },
      200,
    );
  });

  // GET /plans/:planId — reconstruct Plan object from DB joins
  app.get("/:planId", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }

    const plan = await loadPlanById(deps.db, planId);
    if (!plan) {
      return c.json({ error: `plan ${planId} not found` }, 404);
    }
    if (!validatePlan(plan)) {
      return c.json(
        { error: `reconstructed plan ${planId} failed PlanSchema validation` },
        500,
      );
    }

    const artifactRows = await deps.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.planId, planId));
    const artifactIds = artifactRows.map((r) => r.id);

    // latestCompletionAudit — the most recent completion audit verdict
    // for this plan, if one exists. Re-audits produce new rows; callers
    // use this to see the current release-readiness state without a
    // second round-trip.
    const [latestAuditRow] = await deps.db
      .select()
      .from(completionAuditReports)
      .where(eq(completionAuditReports.planId, planId))
      .orderBy(desc(completionAuditReports.createdAt))
      .limit(1);
    const latestCompletionAudit = latestAuditRow
      ? {
          id: latestAuditRow.id,
          planId: latestAuditRow.planId,
          finalPhaseId: latestAuditRow.finalPhaseId,
          mergeRunId: latestAuditRow.mergeRunId,
          auditorRunId: latestAuditRow.auditorRunId,
          auditedHeadSha: latestAuditRow.auditedHeadSha,
          outcome: latestAuditRow.outcome,
          checklist: latestAuditRow.checklist,
          findings: latestAuditRow.findings,
          summary: latestAuditRow.summary,
          createdAt: toIso(latestAuditRow.createdAt),
        }
      : null;

    return c.json({ plan, artifactIds, latestCompletionAudit }, 200);
  });

  // POST /plans/:planId/complete — start CompletionAuditWorkflow.
  // Precondition: every phase row must have `status='completed'`. The
  // final phase's latest merge_run supplies the mergeRunId input.
  app.post("/:planId/complete", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }

    const [planRow] = await deps.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    if (!planRow) {
      return c.json({ error: `plan ${planId} not found` }, 404);
    }

    const phaseRows = await deps.db
      .select({
        id: phases.id,
        index: phases.index,
        status: phases.status,
      })
      .from(phases)
      .where(eq(phases.planId, planId));
    if (phaseRows.length === 0) {
      return c.json({ error: `plan ${planId} has no phases` }, 409);
    }
    const notDone = phaseRows.filter((p) => p.status !== "completed");
    if (notDone.length > 0) {
      return c.json(
        {
          error: `plan ${planId} has ${notDone.length} phase(s) not completed`,
          blockedPhaseIds: notDone.map((p) => p.id),
        },
        409,
      );
    }

    const finalPhase = [...phaseRows].sort((a, b) => b.index - a.index)[0]!;
    const [finalMergeRun] = await deps.db
      .select({ id: mergeRuns.id })
      .from(mergeRuns)
      .where(eq(mergeRuns.phaseId, finalPhase.id))
      .orderBy(desc(mergeRuns.startedAt))
      .limit(1);
    if (!finalMergeRun) {
      return c.json(
        { error: `no merge_run for final phase ${finalPhase.id}` },
        409,
      );
    }

    const priorAudits = await deps.db
      .select({ id: completionAuditReports.id })
      .from(completionAuditReports)
      .where(eq(completionAuditReports.planId, planId));
    const auditIndex = priorAudits.length + 1;

    const body = (await c.req.json().catch(() => null)) as {
      requestedBy?: unknown;
    } | null;
    const requestedBy =
      body &&
      typeof body.requestedBy === "string" &&
      body.requestedBy.trim().length > 0
        ? body.requestedBy
        : "api";

    const input: CompletionAuditWorkflowInput = {
      planId,
      finalPhaseId: finalPhase.id,
      mergeRunId: finalMergeRun.id,
      requestedBy,
    };

    const handle = await deps.temporal.workflow.start(
      "CompletionAuditWorkflow",
      {
        args: [input],
        taskQueue: deps.taskQueue,
        workflowId: `plan-complete-${planId}-${auditIndex}`,
      },
    );

    return c.json(
      {
        planId,
        workflowRunId: handle.firstExecutionRunId,
        auditIndex,
      },
      202,
    );
  });

  // POST /plans/:planId/release — start FinalReleaseWorkflow.
  // Precondition: the plan must have a completion audit with outcome='pass'
  // already stamped on `plans.completion_audit_report_id`.
  app.post("/:planId/release", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }

    const [planRow] = await deps.db
      .select({
        id: plans.id,
        completionAuditReportId: plans.completionAuditReportId,
      })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    if (!planRow) {
      return c.json({ error: `plan ${planId} not found` }, 404);
    }
    if (!planRow.completionAuditReportId) {
      return c.json(
        {
          error: `plan ${planId} has no completion_audit_report_id; run POST /plans/${planId}/complete first`,
        },
        409,
      );
    }

    const [auditRow] = await deps.db
      .select({ id: completionAuditReports.id, outcome: completionAuditReports.outcome })
      .from(completionAuditReports)
      .where(eq(completionAuditReports.id, planRow.completionAuditReportId))
      .limit(1);
    if (!auditRow) {
      return c.json(
        {
          error: `completion_audit_report ${planRow.completionAuditReportId} not found`,
        },
        404,
      );
    }
    if (auditRow.outcome !== "pass") {
      return c.json(
        {
          error: `completion audit for plan ${planId} has outcome='${auditRow.outcome}'; /release requires 'pass'`,
        },
        409,
      );
    }

    const priorReleases = await deps.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.planId, planId), eq(artifacts.kind, "pr_summary")));
    const releaseIndex = priorReleases.length + 1;

    const input: FinalReleaseWorkflowInput = {
      planId,
      completionAuditReportId: planRow.completionAuditReportId,
    };

    const handle = await deps.temporal.workflow.start("FinalReleaseWorkflow", {
      args: [input],
      taskQueue: deps.taskQueue,
      workflowId: `plan-release-${planId}-${releaseIndex}`,
    });

    return c.json(
      {
        planId,
        workflowRunId: handle.firstExecutionRunId,
        releaseIndex,
      },
      202,
    );
  });

  // POST /plans/:planId/approve — Phase 7. Plan-scoped approval flip,
  // mirrors POST /tasks/:taskId/approve. 409 when no pending
  // approval_requests row for the plan exists.
  app.post("/:planId/approve", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      approvedBy?: unknown;
    } | null;
    const approvedBy =
      body &&
      typeof body.approvedBy === "string" &&
      body.approvedBy.trim().length > 0
        ? body.approvedBy
        : undefined;

    const updated = await approveSubject(
      deps.db,
      { kind: "plan", planId },
      approvedBy,
    );
    if (!updated) {
      return c.json(
        {
          error: `no pending plan-scoped approval_requests row for plan ${planId}`,
        },
        409,
      );
    }
    return c.json({ planId, approval: updated }, 200);
  });

  return app;
}

export function createCompletionAuditReportsRoute(deps: { db: PmGoDb }) {
  const app = new Hono();
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const [row] = await deps.db
      .select()
      .from(completionAuditReports)
      .where(eq(completionAuditReports.id, id))
      .limit(1);
    if (!row) {
      return c.json({ error: `completion_audit_report ${id} not found` }, 404);
    }
    return c.json(
      {
        id: row.id,
        planId: row.planId,
        finalPhaseId: row.finalPhaseId,
        mergeRunId: row.mergeRunId,
        auditorRunId: row.auditorRunId,
        auditedHeadSha: row.auditedHeadSha,
        outcome: row.outcome,
        checklist: row.checklist,
        findings: row.findings,
        summary: row.summary,
        createdAt: toIso(row.createdAt),
      },
      200,
    );
  });
  return app;
}

/**
 * Rehydrate a `Plan` from its normalised rows. Returns `null` when the
 * plan row is missing. Does not validate — callers that care about
 * integrity should run `validatePlan` on the returned object.
 */
async function loadPlanById(
  db: PmGoDb,
  planId: UUID,
): Promise<Plan | null> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const planRow = planRows[0];
  if (!planRow) return null;

  const phaseRows = await db
    .select()
    .from(phases)
    .where(eq(phases.planId, planId));

  const taskRows = await db
    .select()
    .from(planTasks)
    .where(eq(planTasks.planId, planId));

  const taskIds = taskRows.map((t) => t.id);
  const edgeRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(taskDependencies)
          .where(inArray(taskDependencies.fromTaskId, taskIds))
      : [];

  // Group dependency edges by phase: an edge belongs to the phase whose
  // tasks include the `fromTaskId`. (The contract has edges live on
  // `Phase.dependencyEdges`, so rebuild that association here.)
  const taskIdToPhase = new Map<string, string>();
  for (const t of taskRows) {
    taskIdToPhase.set(t.id, t.phaseId);
  }
  const edgesByPhase = new Map<string, DependencyEdge[]>();
  for (const row of edgeRows) {
    const phaseId = taskIdToPhase.get(row.fromTaskId);
    if (!phaseId) continue;
    const edges = edgesByPhase.get(phaseId) ?? [];
    edges.push({
      fromTaskId: row.fromTaskId,
      toTaskId: row.toTaskId,
      reason: row.reason,
      required: row.required,
    });
    edgesByPhase.set(phaseId, edges);
  }

  const phasesOut: Phase[] = phaseRows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      id: row.id,
      planId: row.planId,
      index: row.index,
      title: row.title,
      summary: row.summary,
      status: row.status,
      integrationBranch: row.integrationBranch,
      baseSnapshotId: row.baseSnapshotId,
      taskIds: row.taskIdsOrdered,
      dependencyEdges: edgesByPhase.get(row.id) ?? [],
      mergeOrder: row.mergeOrder,
      ...(row.phaseAuditReportId !== null
        ? { phaseAuditReportId: row.phaseAuditReportId }
        : {}),
      ...(row.startedAt !== null ? { startedAt: toIso(row.startedAt) } : {}),
      ...(row.completedAt !== null ? { completedAt: toIso(row.completedAt) } : {}),
    }));

  const tasksOut: Task[] = taskRows.map((row) => ({
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    status: row.status,
    riskLevel: row.riskLevel,
    fileScope: row.fileScope,
    acceptanceCriteria: row.acceptanceCriteria,
    testCommands: row.testCommands,
    budget: row.budget,
    reviewerPolicy: row.reviewerPolicy,
    requiresHumanApproval: row.requiresHumanApproval,
    maxReviewFixCycles: row.maxReviewFixCycles,
    ...(row.branchName !== null ? { branchName: row.branchName } : {}),
    ...(row.worktreePath !== null ? { worktreePath: row.worktreePath } : {}),
  }));

  const plan: Plan = {
    id: planRow.id,
    specDocumentId: planRow.specDocumentId,
    repoSnapshotId: planRow.repoSnapshotId,
    title: planRow.title,
    summary: planRow.summary,
    status: planRow.status,
    phases: phasesOut,
    tasks: tasksOut,
    risks: (planRow.risks ?? []) as Risk[],
    createdAt: toIso(planRow.createdAt),
    updatedAt: toIso(planRow.updatedAt),
  };

  // Silence unused warning under strict mode — `and` is convenient for
  // extensions but not required on this simple reconstruction path.
  void and;
  return plan;
}

