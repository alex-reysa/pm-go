/**
 * Tests for `pm-go status`. The interesting surface for this task is
 * the API health probe — the rest of the command (worker config print,
 * tctl listing) is covered tangentially through the foreign-service
 * test, which proves the gate fires before any tctl exec.
 *
 * ac-health-identity-3 (one of four cases here): a port held by a
 * non-pm-go service must yield exit 1 with the canonical
 * `[pm-go] port <port> is held by another service` first line, and
 * matching pm-go on `--port 3011` must succeed exactly as before.
 *
 * runStatus reads the port from `env.API_PORT`; there is no `--port`
 * argv flag for status, so tests set `env.API_PORT = '3011'` to mirror
 * the AC's wording.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runStatus, type StatusDeps } from '../status.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FakeStatusOpts {
  /**
   * Behavior of the `/health` probe.
   *   - 'pm-go' (default): valid identity envelope.
   *   - 'foreign': 200 with a body lacking the `service` field —
   *     simulates another service holding our port.
   *   - 'down': fetch throws (network error).
   */
  health?: 'pm-go' | 'foreign' | 'down'
  apiPort?: string
  /** tctl exec result. Defaults to 0 with empty stdout. */
  tctl?: { code: number; stdout?: string; stderr?: string } | 'throw'
  envOverrides?: Record<string, string | undefined>
}

interface Calls {
  fetchUrls: string[]
  execCommands: { cmd: string; args: readonly string[] }[]
}

function makeFakeStatus(opts: FakeStatusOpts = {}): {
  deps: StatusDeps
  lines: string[]
  calls: Calls
} {
  const lines: string[] = []
  const calls: Calls = {
    fetchUrls: [],
    execCommands: [],
  }
  const deps: StatusDeps = {
    exec: async (cmd, args) => {
      calls.execCommands.push({ cmd, args })
      if (opts.tctl === 'throw') {
        throw new Error('docker not found')
      }
      const r = opts.tctl ?? { code: 0, stdout: '', stderr: '' }
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    env: {
      API_PORT: opts.apiPort ?? '3001',
      ...opts.envOverrides,
    },
    fetch: (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      calls.fetchUrls.push(url)
      if (url.endsWith('/health')) {
        if (opts.health === 'down') {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
        }
        if (opts.health === 'foreign') {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        // Default: valid pm-go identity envelope.
        const port = Number(opts.apiPort ?? '3001')
        return new Response(
          JSON.stringify({
            service: 'pm-go-api',
            version: '0.8.6',
            instance: 'default',
            port,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('', { status: 404 })
    }) as StatusDeps['fetch'],
    write: (l) => lines.push(l),
    monorepoRoot: '/srv/proj',
  }
  return { deps, lines, calls }
}

// ---------------------------------------------------------------------------
// Smoke test — happy path on the default port prints the workflow header
// ---------------------------------------------------------------------------

describe('runStatus smoke', () => {
  it('matching pm-go on default port: exits 0, prints ✓ ok and workflow listing', async () => {
    const { deps, lines, calls } = makeFakeStatus({
      health: 'pm-go',
      tctl: { code: 0, stdout: '' },
    })
    const code = await runStatus(deps)
    assert.strictEqual(code, 0)
    const out = lines.join('\n')
    // The probe target was the canonical /health URL on the default port.
    assert.deepStrictEqual(calls.fetchUrls, ['http://localhost:3001/health'])
    // The status banner + happy-path probe line are both rendered.
    assert.match(out, /pm-go status/)
    assert.match(out, /http:\/\/localhost:3001\/health\s+✓ ok/)
    // Empty workflow list still surfaces the section header.
    assert.match(out, /Open workflows \(namespace=default\)/)
    assert.match(out, /\(no open workflows\)/)
  })

  it('matching pm-go on --port 3011: probe targets 3011 and ✓ ok renders', async () => {
    const { deps, lines, calls } = makeFakeStatus({
      health: 'pm-go',
      apiPort: '3011',
      tctl: { code: 0, stdout: '' },
    })
    const code = await runStatus(deps)
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls.fetchUrls, ['http://localhost:3011/health'])
    assert.match(lines.join('\n'), /http:\/\/localhost:3011\/health\s+✓ ok/)
  })
})

// ---------------------------------------------------------------------------
// ac-health-identity-3: foreign service must trigger an explicit exit 1
// ---------------------------------------------------------------------------

describe('runStatus identity probe (ac-health-identity-3)', () => {
  it('foreign service on /health: exits 1, prints prefix, skips workflow listing', async () => {
    const { deps, lines, calls } = makeFakeStatus({
      health: 'foreign',
      apiPort: '3001',
    })
    const code = await runStatus(deps)
    assert.strictEqual(code, 1)
    // The first `[pm-go] …` line of the structured error is anchored
    // to the AC's wording so dogfooders / docs / log scrapers can grep
    // for it. We assert the multiline-anchored prefix instead of a
    // strict-equal so future message body tweaks don't break the test.
    assert.match(
      lines.join('\n'),
      /^\[pm-go\] port 3001 is held by another service/m,
    )
    // Critically: status must NOT continue on to tctl after the gate
    // fires — that would print confusing output beneath the error.
    assert.strictEqual(calls.execCommands.length, 0)
    // And exactly one /health call (the identity probe), no follow-up
    // requests of any kind.
    assert.strictEqual(calls.fetchUrls.length, 1)
    assert.strictEqual(calls.fetchUrls[0], 'http://localhost:3001/health')
  })

  it('foreign service on --port 3011: prefix references the actual port', async () => {
    const { deps, lines, calls } = makeFakeStatus({
      health: 'foreign',
      apiPort: '3011',
    })
    const code = await runStatus(deps)
    assert.strictEqual(code, 1)
    // Port substitution in the prefix is what makes the message
    // greppable in multi-instance environments.
    assert.match(
      lines.join('\n'),
      /^\[pm-go\] port 3011 is held by another service/m,
    )
    assert.strictEqual(calls.execCommands.length, 0)
    assert.strictEqual(calls.fetchUrls[0], 'http://localhost:3011/health')
  })

  it('api down (network error): also short-circuits exit 1, no workflow listing', async () => {
    // probePmGoApi wraps both transport failures and JSON-shape
    // failures into PmGoIdentityMismatchError; status's gate treats
    // them uniformly. This test pins that contract so a future
    // refactor can't accidentally let the workflow listing run when
    // the API is unreachable.
    const { deps, lines, calls } = makeFakeStatus({ health: 'down' })
    const code = await runStatus(deps)
    assert.strictEqual(code, 1)
    assert.match(
      lines.join('\n'),
      /^\[pm-go\] port 3001 is held by another service/m,
    )
    assert.strictEqual(calls.execCommands.length, 0)
  })
})
