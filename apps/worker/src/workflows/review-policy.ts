import type {
  PolicyDecisionType,
  ReviewReport,
  Task,
} from "@pm-go/contracts";

/**
 * Terminal task statuses decided by review-policy evaluation. These are
 * subset values of `TaskStatus`; the workflow persists them via the
 * `updateTaskStatus` activity.
 */
export type ReviewPolicyNextStatus =
  | "ready_to_merge"
  | "fixing"
  | "blocked";

/**
 * Structured reason codes for the `reason` column on `policy_decisions`.
 * Kept narrow so downstream API consumers and test assertions can branch
 * on a closed set rather than parsing free-form strings.
 */
export type ReviewPolicyReason =
  | "approved"
  | "reviewer_blocked"
  | "high_severity_cap"
  | "cycle_cap"
  | "retry_allowed";

export interface ReviewPolicyDecision {
  nextStatus: ReviewPolicyNextStatus;
  decision: PolicyDecisionType;
  reason: ReviewPolicyReason;
  /** Human-readable sentence persisted on the policy_decisions row. */
  reasonText: string;
}

/**
 * Phase 4 review-policy evaluator. Pure — no I/O, no clocks, no Temporal
 * primitives. Called once per review cycle by `TaskReviewWorkflow` to
 * decide what task-status transition the report implies and which
 * `PolicyDecision` row to persist alongside.
 *
 * Rule ordering matters:
 * 1. `pass` is the hot path; no other rules apply.
 * 2. Reviewer-escalated `blocked` short-circuits before any fix-cycle
 *    rule fires — the reviewer judged the issue un-fixable within the
 *    scope, no point in routing to another implementer cycle.
 * 3. High-severity cap beats cycle cap because a dangerous finding on
 *    cycle 1 should block, not route to fix (the fix-loop is designed
 *    for near-correct work, not security regressions).
 * 4. Cycle cap blocks `changes_requested` once we've exhausted retries.
 * 5. Otherwise, allow the retry.
 */
export function evaluateReviewPolicy(
  report: ReviewReport,
  task: Task,
  cycleNumber: number,
): ReviewPolicyDecision {
  if (report.outcome === "pass") {
    return {
      nextStatus: "ready_to_merge",
      decision: "approved",
      reason: "approved",
      reasonText: "Reviewer approved; no findings require changes.",
    };
  }

  if (report.outcome === "blocked") {
    return {
      nextStatus: "blocked",
      decision: "rejected",
      reason: "reviewer_blocked",
      reasonText:
        "Reviewer escalated to `blocked`; a fix cycle cannot resolve this finding. Human review required.",
    };
  }

  // outcome === "changes_requested"
  const highSeverityCount = report.findings.filter(
    (f) => f.severity === "high",
  ).length;
  const stopOnHighSeverity = task.reviewerPolicy.stopOnHighSeverityCount;
  if (highSeverityCount > stopOnHighSeverity) {
    return {
      nextStatus: "blocked",
      decision: "rejected",
      reason: "high_severity_cap",
      reasonText: `Review produced ${highSeverityCount} high-severity findings, exceeding task.reviewerPolicy.stopOnHighSeverityCount=${stopOnHighSeverity}.`,
    };
  }

  const cycleCap = task.maxReviewFixCycles;
  if (cycleNumber >= cycleCap) {
    return {
      nextStatus: "blocked",
      decision: "retry_denied",
      reason: "cycle_cap",
      reasonText: `Cycle ${cycleNumber} is the final permitted cycle (task.maxReviewFixCycles=${cycleCap}); no further fix attempts allowed.`,
    };
  }

  return {
    nextStatus: "fixing",
    decision: "retry_allowed",
    reason: "retry_allowed",
    reasonText: `Cycle ${cycleNumber} of ${cycleCap} produced fixable findings; routing to TaskFixWorkflow.`,
  };
}
