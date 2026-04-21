import type { RiskLevel, UUID } from "./plan.js";

/**
 * Risk band used by the approval gate. Derived from a task's `RiskLevel`
 * (see `packages/contracts/src/plan.ts`) per
 * `evaluateApprovalGate(risk, task)` in `@pm-go/policy-engine`:
 *
 *   - `low`    → no approval required
 *   - `medium` → no approval required
 *   - `high`   → `ApprovalDecision.band = "high"`
 *   - (extension) `catastrophic` → `ApprovalDecision.band = "catastrophic"`
 *
 * `RiskLevel` in Phase 5 had no `"catastrophic"` literal. Phase 7
 * introduces a band *label* for durable approval rows without widening
 * `RiskLevel` itself (which would be a breaking change to every
 * existing validator and DB enum). The mapping is one-way: risk level
 * `high` with `humanApprovalRequired` explicitly set for a
 * catastrophic-scoped task escalates to `"catastrophic"` here. For
 * pre-existing callers the band is always `"high"` if approval is
 * required at all.
 */
export type ApprovalRiskBand = "high" | "catastrophic";

export type ApprovalSubject = "plan" | "task";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Durable row backing the `approval_requests` table (migration `0010`).
 *
 * One row per "this plan/task needs a human thumbs-up before execution
 * proceeds". Written when a policy gate decides approval is required;
 * mutated when a human calls `POST /plans/:id/approve` or
 * `POST /tasks/:id/approve`. Consumed by workflow code that blocks on
 * `status = 'approved'` before releasing high-risk work for merge.
 *
 * Shape mirrors the SQL columns in
 * `db/migrations/0010_approval_requests.sql` one-for-one; the contract
 * owns the canonical camelCase form for in-memory code.
 */
export interface ApprovalRequest {
  id: UUID;
  planId: UUID;
  /**
   * Present when `subject === "task"`; absent when `subject === "plan"`.
   * A null column in the DB becomes `undefined` here so callers can use
   * `exactOptionalPropertyTypes` safely.
   */
  taskId?: UUID;
  subject: ApprovalSubject;
  riskBand: ApprovalRiskBand;
  status: ApprovalStatus;
  requestedBy?: string;
  approvedBy?: string;
  requestedAt: string;
  decidedAt?: string;
  reason?: string;
}

/**
 * Result of `evaluateApprovalGate(risk, task)` — a pure decision, not a
 * persisted row. Callers use this to decide whether to write an
 * `ApprovalRequest` and short-circuit downstream work.
 */
export type ApprovalDecision =
  | { required: false }
  | { required: true; band: ApprovalRiskBand };

/**
 * Per-task budget overrun detail returned by
 * `evaluateBudgetGate(task, runs)`. At least one key is present when
 * this object is emitted. Keys are omitted (not zero) when the
 * corresponding dimension did not overflow.
 *
 * Units:
 *   - `usd`             — positive overrun above `Task.budget.maxModelCostUsd`, in USD
 *   - `tokens`          — positive overrun above `Task.budget.maxPromptTokens`, in tokens
 *   - `wallClockMinutes`— positive overrun above `Task.budget.maxWallClockMinutes`, in minutes
 */
export interface BudgetOverrun {
  usd?: number;
  tokens?: number;
  wallClockMinutes?: number;
}

/**
 * Result of `evaluateBudgetGate(task, runs)`.
 *
 * `ok: true` means the task may continue spending budget.
 * `ok: false` means the gate must short-circuit task execution to
 * `blocked`; the caller is expected to durably write a `PolicyDecision`
 * row with `decision = "budget_exceeded"` citing the `reason` here.
 */
export type BudgetDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "budget_exceeded";
      over: BudgetOverrun;
    };

/**
 * Per-task cost/token breakdown line used by the `budget_reports` JSON
 * payload. One entry per task that has accrued any agent-run spend on
 * this plan.
 */
export interface BudgetTaskBreakdown {
  taskId: UUID;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
}

/**
 * Durable row backing the `budget_reports` table (migration `0011`).
 *
 * Snapshots of `plan`-wide spend taken at phase-integration or
 * plan-completion time. Written by the orchestrator, served by
 * `GET /plans/:id/budget-report`.
 */
export interface BudgetReport {
  id: UUID;
  planId: UUID;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
  perTaskBreakdown: BudgetTaskBreakdown[];
  generatedAt: string;
}

/**
 * Per-workflow retry policy consumed by `evaluateRetryDecision`. The
 * policy is expressed in "SDK-neutral" terms (milliseconds, multiplier,
 * max attempts) so that Worker 4 can translate it into Temporal's
 * `RetryPolicy` in `packages/temporal-workflows/src/definitions.ts`
 * without importing anything from `@pm-go/policy-engine` that knows
 * about Temporal.
 *
 * Semantics:
 *   - `attempt` is 1-indexed at the **retry** being considered (i.e.
 *     the first call is attempt 1 with zero prior failures; a retry
 *     decision is requested after attempt 1 has failed).
 *   - delay for the N-th retry =
 *       min(initialDelayMs * backoffMultiplier ^ (attempt - 1), maxDelayMs)
 *   - `maxAttempts` is the inclusive upper bound on total attempts
 *     (including the first), so `maxAttempts = 3` means 1 original + 2
 *     retries.
 *   - `nonRetryableErrorNames` short-circuits to `retry: false` on an
 *     exact-match `Error.name`.
 */
export interface RetryPolicyConfig {
  workflowName: string;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  maxAttempts: number;
  nonRetryableErrorNames?: readonly string[];
}

/**
 * Result of `evaluateRetryDecision(workflowName, attempt, lastError, limits)`.
 *
 * `retry: true`  — caller should schedule another attempt after `delayMs`.
 * `retry: false` — caller should mark the workflow failed and persist
 *                  a `PolicyDecision` row citing `reason`.
 */
export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: string };

/**
 * Reasons `evaluateStopCondition` may return when it decides the plan
 * must stop advancing. Mirrors the canonical short-reason strings
 * persisted on `PolicyDecision.reason` for audit.
 */
export type StopReason =
  | "review_cycles_exceeded"
  | "high_severity_findings"
  | "phase_rerun_exhausted";

/**
 * Result of `evaluateStopCondition(plan, cycles, findings, limits)`.
 */
export type StopDecision =
  | { stop: false }
  | { stop: true; reason: StopReason };

export type PolicyDecisionType =
  | "approved"
  | "rejected"
  | "requires_human"
  | "budget_exceeded"
  | "scope_violation"
  | "retry_allowed"
  | "retry_denied";

export interface OperatingLimits {
  maxDelegationDepth: 2;
  maxConcurrentImplementersPerPhase: 4;
  maxConcurrentReviewersPerPhase: 2;
  maxReviewFixCyclesPerTask: 2;
  maxPlanningRevisions: 1;
  maxAutomaticPhaseReruns: 1;
  maxMergeRetryAttemptsPerTask: 2;
  maxFilesPerTaskSoft: 12;
  maxPackagesPerTaskSoft: 2;
  maxMigrationsPerTaskSoft: 1;
  maxWorktreeLifetimeHours: 24;
  maxBranchFanOutPerPhase: 6;
  maxUnresolvedHighSeverityFindings: 1;
  defaultTaskWallClockMinutes: 45;
}

export interface PolicyDecision {
  id: UUID;
  subjectType: "plan" | "task" | "merge" | "review";
  subjectId: UUID;
  riskLevel: RiskLevel;
  decision: PolicyDecisionType;
  reason: string;
  actor: "system" | "human";
  createdAt: string;
}

export interface TaskRoutingDecision {
  taskId: UUID;
  riskLevel: RiskLevel;
  canRunInParallel: boolean;
  requiresHumanApproval: boolean;
  reviewStrictness: "standard" | "elevated" | "critical";
  mergeMode: "automatic" | "approval_required";
}

export const DEFAULT_OPERATING_LIMITS: OperatingLimits = {
  maxDelegationDepth: 2,
  maxConcurrentImplementersPerPhase: 4,
  maxConcurrentReviewersPerPhase: 2,
  maxReviewFixCyclesPerTask: 2,
  maxPlanningRevisions: 1,
  maxAutomaticPhaseReruns: 1,
  maxMergeRetryAttemptsPerTask: 2,
  maxFilesPerTaskSoft: 12,
  maxPackagesPerTaskSoft: 2,
  maxMigrationsPerTaskSoft: 1,
  maxWorktreeLifetimeHours: 24,
  maxBranchFanOutPerPhase: 6,
  maxUnresolvedHighSeverityFindings: 1,
  defaultTaskWallClockMinutes: 45
};

