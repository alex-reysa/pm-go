/**
 * Generic readiness poll helper. Used by `pm-go run` to wait for
 * Postgres / Temporal / API health endpoints to become ready before
 * proceeding to the next stack-up step.
 *
 * Pure with respect to its `deps` — tests can run thousands of ticks
 * in microseconds by passing fake `now`, `sleep`, and `check`
 * implementations.
 */

export interface WaitForDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface WaitForOptions {
  /** Human-readable name used in timeout messages. */
  label: string
  /** Maximum total wall time before giving up. */
  timeoutMs: number
  /** Delay between checks. */
  intervalMs: number
  /**
   * Optional progress callback fired roughly every `tickIntervalMs`
   * (default 60_000ms) of waiting. Receives the elapsed milliseconds
   * since the wait began. Existing callers ignore it; long-running
   * polls (e.g. plan persistence) use it to log heartbeat lines so
   * operators don't sit through silence wondering if anything's
   * progressing.
   */
  onTick?: (elapsedMs: number) => void
  /**
   * Wall-clock interval between `onTick` invocations. Independent
   * from `intervalMs` so a fast-polling check can still emit a slow
   * heartbeat. Default 60_000ms. Ignored when `onTick` is absent.
   */
  tickIntervalMs?: number
}

export type WaitForOutcome =
  | { status: 'ready'; ticks: number; elapsedMs: number }
  | { status: 'timeout'; ticks: number; elapsedMs: number; lastError?: string }

const DEFAULT_TICK_INTERVAL_MS = 60_000

/**
 * Repeatedly invoke `check` until it returns true, an error is thrown
 * non-stop, or `timeoutMs` elapses. Errors thrown by `check` are
 * caught and logged as the latest failure reason; only the timeout
 * itself ends the poll.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  options: WaitForOptions,
  deps: WaitForDeps,
): Promise<WaitForOutcome> {
  const start = deps.now()
  let ticks = 0
  let lastError: string | undefined
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  let nextTickAtMs = tickIntervalMs

  while (true) {
    ticks += 1
    try {
      const ok = await check()
      if (ok) {
        return { status: 'ready', ticks, elapsedMs: deps.now() - start }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    const elapsed = deps.now() - start
    // Fire onTick once per tick interval — covers the common case of
    // a long poll (plan-persistence: 20 minutes) where the operator
    // needs heartbeat output. We fire after each check rather than
    // before the sleep so the first tick lands at ~tickIntervalMs of
    // real elapsed time, not at boot.
    if (options.onTick && elapsed >= nextTickAtMs) {
      options.onTick(elapsed)
      // Catch up across multiple tick boundaries if the check itself
      // took longer than tickIntervalMs (rare but possible). Always
      // advance at least one boundary so we don't busy-loop.
      while (nextTickAtMs <= elapsed) {
        nextTickAtMs += tickIntervalMs
      }
    }
    if (elapsed >= options.timeoutMs) {
      return { status: 'timeout', ticks, elapsedMs: elapsed, ...(lastError !== undefined ? { lastError } : {}) }
    }
    const remaining = options.timeoutMs - elapsed
    await deps.sleep(Math.min(options.intervalMs, remaining))
  }
}

/**
 * Convenience wrapper: hit an HTTP URL and consider it ready if the
 * response is 2xx. Used for API `/health` and Temporal frontend
 * pings via the SDK's gRPC-on-HTTP fallback when present.
 */
export function httpReady(
  fetchFn: typeof globalThis.fetch,
  url: string,
): () => Promise<boolean> {
  return async () => {
    try {
      const res = await fetchFn(url)
      return res.ok
    } catch {
      return false
    }
  }
}
