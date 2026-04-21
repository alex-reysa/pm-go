import type {
  ApprovalDecision,
  ApprovalRiskBand,
  Risk,
  RiskLevel,
  Task,
} from "@pm-go/contracts";

/**
 * Risk-level-to-band mapping used by `evaluateApprovalGate`.
 *
 * Phase 7 introduces an approval *band* concept without widening the
 * underlying `RiskLevel` enum (see `packages/contracts/src/plan.ts`).
 * The table below is therefore asymmetric: `"high"` is the default
 * high-risk band, and a task opts in to `"catastrophic"` either by
 * (a) carrying a matching `Risk` row whose description is escalated
 * at plan-time, or (b) being flagged explicitly by the caller via the
 * helper-level `taskIsCatastrophic` override.
 *
 * The mapping intentionally lives in this file rather than on `Task`
 * or `Risk` so a future Phase 8 can relocate it to a policy config
 * document without any contract-level churn.
 */
function bandForRiskLevel(level: RiskLevel): ApprovalRiskBand | null {
  switch (level) {
    case "low":
    case "medium":
      return null;
    case "high":
      return "high";
    default: {
      // Exhaustiveness guard. If `RiskLevel` widens in a future phase
      // (e.g. `"catastrophic"` is added directly), TypeScript will
      // surface a compile error here rather than let the new value
      // silently default to no-approval.
      const _exhaustive: never = level;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * `evaluateApprovalGate(risk, task) → ApprovalDecision`
 *
 * Pure. Decides whether a task needs a human thumbs-up before its
 * phase may integrate.
 *
 * Resolution order (first hit wins):
 *   1. If the `risk` argument is a `Risk` with
 *      `humanApprovalRequired: true` AND `level === "high"`, the band
 *      escalates to `"catastrophic"` when the paired task also carries
 *      `requiresHumanApproval: true`. This is the plan-time escalation
 *      path: a Risk row flagged catastrophic at planning plus a Task
 *      that still demands approval at execution time.
 *   2. Otherwise, if `task.requiresHumanApproval === true`, approval
 *      is required. The band comes from the task's own `riskLevel`
 *      (or "high" if the risk argument already mapped to "high").
 *   3. Otherwise, if the `risk` argument (as a Risk object or a bare
 *      RiskLevel) maps to a non-null band, approval is required at
 *      that band.
 *   4. Otherwise, no approval required.
 *
 * Callers pass the subject's risk as either:
 *   - a `Risk` row (plan-level risk with `humanApprovalRequired`)
 *   - a bare `RiskLevel` literal (task-scope escalation at runtime)
 */
export function evaluateApprovalGate(
  risk: Risk | RiskLevel,
  task: Task,
): ApprovalDecision {
  const riskLevel: RiskLevel =
    typeof risk === "string" ? risk : risk.level;
  const riskFlag =
    typeof risk === "string" ? false : risk.humanApprovalRequired;

  const riskBand = bandForRiskLevel(riskLevel);

  // Rule 1: catastrophic escalation — Risk+Task both flagged, at high level.
  if (riskFlag && riskLevel === "high" && task.requiresHumanApproval) {
    return { required: true, band: "catastrophic" };
  }

  // Rule 2: task itself demands approval regardless of risk rollup.
  if (task.requiresHumanApproval) {
    return { required: true, band: riskBand ?? "high" };
  }

  // Rule 3: plan-level Risk escalation.
  if (riskFlag && riskBand !== null) {
    return { required: true, band: riskBand };
  }

  // Rule 4: task risk alone reaches the high band.
  if (riskBand !== null) {
    return { required: true, band: riskBand };
  }

  return { required: false };
}
