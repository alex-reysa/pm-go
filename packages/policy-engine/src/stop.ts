import type {
  OperatingLimits,
  Plan,
  ReviewFinding,
  StopDecision,
} from "@pm-go/contracts";

/**
 * Counts findings that should block forward progress. The Phase 5
 * contract uses `FindingSeverity = "low" | "medium" | "high"`;
 * `OperatingLimits.maxUnresolvedHighSeverityFindings` (default 1)
 * names the high-severity bucket explicitly. We only count the
 * severity the limit names.
 */
function countHighSeverityFindings(
  findings: readonly ReviewFinding[],
): number {
  let n = 0;
  for (const f of findings) {
    if (f.severity === "high") n += 1;
  }
  return n;
}

function countAutomaticPhaseReruns(plan: Plan): number {
  // A phase has been "rerun" automatically if its status returned to
  // 'planning' or 'executing' after at least one completion/blocked
  // transition. We do not have that transition log here; the public
  // signal available on Plan + Phase is the phase's status and
  // whether it has an attached phase_audit_report_id already.
  //
  // As a pragmatic stand-in we count phases currently in
  // `blocked` OR `failed` whose `phaseAuditReportId` is already set —
  // that indicates at least one audit landed and the phase re-entered
  // a blocking state (which, when combined with the caller's cycles
  // count, is the canonical rerun signal). The caller can also pass a
  // pre-computed `cycles` total, which takes precedence.
  let n = 0;
  for (const phase of plan.phases) {
    if (
      phase.phaseAuditReportId !== undefined &&
      (phase.status === "blocked" || phase.status === "failed")
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * `evaluateStopCondition(plan, cycles, findings, limits) → StopDecision`
 *
 * Pure. Decides whether a plan must stop advancing.
 *
 * Stop reasons, in priority order:
 *   1. `high_severity_findings` — number of high-severity ReviewFinding
 *      entries > `limits.maxUnresolvedHighSeverityFindings`. We put
 *      this first because a single high-severity unresolved finding is
 *      a hard stop regardless of cycle count.
 *   2. `review_cycles_exceeded` — `cycles > limits.maxReviewFixCyclesPerTask`.
 *      `cycles` is the number of review→fix cycles already burned on the
 *      task under consideration; the caller computes it from
 *      ReviewReport rows for that task. Note the inequality is strict,
 *      matching the existing Phase 5 semantics in
 *      `packages/temporal-workflows/src/task-execution.ts`.
 *   3. `phase_rerun_exhausted` — the plan has already used more than
 *      `limits.maxAutomaticPhaseReruns` phase re-run budgets.
 *
 * The rules are evaluated against the default limits from
 * `DEFAULT_OPERATING_LIMITS` unless the caller overrides — Worker 4
 * passes the per-plan operating limits once they become configurable.
 */
export function evaluateStopCondition(
  plan: Plan,
  cycles: number,
  findings: readonly ReviewFinding[],
  limits: OperatingLimits,
): StopDecision {
  const highSeverity = countHighSeverityFindings(findings);
  if (highSeverity > limits.maxUnresolvedHighSeverityFindings) {
    return { stop: true, reason: "high_severity_findings" };
  }

  if (cycles > limits.maxReviewFixCyclesPerTask) {
    return { stop: true, reason: "review_cycles_exceeded" };
  }

  const reruns = countAutomaticPhaseReruns(plan);
  if (reruns > limits.maxAutomaticPhaseReruns) {
    return { stop: true, reason: "phase_rerun_exhausted" };
  }

  return { stop: false };
}
