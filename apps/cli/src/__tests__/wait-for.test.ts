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
})
