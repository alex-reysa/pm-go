import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";

import type {
  PhaseAuditWorkflowInput,
  PhaseIntegrationWorkflowInput,
  UUID,
} from "@pm-go/contracts";
import {
  mergeRuns,
  phaseAuditReports,
  phases,
  planTasks,
  type PmGoDb,
} from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

/**
 * Dependencies for the /phases route group. Temporal client + task queue
 * are used to start PhaseIntegrationWorkflow / PhaseAuditWorkflow; the
 * db is used for all GETs and state-machine precondition checks.
 */
export interface PhasesRouteDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createPhasesRoute(deps: PhasesRouteDeps) {
  const app = new Hono();

  // GET /phases?planId=<uuid> — list phases for a plan, ordered by
  // phase.index ascending. Narrow projection for dashboards — the
  // detail view uses `GET /phases/:phaseId` for merge-run + audit
  // inlines.
  app.get("/", async (c) => {
    const planId = c.req.query("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId query param must be a UUID" }, 400);
    }
    const rows = await deps.db
      .select({
        id: phases.id,
        planId: phases.planId,
        index: phases.index,
        title: phases.title,
        summary: phases.summary,
        status: phases.status,
        integrationBranch: phases.integrationBranch,
        phaseAuditReportId: phases.phaseAuditReportId,
        startedAt: phases.startedAt,
        completedAt: phases.completedAt,
      })
      .from(phases)
      .where(eq(phases.planId, planId))
      .orderBy(asc(phases.index));

    return c.json(
      {
        planId,
        phases: rows.map((r) => ({
          id: r.id,
          planId: r.planId,
          index: r.index,
          title: r.title,
          summary: r.summary,
          status: r.status,
          integrationBranch: r.integrationBranch,
          phaseAuditReportId: r.phaseAuditReportId,
          startedAt: r.startedAt ? toIso(r.startedAt) : null,
          completedAt: r.completedAt ? toIso(r.completedAt) : null,
        })),
      },
      200,
    );
  });

  // POST /phases/:phaseId/integrate — start PhaseIntegrationWorkflow.
  // Precondition: phase.status must be `executing` (first run) OR
  // `integrating` (idempotent re-entry after a crash). Any terminal
  // status is a 409.
  app.post("/:phaseId/integrate", async (c) => {
    const phaseId = c.req.param("phaseId");
    if (!isUuid(phaseId)) {
      return c.json({ error: "phaseId must be a UUID" }, 400);
    }

    const [phaseRow] = await deps.db
      .select({ id: phases.id, planId: phases.planId, status: phases.status })
      .from(phases)
      .where(eq(phases.id, phaseId))
      .limit(1);
    if (!phaseRow) {
      return c.json({ error: `phase ${phaseId} not found` }, 404);
    }
    if (phaseRow.status !== "executing" && phaseRow.status !== "integrating") {
      return c.json(
        {
          error: `phase ${phaseId} is status='${phaseRow.status}'; /integrate requires 'executing' or 'integrating'`,
        },
        409,
      );
    }

    // Every in-phase task must be in a final-for-integration state.
    // Tasks that are still `running` / `in_review` / `fixing` would
    // silently get left behind by the merge loop.
    const taskRows = await deps.db
      .select({ id: planTasks.id, status: planTasks.status })
      .from(planTasks)
      .where(eq(planTasks.phaseId, phaseId));
    const unready = taskRows.filter(
      (t) => t.status !== "ready_to_merge" && t.status !== "merged",
    );
    if (unready.length > 0) {
      return c.json(
        {
          error: `phase ${phaseId} has ${unready.length} task(s) not ready for integration (status not in ready_to_merge/merged)`,
          unreadyTaskIds: unready.map((t) => t.id),
        },
        409,
      );
    }

    // Counter-suffix workflow id: `phase-integrate-<phaseId>-<N>` where
    // N = (count of existing merge_runs for this phase) + 1. Keeps the
    // Temporal workflow id deterministic per attempt and matches the
    // Phase 4 `task-review-<id>-<N>` convention.
    const priorRuns = await deps.db
      .select({ id: mergeRuns.id })
      .from(mergeRuns)
      .where(eq(mergeRuns.phaseId, phaseId));
    const mergeRunIndex = priorRuns.length + 1;

    const input: PhaseIntegrationWorkflowInput = {
      planId: phaseRow.planId,
      phaseId,
    };

    const handle = await deps.temporal.workflow.start(
      "PhaseIntegrationWorkflow",
      {
        args: [input],
        taskQueue: deps.taskQueue,
        workflowId: `phase-integrate-${phaseId}-${mergeRunIndex}`,
      },
    );

    return c.json(
      {
        phaseId,
        workflowRunId: handle.firstExecutionRunId,
        mergeRunIndex,
      },
      202,
    );
  });

  // POST /phases/:phaseId/audit — start PhaseAuditWorkflow.
  // Precondition: phase.status must be `auditing` and the latest
  // merge_run for the phase must be completed with no failed_task_id.
  app.post("/:phaseId/audit", async (c) => {
    const phaseId = c.req.param("phaseId");
    if (!isUuid(phaseId)) {
      return c.json({ error: "phaseId must be a UUID" }, 400);
    }

    const [phaseRow] = await deps.db
      .select({ id: phases.id, planId: phases.planId, status: phases.status })
      .from(phases)
      .where(eq(phases.id, phaseId))
      .limit(1);
    if (!phaseRow) {
      return c.json({ error: `phase ${phaseId} not found` }, 404);
    }
    if (phaseRow.status !== "auditing") {
      return c.json(
        {
          error: `phase ${phaseId} is status='${phaseRow.status}'; /audit requires 'auditing'`,
        },
        409,
      );
    }

    const [latestMergeRun] = await deps.db
      .select()
      .from(mergeRuns)
      .where(eq(mergeRuns.phaseId, phaseId))
      .orderBy(desc(mergeRuns.startedAt))
      .limit(1);
    if (!latestMergeRun) {
      return c.json(
        { error: `no merge_run for phase ${phaseId}; run /integrate first` },
        409,
      );
    }
    if (latestMergeRun.failedTaskId !== null) {
      return c.json(
        {
          error: `latest merge_run ${latestMergeRun.id} has failed_task_id ${latestMergeRun.failedTaskId}; audit gated`,
        },
        409,
      );
    }
    if (!latestMergeRun.integrationHeadSha) {
      return c.json(
        {
          error: `latest merge_run ${latestMergeRun.id} has no integration_head_sha`,
        },
        409,
      );
    }

    const priorAudits = await deps.db
      .select({ id: phaseAuditReports.id })
      .from(phaseAuditReports)
      .where(eq(phaseAuditReports.phaseId, phaseId));
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

    const input: PhaseAuditWorkflowInput = {
      planId: phaseRow.planId,
      phaseId,
      mergeRunId: latestMergeRun.id,
      requestedBy,
    };

    const handle = await deps.temporal.workflow.start("PhaseAuditWorkflow", {
      args: [input],
      taskQueue: deps.taskQueue,
      workflowId: `phase-audit-${phaseId}-${auditIndex}`,
    });

    return c.json(
      {
        phaseId,
        mergeRunId: latestMergeRun.id,
        workflowRunId: handle.firstExecutionRunId,
        auditIndex,
      },
      202,
    );
  });

  // GET /phases/:phaseId — phase row + latest merge_run + latest phase_audit
  app.get("/:phaseId", async (c) => {
    const phaseId = c.req.param("phaseId");
    if (!isUuid(phaseId)) {
      return c.json({ error: "phaseId must be a UUID" }, 400);
    }

    const [phaseRow] = await deps.db
      .select()
      .from(phases)
      .where(eq(phases.id, phaseId))
      .limit(1);
    if (!phaseRow) {
      return c.json({ error: `phase ${phaseId} not found` }, 404);
    }

    const [latestMergeRun] = await deps.db
      .select()
      .from(mergeRuns)
      .where(eq(mergeRuns.phaseId, phaseId))
      .orderBy(desc(mergeRuns.startedAt))
      .limit(1);

    const [latestAudit] = await deps.db
      .select()
      .from(phaseAuditReports)
      .where(eq(phaseAuditReports.phaseId, phaseId))
      .orderBy(desc(phaseAuditReports.createdAt))
      .limit(1);

    return c.json(
      {
        phase: {
          id: phaseRow.id,
          planId: phaseRow.planId,
          index: phaseRow.index,
          title: phaseRow.title,
          summary: phaseRow.summary,
          status: phaseRow.status,
          integrationBranch: phaseRow.integrationBranch,
          baseSnapshotId: phaseRow.baseSnapshotId,
          taskIds: phaseRow.taskIdsOrdered,
          mergeOrder: phaseRow.mergeOrder,
          phaseAuditReportId: phaseRow.phaseAuditReportId,
          startedAt: phaseRow.startedAt ? toIso(phaseRow.startedAt) : null,
          completedAt: phaseRow.completedAt
            ? toIso(phaseRow.completedAt)
            : null,
        },
        latestMergeRun: latestMergeRun
          ? {
              id: latestMergeRun.id,
              planId: latestMergeRun.planId,
              phaseId: latestMergeRun.phaseId,
              integrationBranch: latestMergeRun.integrationBranch,
              baseSha: latestMergeRun.baseSha,
              mergedTaskIds: latestMergeRun.mergedTaskIds,
              failedTaskId: latestMergeRun.failedTaskId,
              integrationHeadSha: latestMergeRun.integrationHeadSha,
              postMergeSnapshotId: latestMergeRun.postMergeSnapshotId,
              integrationLeaseId: latestMergeRun.integrationLeaseId,
              startedAt: toIso(latestMergeRun.startedAt),
              completedAt: latestMergeRun.completedAt
                ? toIso(latestMergeRun.completedAt)
                : null,
            }
          : null,
        latestPhaseAudit: latestAudit
          ? {
              id: latestAudit.id,
              phaseId: latestAudit.phaseId,
              planId: latestAudit.planId,
              mergeRunId: latestAudit.mergeRunId,
              auditorRunId: latestAudit.auditorRunId,
              mergedHeadSha: latestAudit.mergedHeadSha,
              outcome: latestAudit.outcome,
              checklist: latestAudit.checklist,
              findings: latestAudit.findings,
              summary: latestAudit.summary,
              createdAt: toIso(latestAudit.createdAt),
              ...(latestAudit.overrideReason !== null
                ? { overrideReason: latestAudit.overrideReason }
                : {}),
              ...(latestAudit.overriddenBy !== null
                ? { overriddenBy: latestAudit.overriddenBy }
                : {}),
              ...(latestAudit.overriddenAt !== null
                ? { overriddenAt: toIso(latestAudit.overriddenAt) }
                : {}),
            }
          : null,
      },
      200,
    );
  });

  // POST /phases/:phaseId/override-audit — v0.8.2 Task 2.2.
  //
  // Operator-accepted phase audit override. Replaces the dogfood-era
  // `psql UPDATE phases SET status='completed'` shortcut with a real
  // API call that requires a non-empty reason and stamps the override
  // trail on the latest `phase_audit_reports` row (override_reason,
  // overridden_by, overridden_at columns added in migration 0016).
  //
  // State-machine guard: only `blocked` phases can be overridden. The
  // override marks the phase `completed` so downstream PhaseIntegration
  // / FinalRelease workflows can resume.
  app.post("/:phaseId/override-audit", async (c) => {
    const phaseId = c.req.param("phaseId");
    if (!isUuid(phaseId)) {
      return c.json({ error: "phaseId must be a UUID" }, 400);
    }

    const body = (await c.req
      .json()
      .catch(() => null)) as { reason?: unknown; overriddenBy?: unknown } | null;
    const reason =
      body &&
      typeof body.reason === "string" &&
      body.reason.trim().length > 0
        ? body.reason
        : null;
    if (reason === null) {
      return c.json({ error: "reason is required" }, 400);
    }
    const overriddenBy =
      body &&
      typeof body.overriddenBy === "string" &&
      body.overriddenBy.trim().length > 0
        ? body.overriddenBy
        : null;

    const [phaseRow] = await deps.db
      .select({ id: phases.id, status: phases.status })
      .from(phases)
      .where(eq(phases.id, phaseId))
      .limit(1);
    if (!phaseRow) {
      return c.json({ error: `phase ${phaseId} not found` }, 404);
    }
    if (phaseRow.status !== "blocked") {
      return c.json(
        {
          error: `phase ${phaseId} is in status='${phaseRow.status}'; override-audit only applies to status='blocked'`,
        },
        409,
      );
    }

    // v0.8.2.1 P1.6: phases get blocked for many reasons (partition
    // violation, approval timeout, merge failure, test failure, audit
    // failure). /override-audit specifically means "operator accepts a
    // blocked AUDIT outcome", not "operator force-completes any blocked
    // phase". Require an audit report row whose outcome is `blocked`
    // or `changes_requested` before accepting; refuse otherwise so the
    // override trail stays meaningful and operators are pointed at the
    // real blocker (re-drive via /integrate after fixing the cause).
    const [latestAudit] = await deps.db
      .select({
        id: phaseAuditReports.id,
        outcome: phaseAuditReports.outcome,
      })
      .from(phaseAuditReports)
      .where(eq(phaseAuditReports.phaseId, phaseId))
      .orderBy(desc(phaseAuditReports.createdAt))
      .limit(1);

    if (!latestAudit) {
      return c.json(
        {
          error:
            `phase ${phaseId} is blocked but has no phase_audit_reports ` +
            `row; /override-audit only applies to phases blocked by the ` +
            `audit step. Investigate the actual blocker (partition ` +
            `failure / approval timeout / merge failure / test failure) ` +
            `via GET /phases/${phaseId} and re-drive via /integrate.`,
        },
        409,
      );
    }
    if (latestAudit.outcome !== "blocked" && latestAudit.outcome !== "changes_requested") {
      return c.json(
        {
          error:
            `phase ${phaseId} latest audit outcome is '${latestAudit.outcome}'; ` +
            `override-audit only applies when the audit blocked or requested ` +
            `changes. Nothing to override here.`,
        },
        409,
      );
    }

    const overriddenAt = new Date().toISOString();
    await deps.db
      .update(phaseAuditReports)
      .set({
        overrideReason: reason,
        overriddenBy,
        overriddenAt,
      })
      .where(eq(phaseAuditReports.id, latestAudit.id));

    await deps.db
      .update(phases)
      .set({ status: "completed", completedAt: overriddenAt })
      .where(eq(phases.id, phaseId));

    return c.json(
      {
        phaseId,
        previousStatus: phaseRow.status,
        newStatus: "completed",
        auditReportId: latestAudit.id,
        reason,
        ...(overriddenBy ? { overriddenBy } : {}),
        overriddenAt,
      },
      200,
    );
  });

  return app;
}

/**
 * Standalone route group for single-row lookups so they don't nest under
 * `/phases` (which would be surprising for callers). `createApp` mounts
 * this separately at `/merge-runs` and `/phase-audit-reports`.
 */
export function createMergeRunsRoute(deps: { db: PmGoDb }) {
  const app = new Hono();
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const [row] = await deps.db
      .select()
      .from(mergeRuns)
      .where(eq(mergeRuns.id, id))
      .limit(1);
    if (!row) return c.json({ error: `merge_run ${id} not found` }, 404);
    return c.json(
      {
        id: row.id,
        planId: row.planId,
        phaseId: row.phaseId,
        integrationBranch: row.integrationBranch,
        baseSha: row.baseSha,
        mergedTaskIds: row.mergedTaskIds,
        failedTaskId: row.failedTaskId,
        integrationHeadSha: row.integrationHeadSha,
        postMergeSnapshotId: row.postMergeSnapshotId,
        integrationLeaseId: row.integrationLeaseId,
        startedAt: toIso(row.startedAt),
        completedAt: row.completedAt ? toIso(row.completedAt) : null,
      },
      200,
    );
  });
  return app;
}

export function createPhaseAuditReportsRoute(deps: { db: PmGoDb }) {
  const app = new Hono();
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const [row] = await deps.db
      .select()
      .from(phaseAuditReports)
      .where(eq(phaseAuditReports.id, id))
      .limit(1);
    if (!row) {
      return c.json({ error: `phase_audit_report ${id} not found` }, 404);
    }
    return c.json(
      {
        id: row.id,
        phaseId: row.phaseId,
        planId: row.planId,
        mergeRunId: row.mergeRunId,
        auditorRunId: row.auditorRunId,
        mergedHeadSha: row.mergedHeadSha,
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

// `and` is imported for potential extension; reference it so strict-mode
// typecheck doesn't flag it as unused.
void and;
