import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { waitFor, type WaitForDeps } from '../lib/wait-for.js'

/**
 * Build a deterministic deps that advances `now` whenever `sleep` is
 * called. Lets a 60s timeout test complete in microseconds.
 */
function makeDeps(): WaitForDeps & { advanced: () => number } {
  let clock = 0
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    advanced: () => clock,
  }
}

describe('waitFor', () => {
  it('returns ready on the first successful check', async () => {
    const deps = makeDeps()
    const r = await waitFor(
      async () => true,
      { label: 'x', timeoutMs: 1_000, intervalMs: 10 },
      deps,
    )
    assert.strictEqual(r.status, 'ready')
    if (r.status === 'ready') assert.strictEqual(r.ticks, 1)
  })

  it('polls until the check succeeds', async () => {
    const deps = makeDeps()
    let calls = 0
    const r = await waitFor(
      async () => {
        calls++
        return calls === 5
      },
      { label: 'x', timeoutMs: 10_000, intervalMs: 50 },
      deps,
    )
    assert.strictEqual(r.status, 'ready')
    if (r.status === 'ready') assert.strictEqual(r.ticks, 5)
  })

  it('times out when the check never succeeds', async () => {
    const deps = makeDeps()
    const r = await waitFor(
      async () => false,
      { label: 'x', timeoutMs: 1_000, intervalMs: 100 },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
    if (r.status === 'timeout') {
      assert.ok(r.elapsedMs >= 1_000)
    }
  })

  it('captures the last error message when the check throws', async () => {
    const deps = makeDeps()
    const r = await waitFor(
      async () => {
        throw new Error('boom')
      },
      { label: 'x', timeoutMs: 200, intervalMs: 50 },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
    if (r.status === 'timeout') {
      assert.strictEqual(r.lastError, 'boom')
    }
  })

  it('does not exceed timeoutMs by more than one interval', async () => {
    const deps = makeDeps()
    const r = await waitFor(
      async () => false,
      { label: 'x', timeoutMs: 500, intervalMs: 100 },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
    if (r.status === 'timeout') {
      // Should land at exactly 500ms because the loop clamps the
      // last sleep to the remaining time.
      assert.strictEqual(r.elapsedMs, 500)
    }
  })

  // --------------------------------------------------------------------------
  // onTick heartbeat — used by `pm-go run` to surface plan-persistence
  // progress every 60s during the 20-minute plan wait. Without this the
  // operator stares at a silent terminal and assumes the supervisor wedged.
  // --------------------------------------------------------------------------
  it('fires onTick roughly every tickIntervalMs while the wait runs', async () => {
    const deps = makeDeps()
    const tickElapsed: number[] = []
    // 10s timeout, 100ms poll, 1s tick interval. The check never
    // succeeds, so we expect onTick to fire ~10 times (once per
    // 1000ms boundary) before the timeout lands.
    const r = await waitFor(
      async () => false,
      {
        label: 'x',
        timeoutMs: 10_000,
        intervalMs: 100,
        tickIntervalMs: 1_000,
        onTick: (ms) => tickElapsed.push(ms),
      },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
    // Should have fired roughly once per 1000ms boundary.
    assert.ok(
      tickElapsed.length >= 9 && tickElapsed.length <= 11,
      `expected ~10 ticks, got ${tickElapsed.length}: ${tickElapsed.join(',')}`,
    )
    // Each tick's elapsed value must be at or past the boundary it
    // represents — i.e. the first tick fires at >= 1000ms, the second
    // at >= 2000ms, etc. (Up to one intervalMs of overshoot is OK.)
    for (let i = 0; i < tickElapsed.length; i++) {
      const minBoundary = (i + 1) * 1_000
      assert.ok(
        tickElapsed[i]! >= minBoundary,
        `tick ${i} elapsed=${tickElapsed[i]} should be >= ${minBoundary}`,
      )
      assert.ok(
        tickElapsed[i]! < minBoundary + 200,
        `tick ${i} elapsed=${tickElapsed[i]} should be within one polling interval of ${minBoundary}`,
      )
    }
  })

  it('does not fire onTick when the check succeeds before the first tick boundary', async () => {
    const deps = makeDeps()
    const tickCalls: number[] = []
    const r = await waitFor(
      async () => true,
      {
        label: 'x',
        timeoutMs: 10_000,
        intervalMs: 50,
        tickIntervalMs: 1_000,
        onTick: (ms) => tickCalls.push(ms),
      },
      deps,
    )
    assert.strictEqual(r.status, 'ready')
    assert.strictEqual(tickCalls.length, 0)
  })

  it('omitting onTick keeps existing behaviour (no callback fires)', async () => {
    // Regression guard: the option is purely additive; existing callers
    // (postgres / temporal / api / etc.) must continue to behave as
    // before when they don't pass onTick.
    const deps = makeDeps()
    const r = await waitFor(
      async () => false,
      { label: 'x', timeoutMs: 5_000, intervalMs: 100 },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
  })

  it('uses the 60s default when tickIntervalMs is omitted', async () => {
    const deps = makeDeps()
    const tickElapsed: number[] = []
    // 180s timeout, no tickIntervalMs override → default 60s.
    const r = await waitFor(
      async () => false,
      {
        label: 'x',
        timeoutMs: 180_000,
        intervalMs: 500,
        onTick: (ms) => tickElapsed.push(ms),
      },
      deps,
    )
    assert.strictEqual(r.status, 'timeout')
    // 180s / 60s default = 3 boundaries: 60s, 120s, 180s.
    assert.ok(
      tickElapsed.length >= 2 && tickElapsed.length <= 3,
      `expected 2-3 ticks at 60s default, got ${tickElapsed.length}: ${tickElapsed.join(',')}`,
    )
    // First tick must land at >= 60_000ms.
    assert.ok(tickElapsed[0]! >= 60_000)
  })
})
