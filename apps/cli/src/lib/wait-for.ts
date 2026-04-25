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
}

export type WaitForOutcome =
  | { status: 'ready'; ticks: number; elapsedMs: number }
  | { status: 'timeout'; ticks: number; elapsedMs: number; lastError?: string }

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
