import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type {
  AgentRun,
  AgentPermissionMode,
  AgentRole,
  AgentRunStatus,
  AgentStopReason,
  ApprovalDecision,
  ApprovalRequest,
  BudgetDecision,
  BudgetReport,
  BudgetTaskBreakdown,
  Plan,
  Risk,
  RiskLevel,
  StopDecision,
  Task,
  UUID,
} from "@pm-go/contracts";
import { DEFAULT_OPERATING_LIMITS } from "@pm-go/contracts";
import {
  agentRuns,
  approvalRequests,
  budgetReports,
  phases,
  planTasks,
  plans,
  reviewReports,
  taskDependencies,
  type PmGoDb,
} from "@pm-go/db";
import { createSpanWriter, withSpan } from "@pm-go/observability";
import {
  evaluateApprovalGate,
  evaluateBudgetGate,
  evaluateStopCondition,
} from "@pm-go/policy-engine";

/**
 * Phase 7 (Worker 4) — policy-gate activities.
 *
 * Every method here:
 *   1. Loads the durable inputs the pure evaluator needs.
 *   2. Calls the pure-function evaluator from `@pm-go/policy-engine`.
 *   3. Optionally persists the side-effect row (`approval_requests`,
 *      `budget_reports`).
 *   4. Wraps the entire body in `withSpan` so every gate evaluation is
 *      a correlated row on `workflow_events`. Best-effort sink — a
 *      failed span insert never rolls back a successful gate decision.
 *
 * Workflow callers proxy these and act on the returned decision:
 *   - `evaluateBudgetGateActivity` → on `ok: false`, the workflow
 *     transitions the task to `blocked` and persists a
 *     `policy_decisions` row via the existing `persistPolicyDecision`
 *     activity (shared with the review path).
 *   - `evaluateApprovalGateActivity` → on `required: true`, the
 *     workflow blocks via `condition()` polling on the returned
 *     `approvalRequestId`.
 *   - `evaluateStopConditionActivity` → on `stop: true`, the workflow
 *     persists a `policy_decisions` row and bails.
 */

export interface PolicyActivityDeps {
  db: PmGoDb;
}

export function createPolicyActivities(deps: PolicyActivityDeps) {
  const { db } = deps;

  return {
    async evaluateBudgetGateActivity(input: {
      taskId: UUID;
    }): Promise<BudgetDecision> {
      const task = await loadTaskOrThrow(db, input.taskId);
      const sink = createSpanWriter({ db, planId: task.planId }).writeSpan;

      return withSpan(
        "worker.activities.policy.evaluateBudgetGateActivity",
        { planId: task.planId, taskId: input.taskId },
        async () => {
          const runs = await loadAgentRunsForTask(db, input.taskId);
          return evaluateBudgetGate(task, runs);
        },
        { sink },
      );
    },

    async evaluateApprovalGateActivity(input: {
      taskId: UUID;
    }): Promise<{
      decision: ApprovalDecision;
      approvalRequestId?: UUID;
    }> {
      const task = await loadTaskOrThrow(db, input.taskId);
      const sink = createSpanWriter({ db, planId: task.planId }).writeSpan;

      return withSpan(
        "worker.activities.policy.evaluateApprovalGateActivity",
        { planId: task.planId, taskId: input.taskId },
        async () => {
          // Pick the matching plan-level Risk (highest level wins) so the
          // pure evaluator sees the strongest signal.
          const plan = await loadPlanShallow(db, task.planId);
          const risk = pickRiskForTask(plan?.risks ?? [], task.riskLevel);

          // Pure decision.
          const decision = evaluateApprovalGate(risk ?? task.riskLevel, task);
          if (!decision.required) return { decision };

          // Idempotent: reuse an existing pending OR approved row if one
          // exists. Before this fix, only `pending` was checked, so a
          // previously-approved request for the same (plan, task) pair
          // would not satisfy later retries — each retry created a fresh
          // pending row that required re-approval and re-drained the
          // workflow's polling timer budget. Prefer `approved` (the gate
          // passes instantly via isApproved()) over `pending` (still
          // waiting on a human signal), which in turn beats creating a
          // new row.
          const existing = await db
            .select({ id: approvalRequests.id, status: approvalRequests.status })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.planId, task.planId),
                eq(approvalRequests.taskId, task.id),
                inArray(approvalRequests.status, ["approved", "pending"]),
              ),
            );
          const approved = existing.find((r) => r.status === "approved");
          const pending = existing.find((r) => r.status === "pending");
          if (approved) {
            return { decision, approvalRequestId: approved.id };
          }
          if (pending) {
            return { decision, approvalRequestId: pending.id };
          }

          const id = randomUUID();
          const requestedAt = new Date().toISOString();
          await db.insert(approvalRequests).values({
            id,
            planId: task.planId,
            taskId: task.id,
            subject: "task",
            riskBand: decision.band,
            status: "pending",
            requestedBy: "policy-engine",
            requestedAt,
          });
          return { decision, approvalRequestId: id };
        },
        { sink },
      );
    },

    async evaluateStopConditionActivity(input: {
      planId: UUID;
      taskId?: UUID;
    }): Promise<StopDecision> {
      const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;

      return withSpan(
        "worker.activities.policy.evaluateStopConditionActivity",
        {
          planId: input.planId,
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        },
        async () => {
          const plan = await loadPlanWithPhases(db, input.planId);
          if (!plan) {
            return { stop: false } as const;
          }

          // Cycle count + open findings are scoped to the task being
          // considered. Without a task scope the helpers default to 0/[]
          // (the plan-level rerun check still runs).
          let cycles = 0;
          const findings: Array<
            (typeof reviewReports.$inferSelect)["findings"][number]
          > = [];
          if (input.taskId) {
            const reportRows = await db
              .select()
              .from(reviewReports)
              .where(eq(reviewReports.taskId, input.taskId));
            for (const row of reportRows) {
              cycles = Math.max(cycles, row.cycleNumber);
              for (const f of row.findings) findings.push(f);
            }
          }

          return evaluateStopCondition(
            plan,
            cycles,
            findings,
            DEFAULT_OPERATING_LIMITS,
          );
        },
        { sink },
      );
    },

    async persistApprovalRequest(request: ApprovalRequest): Promise<UUID> {
      const sink = createSpanWriter({ db, planId: request.planId }).writeSpan;
      return withSpan(
        "worker.activities.policy.persistApprovalRequest",
        {
          planId: request.planId,
          ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
          subject: request.subject,
        },
        async () => {
          await db
            .insert(approvalRequests)
            .values({
              id: request.id,
              planId: request.planId,
              ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
              subject: request.subject,
              riskBand: request.riskBand,
              status: request.status,
              ...(request.requestedBy !== undefined
                ? { requestedBy: request.requestedBy }
                : {}),
              ...(request.approvedBy !== undefined
                ? { approvedBy: request.approvedBy }
                : {}),
              requestedAt: request.requestedAt,
              ...(request.decidedAt !== undefined
                ? { decidedAt: request.decidedAt }
                : {}),
              ...(request.reason !== undefined
                ? { reason: request.reason }
                : {}),
            })
            .onConflictDoNothing();
          return request.id;
        },
        { sink },
      );
    },

    async persistBudgetReport(input: { planId: UUID }): Promise<BudgetReport> {
      const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;
      return withSpan(
        "worker.activities.policy.persistBudgetReport",
        { planId: input.planId },
        async () => {
          const report = await aggregateBudget(db, input.planId);
          await db.insert(budgetReports).values({
            id: report.id,
            planId: report.planId,
            totalUsd: report.totalUsd.toString(),
            totalTokens: report.totalTokens,
            totalWallClockMinutes: report.totalWallClockMinutes.toString(),
            perTaskBreakdown: report.perTaskBreakdown,
            generatedAt: report.generatedAt,
          });
          return report;
        },
        { sink },
      );
    },

    async isApproved(input: { approvalRequestId: UUID }): Promise<{
      approved: boolean;
      rejected: boolean;
    }> {
      const [row] = await db
        .select({
          status: approvalRequests.status,
          planId: approvalRequests.planId,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, input.approvalRequestId))
        .limit(1);
      if (!row) return { approved: false, rejected: false };
      // Span only fires once per poll — keep it light. The plan-scoped
      // sink makes the span row carry the same correlation as the
      // gate-evaluation row that opened the request.
      const sink = createSpanWriter({ db, planId: row.planId }).writeSpan;
      return withSpan(
        "worker.activities.policy.isApproved",
        { planId: row.planId, approvalRequestId: input.approvalRequestId },
        async () => ({
          approved: row.status === "approved",
          rejected: row.status === "rejected",
        }),
        { sink },
      );
    },
  };
}

/**
 * Build a `BudgetReport` for a plan by aggregating every `agent_runs`
 * row whose task lives on this plan. Pure read — no DB mutation.
 *
 * Joins: `agent_runs` → `plan_tasks` (via `task_id`) →
 * `phases` (via `phase_id`) → `plans` (via `plan_id`). Runs without a
 * task linkage (e.g. plan-level planner runs) are filtered out: the
 * report is task-scoped, by contract.
 */
export async function aggregateBudget(
  db: PmGoDb,
  planId: UUID,
): Promise<BudgetReport> {
  const rows = await db
    .select({
      taskId: agentRuns.taskId,
      costUsd: agentRuns.costUsd,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      cacheCreationTokens: agentRuns.cacheCreationTokens,
      cacheReadTokens: agentRuns.cacheReadTokens,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
      taskPlanId: planTasks.planId,
    })
    .from(agentRuns)
    .innerJoin(planTasks, eq(planTasks.id, agentRuns.taskId))
    .where(eq(planTasks.planId, planId))
    .orderBy(asc(agentRuns.startedAt));

  const perTaskMap = new Map<UUID, BudgetTaskBreakdown>();
  let totalUsd = 0;
  let totalTokens = 0;
  let totalWallClockMinutes = 0;

  for (const row of rows) {
    if (!row.taskId) continue;
    const usd = row.costUsd === null ? 0 : Number(row.costUsd);
    const tokens =
      (row.inputTokens ?? 0) +
      (row.cacheCreationTokens ?? 0) +
      (row.cacheReadTokens ?? 0) +
      (row.outputTokens ?? 0);
    const minutes = minutesBetween(row.startedAt, row.completedAt);

    totalUsd += usd;
    totalTokens += tokens;
    totalWallClockMinutes += minutes;

    const prior = perTaskMap.get(row.taskId) ?? {
      taskId: row.taskId,
      totalUsd: 0,
      totalTokens: 0,
      totalWallClockMinutes: 0,
    };
    prior.totalUsd += usd;
    prior.totalTokens += tokens;
    prior.totalWallClockMinutes += minutes;
    perTaskMap.set(row.taskId, prior);
  }

  return {
    id: randomUUID(),
    planId,
    totalUsd: round6(totalUsd),
    totalTokens,
    totalWallClockMinutes: round3(totalWallClockMinutes),
    perTaskBreakdown: [...perTaskMap.values()].map((b) => ({
      taskId: b.taskId,
      totalUsd: round6(b.totalUsd),
      totalTokens: b.totalTokens,
      totalWallClockMinutes: round3(b.totalWallClockMinutes),
    })),
    generatedAt: new Date().toISOString(),
  };
}

// ----- helpers -------------------------------------------------------

async function loadTaskOrThrow(db: PmGoDb, taskId: UUID): Promise<Task> {
  const [row] = await db
    .select()
    .from(planTasks)
    .where(eq(planTasks.id, taskId))
    .limit(1);
  if (!row) {
    throw new Error(`policy: task ${taskId} not found`);
  }
  return {
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
  };
}

async function loadAgentRunsForTask(
  db: PmGoDb,
  taskId: UUID,
): Promise<AgentRun[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.taskId, taskId))
    .orderBy(asc(agentRuns.startedAt));
  return rows.map(rowToAgentRun);
}

function rowToAgentRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    workflowRunId: row.workflowRunId,
    role: row.role as AgentRole,
    depth: row.depth as 0 | 1 | 2,
    status: row.status as AgentRunStatus,
    riskLevel: row.riskLevel,
    executor: "claude",
    model: row.model,
    promptVersion: row.promptVersion,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(row.parentSessionId !== null
      ? { parentSessionId: row.parentSessionId }
      : {}),
    permissionMode: row.permissionMode as AgentPermissionMode,
    ...(row.budgetUsdCap !== null
      ? { budgetUsdCap: Number(row.budgetUsdCap) }
      : {}),
    ...(row.maxTurnsCap !== null ? { maxTurnsCap: row.maxTurnsCap } : {}),
    ...(row.turns !== null ? { turns: row.turns } : {}),
    ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
    ...(row.cacheCreationTokens !== null
      ? { cacheCreationTokens: row.cacheCreationTokens }
      : {}),
    ...(row.cacheReadTokens !== null
      ? { cacheReadTokens: row.cacheReadTokens }
      : {}),
    ...(row.costUsd !== null ? { costUsd: Number(row.costUsd) } : {}),
    ...(row.stopReason !== null
      ? { stopReason: row.stopReason as AgentStopReason }
      : {}),
    ...(row.outputFormatSchemaRef !== null
      ? { outputFormatSchemaRef: row.outputFormatSchemaRef }
      : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
  };
}

async function loadPlanShallow(
  db: PmGoDb,
  planId: UUID,
): Promise<{ risks: Risk[] } | null> {
  const [row] = await db
    .select({ risks: plans.risks })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  if (!row) return null;
  return { risks: (row.risks ?? []) as Risk[] };
}

/**
 * Phase-aware Plan loader for `evaluateStopCondition`. The pure helper
 * inspects `plan.phases[*].status` + `phaseAuditReportId`, so we
 * rebuild a minimal-but-complete `Plan` shape (no tasks/edges). Tasks
 * and edges are not used by `countAutomaticPhaseReruns`.
 */
async function loadPlanWithPhases(
  db: PmGoDb,
  planId: UUID,
): Promise<Plan | null> {
  const [planRow] = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  if (!planRow) return null;

  const phaseRows = await db
    .select()
    .from(phases)
    .where(eq(phases.planId, planId))
    .orderBy(asc(phases.index));

  void taskDependencies;

  return {
    id: planRow.id,
    specDocumentId: planRow.specDocumentId,
    repoSnapshotId: planRow.repoSnapshotId,
    title: planRow.title,
    summary: planRow.summary,
    status: planRow.status,
    risks: (planRow.risks ?? []) as Risk[],
    createdAt: planRow.createdAt,
    updatedAt: planRow.updatedAt,
    phases: phaseRows.map((row) => ({
      id: row.id,
      planId: row.planId,
      index: row.index,
      title: row.title,
      summary: row.summary,
      status: row.status,
      integrationBranch: row.integrationBranch,
      baseSnapshotId: row.baseSnapshotId,
      taskIds: row.taskIdsOrdered,
      dependencyEdges: [],
      mergeOrder: row.mergeOrder,
      ...(row.phaseAuditReportId !== null
        ? { phaseAuditReportId: row.phaseAuditReportId }
        : {}),
      ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
      ...(row.completedAt !== null
        ? { completedAt: row.completedAt }
        : {}),
    })),
    tasks: [],
  };
}

function pickRiskForTask(
  risks: readonly Risk[],
  taskRiskLevel: RiskLevel,
): Risk | undefined {
  // Prefer a Risk row whose level matches the task's risk level. Falls
  // back to any high-flagged Risk so the approval gate sees the
  // strongest plan-level escalation.
  const exact = risks.find((r) => r.level === taskRiskLevel);
  if (exact) return exact;
  return risks.find((r) => r.level === "high" && r.humanApprovalRequired);
}

function minutesBetween(
  startedAt: string | null,
  completedAt: string | null,
): number {
  if (!startedAt || !completedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const diffMs = end - start;
  if (diffMs <= 0) return 0;
  return diffMs / 60_000;
}

function round6(n: number): number {
  return +n.toFixed(6);
}

function round3(n: number): number {
  return +n.toFixed(3);
}

// Silence unused imports under strict mode.
void desc;
