import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkPorts,
  isPortFree,
  type PortPreflightDeps,
  type PortHolder,
} from '../lib/port-preflight.js'

// ---------------------------------------------------------------------------
// Test helpers — fake lsof
// ---------------------------------------------------------------------------

/**
 * Build a deps where `probe(port)` returns whatever the supplied
 * fixture says. Unmapped ports return [] (i.e. free).
 */
function makeDeps(
  fixture: Record<number, PortHolder[]>,
  opts: { failOn?: number[] } = {},
): PortPreflightDeps & { calls: number[] } {
  const calls: number[] = []
  const failSet = new Set(opts.failOn ?? [])
  return {
    calls,
    probe: async (port: number) => {
      calls.push(port)
      if (failSet.has(port)) throw new Error(`probe failed for port ${port}`)
      return fixture[port] ?? []
    },
  }
}

// ---------------------------------------------------------------------------
// checkPorts
// ---------------------------------------------------------------------------

describe('checkPorts', () => {
  it('returns [] when no probed port has any holder', async () => {
    const deps = makeDeps({})
    const conflicts = await checkPorts([5432, 7233, 3001], [], deps)
    assert.deepStrictEqual(conflicts, [])
    // Every port was probed.
    assert.deepStrictEqual([...deps.calls].sort((a, b) => a - b), [3001, 5432, 7233])
  })

  it('produces a PortConflict when a non-pm-go PID holds 5432 (ac-ae6f-2 i)', async () => {
    const deps = makeDeps({
      5432: [{ pid: 99999, command: 'postgres' }],
    })
    // knownPmGoPids deliberately excludes 99999 — that PID belongs
    // to some unrelated postgres on the box.
    const conflicts = await checkPorts([5432], [12345, 12346], deps)
    assert.strictEqual(conflicts.length, 1)
    assert.deepStrictEqual(conflicts[0], {
      port: 5432,
      pid: 99999,
      command: 'postgres',
    })
  })

  it('produces zero conflicts when a pm-go-owned PID holds 7233 (ac-ae6f-2 ii)', async () => {
    const deps = makeDeps({
      7233: [{ pid: 12345, command: 'temporal' }],
    })
    // 12345 is one of OUR processes — listed in knownPmGoPids.
    const conflicts = await checkPorts([7233], [12345], deps)
    assert.deepStrictEqual(conflicts, [])
  })

  it('accepts knownPmGoPids as a Set or as an array', async () => {
    const deps1 = makeDeps({ 7233: [{ pid: 12345 }] })
    const deps2 = makeDeps({ 7233: [{ pid: 12345 }] })
    const fromSet = await checkPorts([7233], new Set([12345]), deps1)
    const fromArr = await checkPorts([7233], [12345], deps2)
    assert.deepStrictEqual(fromSet, [])
    assert.deepStrictEqual(fromArr, [])
  })

  it('mixes both shapes in a single call: known pm-go on 7233, foreign on 5432', async () => {
    const deps = makeDeps({
      5432: [{ pid: 99999, command: 'postgres' }],
      7233: [{ pid: 12345, command: 'pm-go-temporal' }],
    })
    const conflicts = await checkPorts([5432, 7233], new Set([12345]), deps)
    assert.strictEqual(conflicts.length, 1)
    assert.strictEqual(conflicts[0]!.port, 5432)
    assert.strictEqual(conflicts[0]!.pid, 99999)
  })

  it('emits one conflict per holder when a port has multiple non-pm-go holders', async () => {
    // Real lsof can report both an IPv4 and IPv6 listener for the
    // same port — verify we surface both.
    const deps = makeDeps({
      5432: [
        { pid: 99999, command: 'postgres' },
        { pid: 88888, command: 'postgres' },
      ],
    })
    const conflicts = await checkPorts([5432], [], deps)
    assert.strictEqual(conflicts.length, 2)
    // pid-asc ordering inside a port.
    assert.strictEqual(conflicts[0]!.pid, 88888)
    assert.strictEqual(conflicts[1]!.pid, 99999)
  })

  it('drops only the known pm-go PID when a port has both kinds of holder', async () => {
    const deps = makeDeps({
      5432: [
        { pid: 12345, command: 'pm-go' }, // ours
        { pid: 99999, command: 'postgres' }, // foreign
      ],
    })
    const conflicts = await checkPorts([5432], [12345], deps)
    assert.strictEqual(conflicts.length, 1)
    assert.strictEqual(conflicts[0]!.pid, 99999)
  })

  it('dedupes the input ports list', async () => {
    const deps = makeDeps({
      5432: [{ pid: 99999 }],
    })
    await checkPorts([5432, 5432, 5432], [], deps)
    assert.strictEqual(deps.calls.length, 1, 'probe should be called once per unique port')
  })

  it('returns conflicts sorted by (port asc, pid asc)', async () => {
    const deps = makeDeps({
      7233: [{ pid: 50, command: 'a' }],
      5432: [
        { pid: 30, command: 'b' },
        { pid: 10, command: 'c' },
      ],
    })
    const conflicts = await checkPorts([7233, 5432], [], deps)
    assert.deepStrictEqual(
      conflicts.map((c) => [c.port, c.pid]),
      [
        [5432, 10],
        [5432, 30],
        [7233, 50],
      ],
    )
  })

  it('surfaces a synthetic conflict (pid -1) when probe rejects', async () => {
    const deps = makeDeps({}, { failOn: [5432] })
    const conflicts = await checkPorts([5432, 7233], [], deps)
    assert.strictEqual(conflicts.length, 1)
    assert.strictEqual(conflicts[0]!.port, 5432)
    assert.strictEqual(conflicts[0]!.pid, -1)
    assert.match(conflicts[0]!.command ?? '', /probe failed/)
  })

  it('omits the command field when the holder did not provide one', async () => {
    const deps = makeDeps({
      5432: [{ pid: 99999 }],
    })
    const conflicts = await checkPorts([5432], [], deps)
    assert.strictEqual(conflicts.length, 1)
    assert.strictEqual(conflicts[0]!.command, undefined)
  })
})

// ---------------------------------------------------------------------------
// isPortFree
// ---------------------------------------------------------------------------

describe('isPortFree', () => {
  it('returns true when nobody is listening', async () => {
    const deps = makeDeps({})
    assert.strictEqual(await isPortFree(5432, [], deps), true)
  })

  it('returns true when the only holder is a known pm-go PID', async () => {
    const deps = makeDeps({ 5432: [{ pid: 12345 }] })
    assert.strictEqual(await isPortFree(5432, [12345], deps), true)
  })

  it('returns false when a foreign PID is holding the port', async () => {
    const deps = makeDeps({ 5432: [{ pid: 99999, command: 'postgres' }] })
    assert.strictEqual(await isPortFree(5432, [12345], deps), false)
  })
})
