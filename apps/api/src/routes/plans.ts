import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";

import {
  validatePlan,
  type DependencyEdge,
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
  phases,
  planTasks,
  plans,
  taskDependencies,
  type PmGoDb,
} from "@pm-go/db";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createPlansRoute(deps: PlansRouteDeps) {
  const app = new Hono();

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

    return c.json({ plan, artifactIds }, 200);
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

