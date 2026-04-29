/**
 * Generic readiness poll helper. Used by `pm-go run` to wait for
 * Postgres / Temporal / API health endpoints to become ready before
 * proceeding to the next stack-up step.
 *
 * Pure with respect to its `deps` — tests can run thousands of ticks
 * in microseconds by passing fake `now`, `sleep`, and `check`
 * implementations.
 */

import {
  assertPmGoApi,
  PmGoIdentityMismatchError,
  type PmGoApiIdentity,
} from './api-client.js'

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

// ---------------------------------------------------------------------------
// Identity-aware API readiness probe
// ---------------------------------------------------------------------------

/**
 * Outcome of `waitForPmGoApi`. Three terminal states the caller must
 * branch on, distinct from `WaitForOutcome` because the supervisor
 * needs to act differently on each one:
 *
 *   - `ready`     — 2xx from the API + a body that validates as a
 *                   pm-go identity envelope. Boot proceeds.
 *   - `timeout`   — never reached `ready` inside `timeoutMs`. Probably
 *                   the API never started; the supervisor logs the
 *                   timeout and tears children down via the same
 *                   shutdown path it uses for any other startup
 *                   failure.
 *   - `mismatch`  — a 2xx response answered the probe but the body
 *                   is NOT a pm-go envelope (foreign service, malformed
 *                   JSON, missing fields). We return immediately rather
 *                   than burning the full `timeoutMs` retrying — when
 *                   another service holds the port, no amount of
 *                   waiting will make it answer with our envelope.
 *                   The caller MUST surface the structured error and
 *                   exit non-zero, because letting `pm-go` drive
 *                   against a foreign service silently is the original
 *                   bug this whole probe exists to prevent.
 */
export type PmGoApiReadyOutcome =
  | {
      status: 'ready'
      identity: PmGoApiIdentity
      ticks: number
      elapsedMs: number
    }
  | {
      status: 'timeout'
      ticks: number
      elapsedMs: number
      lastError?: string
    }
  | {
      status: 'mismatch'
      error: PmGoIdentityMismatchError
      ticks: number
      elapsedMs: number
    }

/**
 * Single readiness path for the `pm-go` API. Combines the 2xx-only
 * probe (the old `httpReady`) with the identity assertion in one
 * place so the `[5/6] waiting for api` step in `run.ts`/`implement.ts`
 * can never see a 2xx response from a foreign service and treat it as
 * "boot succeeded".
 *
 * Per-tick classification:
 *
 *   - fetch threw                 → transient (still booting)
 *   - HTTP non-2xx                → transient (server up, path missing,
 *                                   restarting, etc.)
 *   - body read failed            → transient (connection reset)
 *   - 2xx + valid identity        → READY (terminal)
 *   - 2xx + non-JSON body         → MISMATCH (terminal — foreign service)
 *   - 2xx + JSON but wrong shape  → MISMATCH (terminal — wrong service)
 *
 * Transient states accumulate into `lastError` (mirroring `waitFor`)
 * so a final `timeout` can surface the most recent failure reason.
 *
 * The fetch impl is injected so tests can simulate every branch
 * without touching the network. The polling clock comes from `deps`
 * so tests can compress a 30-second poll into microseconds.
 */
export async function waitForPmGoApi(
  fetchFn: typeof globalThis.fetch,
  url: string,
  options: { timeoutMs: number; intervalMs: number },
  deps: WaitForDeps,
): Promise<PmGoApiReadyOutcome> {
  const start = deps.now()
  let ticks = 0
  let lastError: string | undefined

  while (true) {
    ticks += 1
    const probe = await probePmGoApiOnce(fetchFn, url)
    if (probe.kind === 'ready') {
      return {
        status: 'ready',
        identity: probe.identity,
        ticks,
        elapsedMs: deps.now() - start,
      }
    }
    if (probe.kind === 'mismatch') {
      // Fast-fail: another service is answering 2xx on this port. No
      // amount of waiting will turn it into pm-go.
      return {
        status: 'mismatch',
        error: probe.error,
        ticks,
        elapsedMs: deps.now() - start,
      }
    }
    // Transient — record the message and let the timeout decide.
    if (probe.error !== undefined) lastError = probe.error

    const elapsed = deps.now() - start
    if (elapsed >= options.timeoutMs) {
      return {
        status: 'timeout',
        ticks,
        elapsedMs: elapsed,
        ...(lastError !== undefined ? { lastError } : {}),
      }
    }
    const remaining = options.timeoutMs - elapsed
    await deps.sleep(Math.min(options.intervalMs, remaining))
  }
}

/**
 * One-shot probe used by `waitForPmGoApi`. Returns a discriminated
 * union so the polling loop can distinguish transient failures (keep
 * retrying) from a confirmed identity mismatch (give up immediately).
 *
 * Kept private to this module — the polling-and-classification logic
 * is the only contract callers need. Tests reach the branches through
 * `waitForPmGoApi`'s outcome.
 */
type ProbeResult =
  | { kind: 'ready'; identity: PmGoApiIdentity }
  | { kind: 'transient'; error?: string }
  | { kind: 'mismatch'; error: PmGoIdentityMismatchError }

async function probePmGoApiOnce(
  fetchFn: typeof globalThis.fetch,
  url: string,
): Promise<ProbeResult> {
  let res: Response
  try {
    res = await fetchFn(url)
  } catch (err) {
    return {
      kind: 'transient',
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) {
    return {
      kind: 'transient',
      error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    }
  }
  let bodyText: string
  try {
    bodyText = await res.text()
  } catch (err) {
    return {
      kind: 'transient',
      error: `failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // 2xx response — interpret the body. From here, anything that
  // doesn't validate is a hard mismatch: a real pm-go API always
  // returns its identity envelope.
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // Non-JSON body. Run the parsed text through assertPmGoApi so we
    // get the same `[pm-go] port <port> is held by another service`
    // shape every other identity-mismatch goes through. assertPmGoApi
    // rejects non-objects, which is precisely what `bodyText` is.
    try {
      assertPmGoApi(bodyText, { url })
    } catch (assertErr) {
      if (assertErr instanceof PmGoIdentityMismatchError) {
        return { kind: 'mismatch', error: assertErr }
      }
      throw assertErr
    }
    // assertPmGoApi MUST throw on a string input (not a plain object).
    // If it ever returned, we'd be in deeply unexpected territory —
    // surface as transient so the caller's timeout still fires.
    return { kind: 'transient', error: 'identity assertion did not throw on non-JSON body' }
  }
  try {
    const identity = assertPmGoApi(parsed, { url })
    return { kind: 'ready', identity }
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      return { kind: 'mismatch', error: err }
    }
    throw err
  }
}
