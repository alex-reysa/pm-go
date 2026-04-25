import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";
import { WorkflowNotFoundError } from "@temporalio/client";

import type {
  AgentRun,
  AgentPermissionMode,
  AgentRole,
  AgentRunStatus,
  AgentStopReason,
  PolicyDecision,
  ReviewReport,
  Task,
  TaskExecutionWorkflowInput,
  TaskFixWorkflowInput,
  TaskReviewWorkflowInput,
  UUID,
  WorktreeLease,
  WorktreeLeaseStatus,
} from "@pm-go/contracts";
import { approveSignal } from "@pm-go/contracts";
import {
  agentRuns,
  phases,
  planTasks,
  policyDecisions,
  reviewReports,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import { and } from "drizzle-orm";

import { approveSubject } from "./approvals.js";
import { toIso } from "../lib/timestamps.js";

/**
 * Dependencies for the /tasks route group. `repoRoot`,
 * `worktreeRoot`, and `maxLifetimeHours` are forwarded to
 * `TaskExecutionWorkflow` so the worker's workflow sandbox does not
 * need to read env vars directly.
 */
export interface TasksRouteDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createTasksRoute(deps: TasksRouteDeps) {
  const app = new Hono();

  // GET /tasks?phaseId=<uuid> OR GET /tasks?planId=<uuid> — list
  // tasks under either scope. One scope required; 400 when neither
  // is a UUID. Narrow projection for dashboard rendering; callers
  // that need the full `Task` use `GET /tasks/:id`.
  app.get("/", async (c) => {
    const phaseId = c.req.query("phaseId");
    const planId = c.req.query("planId");
    const byPhase = phaseId !== undefined;
    const byPlan = planId !== undefined;
    if (byPhase === byPlan) {
      return c.json(
        {
          error:
            "exactly one of phaseId or planId must be provided as a query param",
        },
        400,
      );
    }
    if (byPhase && !isUuid(phaseId)) {
      return c.json({ error: "phaseId must be a UUID" }, 400);
    }
    if (byPlan && !isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }

    const rows = await deps.db
      .select({
        id: planTasks.id,
        planId: planTasks.planId,
        phaseId: planTasks.phaseId,
        slug: planTasks.slug,
        title: planTasks.title,
        status: planTasks.status,
        riskLevel: planTasks.riskLevel,
        kind: planTasks.kind,
      })
      .from(planTasks)
      .where(
        byPhase
          ? eq(planTasks.phaseId, phaseId as string)
          : eq(planTasks.planId, planId as string),
      );

    return c.json(
      {
        ...(byPhase ? { phaseId } : { planId }),
        tasks: rows,
      },
      200,
    );
  });

  // POST /tasks/:taskId/run — start TaskExecutionWorkflow.
  //
  // Phase gate: the task's owning phase must be `executing`. Tasks in
  // a `pending` phase haven't been unlocked yet (their baseSnapshot is
  // still inherited from the planner, not stamped from the prior
  // phase's audited post-merge state). Tasks in `integrating`,
  // `auditing`, `completed`, `blocked`, or `failed` phases must not be
  // re-run — the phase has already moved past the execution stage.
  app.post("/:taskId/run", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
    }

    const [gateRow] = await deps.db
      .select({
        phaseId: planTasks.phaseId,
        phaseStatus: phases.status,
        phaseTitle: phases.title,
      })
      .from(planTasks)
      .innerJoin(phases, eq(phases.id, planTasks.phaseId))
      .where(eq(planTasks.id, taskId))
      .limit(1);
    if (!gateRow) {
      return c.json({ error: `task ${taskId} not found` }, 404);
    }
    if (gateRow.phaseStatus !== "executing") {
      return c.json(
        {
          error: `task ${taskId} cannot run — owning phase ${gateRow.phaseId} (${gateRow.phaseTitle}) is status='${gateRow.phaseStatus}'; /tasks/:id/run requires phase.status='executing'`,
          phaseId: gateRow.phaseId,
          phaseStatus: gateRow.phaseStatus,
        },
        409,
      );
    }

    // Accept an empty body (default `requestedBy=api`) or a JSON body
    // carrying an explicit `requestedBy`.
    const body = (await c.req.json().catch(() => null)) as {
      requestedBy?: unknown;
    } | null;
    const requestedBy =
      body &&
      typeof body.requestedBy === "string" &&
      body.requestedBy.trim().length > 0
        ? body.requestedBy
        : "api";

    const input: TaskExecutionWorkflowInput = {
      taskId,
      repoRoot: deps.repoRoot,
      worktreeRoot: deps.worktreeRoot,
      maxLifetimeHours: deps.maxLifetimeHours,
      requestedBy,
    };

    const handle = await deps.temporal.workflow.start(
      "TaskExecutionWorkflow",
      {
        args: [input],
        taskQueue: deps.taskQueue,
        workflowId: `task-exec-${taskId}`,
      },
    );

    return c.json(
      {
        taskId,
        workflowRunId: handle.firstExecutionRunId,
      },
      202,
    );
  });

  // GET /tasks/:taskId — task row + latest agent_run + latest lease
  app.get("/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
    }

    const taskRows = await deps.db
      .select()
      .from(planTasks)
      .where(eq(planTasks.id, taskId))
      .limit(1);
    const taskRow = taskRows[0];
    if (!taskRow) {
      return c.json({ error: `task ${taskId} not found` }, 404);
    }

    const task: Task = {
      id: taskRow.id,
      planId: taskRow.planId,
      phaseId: taskRow.phaseId,
      slug: taskRow.slug,
      title: taskRow.title,
      summary: taskRow.summary,
      kind: taskRow.kind,
      status: taskRow.status,
      riskLevel: taskRow.riskLevel,
      ...(taskRow.sizeHint !== null ? { sizeHint: taskRow.sizeHint } : {}),
      fileScope: taskRow.fileScope,
      acceptanceCriteria: taskRow.acceptanceCriteria,
      testCommands: taskRow.testCommands,
      budget: taskRow.budget,
      reviewerPolicy: taskRow.reviewerPolicy,
      requiresHumanApproval: taskRow.requiresHumanApproval,
      maxReviewFixCycles: taskRow.maxReviewFixCycles,
      ...(taskRow.branchName !== null
        ? { branchName: taskRow.branchName }
        : {}),
      ...(taskRow.worktreePath !== null
        ? { worktreePath: taskRow.worktreePath }
        : {}),
    };

    // Latest agent_run for this task, ordered by startedAt (falling
    // back to completedAt). NULLs sort last under drizzle's default
    // ordering, so this returns the most recent non-null row first.
    const agentRunRows = await deps.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    const agentRunRow = agentRunRows[0];

    // Latest lease — ordered by createdAt, most recent first. This
    // returns the currently-active lease (or, if released, the most
    // recent historical one).
    const leaseRows = await deps.db
      .select()
      .from(worktreeLeases)
      .where(eq(worktreeLeases.taskId, taskId))
      .orderBy(desc(worktreeLeases.createdAt))
      .limit(1);
    const leaseRow = leaseRows[0];

    const latestAgentRun: AgentRun | null = agentRunRow
      ? {
          id: agentRunRow.id,
          ...(agentRunRow.taskId !== null
            ? { taskId: agentRunRow.taskId }
            : {}),
          workflowRunId: agentRunRow.workflowRunId,
          role: agentRunRow.role as AgentRole,
          // depth is constrained to 0|1|2 at the DB layer (check
          // constraint). Narrow the widened number down to the
          // contract union so consumers get a typed field.
          depth: agentRunRow.depth as 0 | 1 | 2,
          status: agentRunRow.status as AgentRunStatus,
          riskLevel: agentRunRow.riskLevel,
          executor: "claude",
          model: agentRunRow.model,
          promptVersion: agentRunRow.promptVersion,
          ...(agentRunRow.sessionId !== null
            ? { sessionId: agentRunRow.sessionId }
            : {}),
          ...(agentRunRow.parentSessionId !== null
            ? { parentSessionId: agentRunRow.parentSessionId }
            : {}),
          permissionMode: agentRunRow.permissionMode as AgentPermissionMode,
          ...(agentRunRow.budgetUsdCap !== null
            ? { budgetUsdCap: Number(agentRunRow.budgetUsdCap) }
            : {}),
          ...(agentRunRow.maxTurnsCap !== null
            ? { maxTurnsCap: agentRunRow.maxTurnsCap }
            : {}),
          ...(agentRunRow.turns !== null ? { turns: agentRunRow.turns } : {}),
          ...(agentRunRow.inputTokens !== null
            ? { inputTokens: agentRunRow.inputTokens }
            : {}),
          ...(agentRunRow.outputTokens !== null
            ? { outputTokens: agentRunRow.outputTokens }
            : {}),
          ...(agentRunRow.cacheCreationTokens !== null
            ? { cacheCreationTokens: agentRunRow.cacheCreationTokens }
            : {}),
          ...(agentRunRow.cacheReadTokens !== null
            ? { cacheReadTokens: agentRunRow.cacheReadTokens }
            : {}),
          ...(agentRunRow.costUsd !== null
            ? { costUsd: Number(agentRunRow.costUsd) }
            : {}),
          ...(agentRunRow.stopReason !== null
            ? { stopReason: agentRunRow.stopReason as AgentStopReason }
            : {}),
          ...(agentRunRow.outputFormatSchemaRef !== null
            ? { outputFormatSchemaRef: agentRunRow.outputFormatSchemaRef }
            : {}),
          ...(agentRunRow.startedAt !== null
            ? { startedAt: toIso(agentRunRow.startedAt) }
            : {}),
          ...(agentRunRow.completedAt !== null
            ? { completedAt: toIso(agentRunRow.completedAt) }
            : {}),
        }
      : null;

    const latestLease: WorktreeLease | null = leaseRow
      ? {
          id: leaseRow.id,
          ...(leaseRow.taskId !== null ? { taskId: leaseRow.taskId } : {}),
          ...(leaseRow.phaseId !== null ? { phaseId: leaseRow.phaseId } : {}),
          kind: leaseRow.kind,
          repoRoot: leaseRow.repoRoot,
          branchName: leaseRow.branchName,
          worktreePath: leaseRow.worktreePath,
          baseSha: leaseRow.baseSha,
          expiresAt: toIso(leaseRow.expiresAt),
          status: leaseRow.status as WorktreeLeaseStatus,
        }
      : null;

    // Surface the latest review report inline so a single GET /tasks/:id
    // round-trip gives the UI / smoke tests everything they need to
    // render the task's review state (Phase 4 addition — the history
    // list lives under GET /tasks/:id/review-reports).
    const reportRows = await deps.db
      .select()
      .from(reviewReports)
      .where(eq(reviewReports.taskId, taskId))
      .orderBy(desc(reviewReports.createdAt))
      .limit(1);
    const latestReviewReportRow = reportRows[0];
    const latestReviewReport: ReviewReport | null = latestReviewReportRow
      ? {
          id: latestReviewReportRow.id,
          taskId: latestReviewReportRow.taskId,
          reviewerRunId: latestReviewReportRow.reviewerRunId,
          outcome: latestReviewReportRow.outcome,
          findings: latestReviewReportRow.findings,
          createdAt: toIso(latestReviewReportRow.createdAt),
        }
      : null;

    // v0.8.2: surface task-scoped policy decisions so the UI can render
    // "Review skipped (policy)" for the small-task fast path. Filter to
    // approved/rejected/etc rows whose subjectType='task' and subjectId
    // is this task. Most common entry is reason='review_skipped_small_task:...'.
    const taskPolicyDecisionRows = await deps.db
      .select()
      .from(policyDecisions)
      .where(
        and(
          eq(policyDecisions.subjectType, "task"),
          eq(policyDecisions.subjectId, taskId),
        ),
      )
      .orderBy(desc(policyDecisions.createdAt));
    const taskPolicyDecisionsOut: PolicyDecision[] =
      taskPolicyDecisionRows.map((r) => ({
        id: r.id,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        riskLevel: r.riskLevel,
        decision: r.decision,
        reason: r.reason,
        actor: r.actor,
        createdAt: toIso(r.createdAt),
      }));
    const reviewSkippedDecision: PolicyDecision | undefined =
      taskPolicyDecisionsOut.find(
        (d) =>
          d.decision === "approved" &&
          d.reason.startsWith("review_skipped_small_task:"),
      );

    return c.json(
      {
        task,
        latestAgentRun,
        latestLease,
        latestReviewReport,
        taskPolicyDecisions: taskPolicyDecisionsOut,
        ...(reviewSkippedDecision !== undefined
          ? { reviewSkippedDecision }
          : {}),
      },
      200,
    );
  });

  // POST /tasks/:taskId/review — start TaskReviewWorkflow.
  app.post("/:taskId/review", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
    }

    // Workflow id includes a cycle counter so repeat reviews of the same
    // task start fresh workflow instances rather than hit the uniqueness
    // collision on `task-review-<id>`. The counter is derived from the
    // review_reports row count so it is monotonic across retries.
    const existingReports = await deps.db
      .select({ id: reviewReports.id })
      .from(reviewReports)
      .where(eq(reviewReports.taskId, taskId));
    const nextCycle = existingReports.length + 1;

    const input: TaskReviewWorkflowInput = { taskId };
    const handle = await deps.temporal.workflow.start("TaskReviewWorkflow", {
      args: [input],
      taskQueue: deps.taskQueue,
      workflowId: `task-review-${taskId}-${nextCycle}`,
    });

    return c.json(
      { taskId, workflowRunId: handle.firstExecutionRunId, cycleNumber: nextCycle },
      202,
    );
  });

  // POST /tasks/:taskId/fix — start TaskFixWorkflow against the latest
  // review report, BUT only if the task state machine currently says a
  // fix is allowed. Specifically:
  //   1. The task row must be `status='fixing'` — that's the only state
  //      the reviewer's policy evaluator leaves behind when it actually
  //      authorizes a retry. Any other state (ready_to_merge, blocked,
  //      in_review, running, failed, …) means either the loop already
  //      moved on or a fix would violate the state machine.
  //   2. The latest *overall* review report must itself be
  //      `outcome='changes_requested'`. Selecting "latest
  //      changes_requested" without the overall-latest check would let a
  //      caller reopen a stale cycle-1 report even after cycle 2 had
  //      passed/blocked, bypassing the cycle cap TaskFixWorkflow assumes
  //      the API guards.
  // Both failures surface as 409 Conflict so clients can distinguish
  // "no review yet" (run /review first) from "not in a fixable state"
  // (state-machine conflict).
  app.post("/:taskId/fix", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
    }

    const taskRows = await deps.db
      .select({ status: planTasks.status })
      .from(planTasks)
      .where(eq(planTasks.id, taskId))
      .limit(1);
    const taskRow = taskRows[0];
    if (!taskRow) {
      return c.json({ error: `task ${taskId} not found` }, 404);
    }
    if (taskRow.status !== "fixing") {
      return c.json(
        {
          error: `task ${taskId} is in status='${taskRow.status}'; POST /fix is only permitted when status='fixing'`,
        },
        409,
      );
    }

    const latestRows = await deps.db
      .select()
      .from(reviewReports)
      .where(eq(reviewReports.taskId, taskId))
      .orderBy(desc(reviewReports.createdAt))
      .limit(1);
    const reportRow = latestRows[0];
    if (!reportRow) {
      return c.json(
        {
          error: `no review report for task ${taskId}; run POST /tasks/${taskId}/review first`,
        },
        409,
      );
    }
    if (reportRow.outcome !== "changes_requested") {
      return c.json(
        {
          error: `latest review report for task ${taskId} has outcome='${reportRow.outcome}'; fixes are only allowed against a changes_requested report`,
        },
        409,
      );
    }

    const input: TaskFixWorkflowInput = {
      taskId,
      reviewReportId: reportRow.id,
    };
    const handle = await deps.temporal.workflow.start("TaskFixWorkflow", {
      args: [input],
      taskQueue: deps.taskQueue,
      workflowId: `task-fix-${taskId}-${reportRow.cycleNumber}`,
    });
    return c.json(
      {
        taskId,
        workflowRunId: handle.firstExecutionRunId,
        reviewReportId: reportRow.id,
        cycleNumber: reportRow.cycleNumber,
      },
      202,
    );
  });

  // POST /tasks/:taskId/approve — Phase 7. Flips the latest pending
  // approval_requests row for this task to `approved`, so the matching
  // PhaseIntegrationWorkflow's poll loop unblocks on its next tick.
  // 404 when no row exists for the task; 409 when none are pending
  // (already approved/rejected — operator should investigate the
  // existing decided row before re-driving).
  app.post("/:taskId/approve", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
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
      { kind: "task", taskId },
      approvedBy,
    );
    if (!updated) {
      return c.json(
        {
          error: `no pending approval_requests row for task ${taskId}`,
        },
        409,
      );
    }

    // Signal PhaseIntegrationWorkflow so it resumes within 2 s instead
    // of waiting for its next poll tick. Per spec risk-mitigation: a
    // signal failure surfaces as 5xx so the caller can retry — we do
    // NOT swallow the error.
    const [taskPhaseRow] = await deps.db
      .select({ phaseId: planTasks.phaseId })
      .from(planTasks)
      .where(eq(planTasks.id, taskId))
      .limit(1);

    if (taskPhaseRow) {
      const workflowId = `phase-integration-${taskPhaseRow.phaseId}`;
      try {
        await deps.temporal.workflow.getHandle(workflowId).signal(approveSignal);
      } catch (err) {
        // WorkflowNotFoundError covers "never started" + "already finished":
        // either way the row flip is the source of truth and the next
        // PhaseIntegrationWorkflow run will pick up the approved row from
        // the durable ledger. Other signal failures still surface as 5xx
        // so a transient gRPC blip is retryable.
        if (err instanceof WorkflowNotFoundError) {
          console.warn(
            `[approve] no live ${workflowId} to signal; row flip stands`,
          );
        } else {
          console.error(`[approve] failed to signal workflow ${workflowId}:`, err);
          throw err;
        }
      }
    }

    return c.json({ taskId, approval: updated }, 200);
  });

  // GET /tasks/:taskId/review-reports — chronological list of reports.
  app.get("/:taskId/review-reports", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
    }
    const rows = await deps.db
      .select()
      .from(reviewReports)
      .where(eq(reviewReports.taskId, taskId))
      .orderBy(asc(reviewReports.createdAt));
    const reports = rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      reviewerRunId: row.reviewerRunId,
      outcome: row.outcome,
      findings: row.findings,
      cycleNumber: row.cycleNumber,
      createdAt: toIso(row.createdAt),
    }));
    return c.json({ taskId, reports }, 200);
  });

  // POST /tasks/:taskId/override-review — v0.8.2 Task 2.2.
  //
  // Operator-accepted review override. Replaces the dogfood-era
  // `psql UPDATE ... SET status='ready_to_merge'` shortcut with a real
  // API call that requires a non-empty reason and persists a human
  // policy_decisions row for the audit trail (subjectType='task',
  // decision='approved', actor='human').
  //
  // State-machine guard: only `blocked` or `fixing` tasks can be
  // overridden. Any other status (running, ready_to_merge, merged,
  // pending, ...) returns 409 — those are not "review false-positive"
  // shapes that an operator should bypass with this endpoint.
  app.post("/:taskId/override-review", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
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
        : undefined;

    const [taskRow] = await deps.db
      .select({ id: planTasks.id, status: planTasks.status, riskLevel: planTasks.riskLevel })
      .from(planTasks)
      .where(eq(planTasks.id, taskId))
      .limit(1);
    if (!taskRow) {
      return c.json({ error: `task ${taskId} not found` }, 404);
    }
    if (taskRow.status !== "blocked" && taskRow.status !== "fixing") {
      return c.json(
        {
          error: `task ${taskId} is in status='${taskRow.status}'; override-review only applies to status='blocked' or 'fixing'`,
        },
        409,
      );
    }

    const decisionId = randomUUID();
    const decidedAt = new Date().toISOString();
    const reasonText = overriddenBy
      ? `review_overridden:by=${overriddenBy};${reason}`
      : `review_overridden:${reason}`;
    await deps.db.insert(policyDecisions).values({
      id: decisionId,
      subjectType: "task",
      subjectId: taskId,
      riskLevel: taskRow.riskLevel,
      decision: "approved",
      reason: reasonText,
      actor: "human",
      createdAt: decidedAt,
    });

    await deps.db
      .update(planTasks)
      .set({ status: "ready_to_merge" })
      .where(eq(planTasks.id, taskId));

    return c.json(
      {
        taskId,
        previousStatus: taskRow.status,
        newStatus: "ready_to_merge",
        policyDecisionId: decisionId,
        ...(overriddenBy ? { overriddenBy } : {}),
        reason,
      },
      200,
    );
  });

  return app;
}
