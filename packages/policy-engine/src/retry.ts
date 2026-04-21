import type {
  RetryDecision,
  RetryPolicyConfig,
} from "@pm-go/contracts";

/**
 * Shape of the "last error" passed to `evaluateRetryDecision`.
 *
 * We deliberately accept a minimal structural type rather than
 * requiring a `globalThis.Error` instance. Temporal activity retries
 * serialize the error name separately from the value, so the caller
 * may reconstruct just a `{ name, message }` bag. A plain `Error`
 * satisfies this shape; so does a deserialized payload.
 */
export interface RetryErrorLike {
  name?: string;
  message?: string;
}

function clamp(value: number, floor: number, ceiling: number): number {
  if (!Number.isFinite(value)) return ceiling;
  if (value < floor) return floor;
  if (value > ceiling) return ceiling;
  return value;
}

/**
 * `evaluateRetryDecision(workflowName, attempt, lastError, limits) → RetryDecision`
 *
 * Pure. Decides whether a failed workflow attempt should retry, and
 * if so, how long to wait.
 *
 * Semantics:
 *   - `attempt` is 1-indexed at the attempt that just failed. The
 *     decision is about whether to schedule attempt N+1.
 *   - `limits` is the full catalog of per-workflow policies. The
 *     helper picks the entry whose `workflowName` matches, or returns
 *     `retry: false` with a "no_policy" reason if no match is found.
 *     Callers typically pass `PHASE7_RETRY_POLICIES` (Worker 4 owns
 *     that catalog; here we stay SDK-agnostic).
 *   - A non-retryable error name (exact match against
 *     `policy.nonRetryableErrorNames`) short-circuits to
 *     `retry: false`.
 *   - Exhausted attempts (`attempt >= maxAttempts`) return
 *     `retry: false`.
 *   - Otherwise the delay is
 *       min(initialDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs).
 *     We intentionally omit jitter here because jitter is the caller's
 *     (Temporal's) responsibility. Worker 4 translates `delayMs` into
 *     the Temporal `RetryPolicy.initialInterval` on activity schedule.
 */
export function evaluateRetryDecision(
  workflowName: string,
  attempt: number,
  lastError: RetryErrorLike | undefined,
  limits: readonly RetryPolicyConfig[],
): RetryDecision {
  const policy = limits.find((l) => l.workflowName === workflowName);
  if (!policy) {
    return { retry: false, reason: "no_policy_for_workflow" };
  }

  if (attempt < 1 || !Number.isInteger(attempt)) {
    return { retry: false, reason: "invalid_attempt_number" };
  }

  if (lastError?.name && policy.nonRetryableErrorNames?.includes(lastError.name)) {
    return {
      retry: false,
      reason: `non_retryable_error:${lastError.name}`,
    };
  }

  if (attempt >= policy.maxAttempts) {
    return { retry: false, reason: "max_attempts_exhausted" };
  }

  const exponent = attempt - 1;
  const uncapped =
    policy.initialDelayMs * Math.pow(policy.backoffMultiplier, exponent);
  const delayMs = Math.floor(clamp(uncapped, 0, policy.maxDelayMs));
  return { retry: true, delayMs };
}
