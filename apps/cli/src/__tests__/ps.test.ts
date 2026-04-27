import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePsArgv,
  runPs,
  type InstanceState,
  type PsDeps,
  type PsJsonOutput,
} from '../ps.js'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-04-27T12:00:00.000Z')

function makeDeps(opts: {
  states?: InstanceState[]
  alive?: ReadonlySet<number>
  now?: number
}): { deps: PsDeps; lines: string[] } {
  const lines: string[] = []
  const alive = opts.alive ?? new Set<number>()
  const deps: PsDeps = {
    listInstanceStates: async () => opts.states ?? [],
    isAlive: (pid) => alive.has(pid),
    now: () => opts.now ?? NOW,
    write: (l) => lines.push(l),
  }
  return { deps, lines }
}

const FIXTURE_DEFAULT: InstanceState = {
  instance: 'default',
  apiPort: 3001,
  entries: [
    {
      label: 'worker',
      pid: 12345,
      startedAt: '2026-04-27T11:55:00.000Z', // 5m before NOW
    },
    {
      label: 'api',
      pid: 12346,
      port: 3001,
      startedAt: '2026-04-27T11:55:00.000Z',
    },
    {
      label: 'drive',
      pid: 12347,
      startedAt: '2026-04-27T11:58:00.000Z', // 2m before NOW
    },
  ],
}

const FIXTURE_STALE: InstanceState = {
  instance: 'old',
  apiPort: 4001,
  entries: [
    {
      label: 'worker',
      pid: 99999,
      startedAt: '2026-04-26T10:00:00.000Z',
    },
  ],
}

// ---------------------------------------------------------------------------
// parsePsArgv
// ---------------------------------------------------------------------------

describe('parsePsArgv', () => {
  it('defaults to text mode', () => {
    const r = parsePsArgv([])
    assert.ok(r.ok)
    assert.strictEqual(r.options.json, false)
  })

  it('accepts --json', () => {
    const r = parsePsArgv(['--json'])
    assert.ok(r.ok)
    assert.strictEqual(r.options.json, true)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = parsePsArgv([flag])
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('rejects unknown flags', () => {
    const r = parsePsArgv(['--bogus'])
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })
})

// ---------------------------------------------------------------------------
// runPs — text mode
// ---------------------------------------------------------------------------

describe('runPs (text)', () => {
  it('emits "(no pm-go instances)" when no states exist', async () => {
    const { deps, lines } = makeDeps({ states: [] })
    const code = await runPs({ json: false }, deps)
    assert.strictEqual(code, 0)
    const out = lines.join('\n')
    assert.match(out, /\(no pm-go instances\)/)
  })

  it('lists worker/api/drive entries with PID/PORT/UPTIME/INSTANCE', async () => {
    const { deps, lines } = makeDeps({
      states: [FIXTURE_DEFAULT],
      alive: new Set([12345, 12346, 12347]),
    })
    const code = await runPs({ json: false }, deps)
    assert.strictEqual(code, 0)
    const out = lines.join('\n')
    assert.ok(out.includes('Live'))
    assert.ok(out.includes('LABEL'))
    assert.ok(out.includes('worker'))
    assert.ok(out.includes('12345'))
    assert.ok(out.includes('api'))
    assert.ok(out.includes('12346'))
    // api row should have its port; worker / drive should print '-'.
    assert.match(out, /api\s+12346\s+3001/)
    assert.match(out, /worker\s+12345\s+-/)
    assert.match(out, /drive\s+12347\s+-/)
    // 5 minutes uptime → 00:05:00.
    assert.ok(out.includes('00:05:00'))
    // 2 minutes uptime for drive → 00:02:00.
    assert.ok(out.includes('00:02:00'))
    // Instance column.
    assert.ok(out.includes('default'))
    // No Stale section when nothing is dead.
    assert.ok(!out.includes('Stale'))
  })

  it('moves dead PIDs into a separate Stale section', async () => {
    const { deps, lines } = makeDeps({
      states: [FIXTURE_DEFAULT, FIXTURE_STALE],
      alive: new Set([12345, 12346]), // 12347 + 99999 dead
    })
    const code = await runPs({ json: false }, deps)
    assert.strictEqual(code, 0)
    const out = lines.join('\n')
    const stalePos = out.indexOf('Stale')
    assert.ok(stalePos > 0, 'should emit Stale section')
    const liveSection = out.slice(0, stalePos)
    const staleSection = out.slice(stalePos)
    // Live section: worker + api still alive.
    assert.ok(liveSection.includes('12345'))
    assert.ok(liveSection.includes('12346'))
    // Stale section: drive (12347) + 99999 from "old" instance.
    assert.ok(staleSection.includes('12347'))
    assert.ok(staleSection.includes('99999'))
    assert.ok(staleSection.includes('old'))
    // Hint line points to stop / recover.
    assert.match(out, /pm-go stop|pm-go recover/)
  })
})

// ---------------------------------------------------------------------------
// runPs — JSON mode
// ---------------------------------------------------------------------------

describe('runPs (json)', () => {
  it('emits the documented stable shape', async () => {
    const { deps, lines } = makeDeps({
      states: [FIXTURE_DEFAULT, FIXTURE_STALE],
      alive: new Set([12345, 12346]),
    })
    const code = await runPs({ json: true }, deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(lines.length, 1, 'json mode emits one blob')
    const parsed = JSON.parse(lines[0]!) as PsJsonOutput
    assert.ok(Array.isArray(parsed.live))
    assert.ok(Array.isArray(parsed.stale))
    assert.strictEqual(parsed.live.length, 2)
    assert.strictEqual(parsed.stale.length, 2)
    const worker = parsed.live.find((r) => r.label === 'worker')!
    assert.strictEqual(worker.pid, 12345)
    assert.strictEqual(worker.port, null)
    assert.strictEqual(worker.instance, 'default')
    assert.strictEqual(worker.apiPort, 3001)
    assert.strictEqual(typeof worker.uptimeMs, 'number')
    assert.strictEqual(worker.uptimeMs, 5 * 60 * 1000)
    assert.strictEqual(worker.startedAt, '2026-04-27T11:55:00.000Z')
    const api = parsed.live.find((r) => r.label === 'api')!
    assert.strictEqual(api.port, 3001)
    // Stale rows have uptimeMs === null (PID not alive → unknown).
    const stale = parsed.stale.find((r) => r.pid === 99999)!
    assert.strictEqual(stale.uptimeMs, null)
    assert.strictEqual(stale.instance, 'old')
  })

  it('exits 0 even when nothing is tracked', async () => {
    const { deps, lines } = makeDeps({ states: [] })
    const code = await runPs({ json: true }, deps)
    assert.strictEqual(code, 0)
    const parsed = JSON.parse(lines[0]!) as PsJsonOutput
    assert.deepStrictEqual(parsed, { live: [], stale: [] })
  })

  it('treats malformed startedAt as uptime=null without throwing', async () => {
    const broken: InstanceState = {
      instance: 'default',
      apiPort: 3001,
      entries: [{ label: 'worker', pid: 1, startedAt: 'not-a-date' }],
    }
    const { deps, lines } = makeDeps({ states: [broken], alive: new Set([1]) })
    const code = await runPs({ json: true }, deps)
    assert.strictEqual(code, 0)
    const parsed = JSON.parse(lines[0]!) as PsJsonOutput
    assert.strictEqual(parsed.live[0]!.uptimeMs, null)
  })
})
