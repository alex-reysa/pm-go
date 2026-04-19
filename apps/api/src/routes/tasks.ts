import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";

import type {
  AgentRun,
  AgentPermissionMode,
  AgentRole,
  AgentRunStatus,
  AgentStopReason,
  ReviewReport,
  Task,
  TaskExecutionWorkflowInput,
  TaskFixWorkflowInput,
  TaskReviewWorkflowInput,
  UUID,
  WorktreeLease,
  WorktreeLeaseStatus,
} from "@pm-go/contracts";
import {
  agentRuns,
  planTasks,
  reviewReports,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createTasksRoute(deps: TasksRouteDeps) {
  const app = new Hono();

  // POST /tasks/:taskId/run — start TaskExecutionWorkflow
  app.post("/:taskId/run", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) {
      return c.json({ error: "taskId must be a UUID" }, 400);
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

    return c.json(
      {
        task,
        latestAgentRun,
        latestLease,
        latestReviewReport,
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

  return app;
}
