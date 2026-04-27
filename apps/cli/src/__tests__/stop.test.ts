import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { InstanceState } from '../ps.js'
import {
  parseStopArgv,
  runStop,
  type StopDeps,
} from '../stop.js'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

interface KillCall {
  pid: number
  signal: 'SIGTERM' | 'SIGKILL' | 0
}

interface FakeStopOpts {
  states: InstanceState[]
  /**
   * For each PID in `dieAfterTermAfterMs`, the PID becomes "dead" at
   * `now0 + dieAfterTermAfterMs[pid]` ms after SIGTERM is sent. PIDs
   * absent from this map stay alive forever (so the stop logic must
   * SIGKILL them).
   */
  dieAfterTermMs?: Record<number, number>
}

function makeFakeStop(opts: FakeStopOpts): {
  deps: StopDeps
  killCalls: KillCall[]
  removeCalls: string[]
  lines: string[]
} {
  const killCalls: KillCall[] = []
  const removeCalls: string[] = []
  const lines: string[] = []

  // Virtual clock — `now()` advances when `sleep()` is called so the
  // grace window can elapse without real time passing.
  let now = 0
  // PID → dead-at virtual ms (or Infinity if it stays alive forever).
  const deadAt = new Map<number, number>()
  for (const s of opts.states) {
    for (const e of s.entries) {
      deadAt.set(e.pid, Number.POSITIVE_INFINITY)
    }
  }

  const deps: StopDeps = {
    listInstanceStates: async () => opts.states,
    removeStateFile: async (name) => {
      removeCalls.push(name)
    },
    kill: (pid, signal) => {
      killCalls.push({ pid, signal })
      if (signal === 'SIGTERM' && opts.dieAfterTermMs?.[pid] !== undefined) {
        deadAt.set(pid, now + opts.dieAfterTermMs[pid]!)
      }
      if (signal === 'SIGKILL') {
        deadAt.set(pid, now)
      }
      return true
    },
    isAlive: (pid) => {
      const d = deadAt.get(pid)
      if (d === undefined) return false
      return now < d
    },
    sleep: async (ms) => {
      now += ms
    },
    now: () => now,
    write: (l) => lines.push(l),
  }

  return { deps, killCalls, removeCalls, lines }
}

const MULTI_PID_STATE: InstanceState = {
  instance: 'default',
  apiPort: 3001,
  entries: [
    { label: 'worker', pid: 12345, startedAt: '2026-04-27T11:55:00.000Z' },
    {
      label: 'api',
      pid: 12346,
      port: 3001,
      startedAt: '2026-04-27T11:55:00.000Z',
    },
  ],
}

const SECOND_INSTANCE: InstanceState = {
  instance: 'scratch',
  apiPort: 4001,
  entries: [
    { label: 'worker', pid: 22345, startedAt: '2026-04-27T11:50:00.000Z' },
  ],
}

// ---------------------------------------------------------------------------
// parseStopArgv
// ---------------------------------------------------------------------------

describe('parseStopArgv', () => {
  it('defaults grace-ms to 5000', () => {
    const r = parseStopArgv([])
    assert.ok(r.ok)
    assert.strictEqual(r.options.graceMs, 5000)
    assert.strictEqual(r.options.instance, undefined)
  })

  it('accepts --instance + --grace-ms', () => {
    const r = parseStopArgv(['--instance', 'scratch', '--grace-ms', '1500'])
    assert.ok(r.ok)
    assert.strictEqual(r.options.instance, 'scratch')
    assert.strictEqual(r.options.graceMs, 1500)
  })

  it('rejects --grace-ms outside 0..600000', () => {
    for (const bad of ['-1', '999999999', 'abc']) {
      const r = parseStopArgv(['--grace-ms', bad])
      assert.ok(!r.ok, `grace-ms=${bad} should fail`)
    }
  })

  it('returns help signal on -h / --help', () => {
    for (const flag of ['-h', '--help']) {
      const r = parseStopArgv([flag])
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('rejects unknown flags', () => {
    const r = parseStopArgv(['--bogus'])
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })
})

// ---------------------------------------------------------------------------
// runStop — happy / idempotent / scoped paths
// ---------------------------------------------------------------------------

describe('runStop', () => {
  it('idempotent when no state files exist: prints (no pm-go instances) and exits 0', async () => {
    const { deps, lines, killCalls, removeCalls } = makeFakeStop({ states: [] })
    const code = await runStop({ graceMs: 5000 }, deps)
    assert.strictEqual(code, 0)
    assert.match(lines.join('\n'), /\(no pm-go instances\)/)
    assert.strictEqual(killCalls.length, 0)
    assert.strictEqual(removeCalls.length, 0)
  })

  it('SIGTERMs all tracked PIDs and removes the state file when all exit cleanly within grace', async () => {
    const { deps, killCalls, removeCalls } = makeFakeStop({
      states: [MULTI_PID_STATE],
      // Each PID dies 50ms after SIGTERM — well within default 5s grace.
      dieAfterTermMs: { 12345: 50, 12346: 100 },
    })
    const code = await runStop({ graceMs: 5000 }, deps)
    assert.strictEqual(code, 0)
    // SIGTERM sent to every tracked PID.
    const term = killCalls.filter((c) => c.signal === 'SIGTERM')
    assert.deepStrictEqual(
      term.map((c) => c.pid).sort(),
      [12345, 12346],
    )
    // Critical: NO SIGKILL when everything exits within grace.
    const sigkill = killCalls.filter((c) => c.signal === 'SIGKILL')
    assert.strictEqual(sigkill.length, 0, 'should not SIGKILL clean exits')
    assert.deepStrictEqual(removeCalls, ['default'])
  })

  it('SIGKILLs survivors that outlive the grace window', async () => {
    const { deps, killCalls, removeCalls } = makeFakeStop({
      states: [MULTI_PID_STATE],
      // 12345 dies after SIGTERM; 12346 never does.
      dieAfterTermMs: { 12345: 50 },
    })
    const code = await runStop({ graceMs: 200 }, deps)
    assert.strictEqual(code, 0)
    const sigkill = killCalls.filter((c) => c.signal === 'SIGKILL')
    assert.deepStrictEqual(sigkill.map((c) => c.pid), [12346])
    // 12345 should NOT have been SIGKILLed since it died first.
    assert.ok(!sigkill.some((c) => c.pid === 12345))
    assert.deepStrictEqual(removeCalls, ['default'])
  })

  it('--instance scopes the kill to a single instance (by name)', async () => {
    const { deps, killCalls, removeCalls } = makeFakeStop({
      states: [MULTI_PID_STATE, SECOND_INSTANCE],
      dieAfterTermMs: { 12345: 1, 12346: 1, 22345: 1 },
    })
    const code = await runStop(
      { graceMs: 5000, instance: 'scratch' },
      deps,
    )
    assert.strictEqual(code, 0)
    // Only the scratch PID was signalled.
    assert.deepStrictEqual(
      killCalls.filter((c) => c.signal === 'SIGTERM').map((c) => c.pid),
      [22345],
    )
    assert.deepStrictEqual(removeCalls, ['scratch'])
  })

  it('--instance also matches by apiPort string', async () => {
    const { deps, killCalls, removeCalls } = makeFakeStop({
      states: [MULTI_PID_STATE, SECOND_INSTANCE],
      dieAfterTermMs: { 12345: 1, 12346: 1, 22345: 1 },
    })
    const code = await runStop({ graceMs: 5000, instance: '4001' }, deps)
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(
      killCalls.filter((c) => c.signal === 'SIGTERM').map((c) => c.pid),
      [22345],
    )
    assert.deepStrictEqual(removeCalls, ['scratch'])
  })

  it('--instance with no match exits 0 with the (no pm-go instances) banner', async () => {
    const { deps, lines, killCalls, removeCalls } = makeFakeStop({
      states: [MULTI_PID_STATE],
    })
    const code = await runStop(
      { graceMs: 5000, instance: 'does-not-exist' },
      deps,
    )
    assert.strictEqual(code, 0)
    assert.match(lines.join('\n'), /\(no pm-go instances\)/)
    assert.strictEqual(killCalls.length, 0)
    assert.strictEqual(removeCalls.length, 0)
  })

  it('skips already-dead PIDs without sending SIGTERM', async () => {
    // PID is already dead before any signal — isAlive returns false.
    // Use a state with a single PID whose dead-at is 0.
    const dead: InstanceState = {
      instance: 'ghost',
      apiPort: 3002,
      entries: [
        { label: 'worker', pid: 77777, startedAt: '2026-04-27T11:00:00Z' },
      ],
    }
    const { deps, killCalls, removeCalls } = makeFakeStop({
      states: [dead],
    })
    // Mark 77777 dead at virtual t=0 by overriding deadAt directly via
    // dieAfterTermMs trick — set it to die before any signal is sent
    // by making it already dead. We do that by sending SIGKILL so
    // deadAt[pid] = 0… simpler: use a state with no entries -- already
    // covered. Instead, simulate "already dead" by toggling isAlive.
    // The straightforward path: pre-call kill(pid, 'SIGKILL') so
    // deadAt[pid] = 0 immediately.
    deps.kill(77777, 'SIGKILL')
    // Reset the recorded calls so the test only inspects runStop's own.
    killCalls.length = 0
    removeCalls.length = 0
    const code = await runStop({ graceMs: 100 }, deps)
    assert.strictEqual(code, 0)
    // Nothing signalled because the PID was already dead.
    assert.strictEqual(killCalls.length, 0)
    // State file still removed so future ps doesn't show ghosts.
    assert.deepStrictEqual(removeCalls, ['ghost'])
  })
})
