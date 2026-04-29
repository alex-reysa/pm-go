import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertPmGoApi,
  probePmGoApi,
  PmGoIdentityMismatchError,
  type PmGoApiIdentity,
} from '../lib/api-client.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Reference URL used by every probe test. The port `3001` shows up
 * verbatim in the prefix assertion (`[pm-go] port 3001 ...`) so a
 * regression in port extraction would fail the prefix check loudly.
 */
const PROBE_URL = 'http://localhost:3001/health'

/** The stable greppable prefix every mismatch message must start with. */
const PORT_PREFIX = '[pm-go] port 3001 is held by another service'

/** Lifelike, valid identity envelope. */
const VALID_IDENTITY: PmGoApiIdentity = {
  service: 'pm-go-api',
  version: '0.8.6',
  instance: 'default',
  port: 3001,
}

// ---------------------------------------------------------------------------
// Fake fetch helpers — no real network, no real Response handling
// ---------------------------------------------------------------------------

/**
 * Build a `fetch` stub that returns a hand-crafted `Response` with
 * the supplied body / status. We use Node's built-in `Response`
 * (Node 22+) so the helper exercises the real `.text()` / `.ok`
 * surface that production fetch returns.
 */
function fetchReturning(opts: {
  status?: number
  statusText?: string
  body?: string
}): typeof globalThis.fetch {
  const { status = 200, statusText, body = '' } = opts
  const init: ResponseInit = statusText !== undefined
    ? { status, statusText }
    : { status }
  return (async () => new Response(body, init)) as typeof globalThis.fetch
}

/** A `fetch` stub that throws synchronously-async — i.e. the connection failed. */
function fetchThrowing(err: Error): typeof globalThis.fetch {
  return (async () => {
    throw err
  }) as typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// assertPmGoApi — pure validator (covers the missing/wrong-service branch)
// ---------------------------------------------------------------------------

describe('assertPmGoApi', () => {
  it('returns the typed identity when the body is a matching envelope', () => {
    const out = assertPmGoApi({ ...VALID_IDENTITY }, { url: PROBE_URL })
    assert.deepStrictEqual(out, VALID_IDENTITY)
  })

  it('throws PmGoIdentityMismatchError + [pm-go] port prefix when service is missing (ac-health-identity-4 ii)', () => {
    assert.throws(
      () =>
        assertPmGoApi(
          { version: '0.8.6', instance: 'default', port: 3001 },
          { url: PROBE_URL },
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof PmGoIdentityMismatchError,
          `expected PmGoIdentityMismatchError, got ${err?.constructor?.name}`,
        )
        assert.strictEqual(err.name, 'PmGoIdentityMismatchError')
        assert.strictEqual(
          err.message.split('\n')[0],
          PORT_PREFIX,
          'first line must be the stable greppable prefix',
        )
        assert.match(err.message, /missing required field `service`/)
        assert.strictEqual(err.url, PROBE_URL)
        return true
      },
    )
  })

  it('throws PmGoIdentityMismatchError + [pm-go] port prefix when service is wrong (ac-health-identity-4 iii)', () => {
    assert.throws(
      () =>
        assertPmGoApi(
          { service: 'nginx', version: '1.27', instance: 'default', port: 3001 },
          { url: PROBE_URL },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(
          err.message.startsWith(PORT_PREFIX),
          `message should start with ${PORT_PREFIX}, got ${JSON.stringify(err.message)}`,
        )
        assert.match(err.message, /service="pm-go-api"/)
        // The full body round-trip must show up in bodySnippet so a
        // grader downstream can identify the offender (nginx, here).
        assert.match(err.bodySnippet, /"service":"nginx"/)
        return true
      },
    )
  })

  // The remaining "missing/mistyped" branches are not in the AC's
  // six-case list but they share the throw path; cover them so a
  // future refactor that drops a branch fails loudly.

  it('throws when version is missing', () => {
    assert.throws(
      () =>
        assertPmGoApi(
          { service: 'pm-go-api', instance: 'default', port: 3001 },
          { url: PROBE_URL },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(err.message.startsWith(PORT_PREFIX))
        assert.match(err.message, /version/)
        return true
      },
    )
  })

  it('throws when instance is the wrong type', () => {
    assert.throws(
      () =>
        assertPmGoApi(
          { service: 'pm-go-api', version: '0.8.6', instance: 42, port: 3001 },
          { url: PROBE_URL },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(err.message.startsWith(PORT_PREFIX))
        assert.match(err.message, /instance/)
        return true
      },
    )
  })

  it('throws when port is a string', () => {
    assert.throws(
      () =>
        assertPmGoApi(
          { service: 'pm-go-api', version: '0.8.6', instance: 'default', port: '3001' },
          { url: PROBE_URL },
        ),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(err.message.startsWith(PORT_PREFIX))
        return true
      },
    )
  })

  it('throws when body is null / non-object', () => {
    for (const body of [null, 'pm-go', 42, ['pm-go']]) {
      assert.throws(
        () => assertPmGoApi(body, { url: PROBE_URL }),
        (err: unknown) => {
          assert.ok(err instanceof PmGoIdentityMismatchError)
          assert.ok(err.message.startsWith(PORT_PREFIX))
          return true
        },
      )
    }
  })

  it('truncates bodySnippet to 200 chars', () => {
    // Build a body whose JSON serialisation is > 200 chars by
    // padding `instance` with a long string. service is wrong so
    // we hit the throw path.
    const longBody = {
      service: 'nginx',
      version: '1',
      instance: 'x'.repeat(400),
      port: 3001,
    }
    assert.throws(
      () => assertPmGoApi(longBody, { url: PROBE_URL }),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.strictEqual(err.bodySnippet.length, 200)
        return true
      },
    )
  })

  it('is pure: never invokes a fetch (no fetch param exists)', () => {
    // Type-level guarantee: `assertPmGoApi.length` is the count of
    // declared params, which is 2 (`body`, `ctx`). No `fetch`.
    assert.strictEqual(assertPmGoApi.length, 2)
  })
})

// ---------------------------------------------------------------------------
// probePmGoApi — covers matching, malformed JSON, HTTP non-2xx, network error
// ---------------------------------------------------------------------------

describe('probePmGoApi', () => {
  it('returns the identity when the API responds with a matching envelope (ac-health-identity-4 i)', async () => {
    const fetchImpl = fetchReturning({ body: JSON.stringify(VALID_IDENTITY) })
    const id = await probePmGoApi(fetchImpl, PROBE_URL)
    assert.deepStrictEqual(id, VALID_IDENTITY)
  })

  it('throws PmGoIdentityMismatchError + [pm-go] port prefix on malformed JSON (ac-health-identity-4 iv)', async () => {
    const fetchImpl = fetchReturning({ body: 'not-json{' })
    await assert.rejects(
      () => probePmGoApi(fetchImpl, PROBE_URL),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.strictEqual(err.name, 'PmGoIdentityMismatchError')
        assert.ok(
          err.message.startsWith(PORT_PREFIX),
          `message should start with ${PORT_PREFIX}, got ${JSON.stringify(err.message)}`,
        )
        assert.match(err.message, /not valid JSON/)
        // The raw bytes the API returned must be in the snippet so
        // an operator can identify "oh, that's an HTML error page".
        assert.match(err.bodySnippet, /not-json\{/)
        return true
      },
    )
  })

  it('throws PmGoIdentityMismatchError + [pm-go] port prefix on HTTP non-2xx (ac-health-identity-4 v)', async () => {
    const fetchImpl = fetchReturning({
      status: 503,
      statusText: 'Service Unavailable',
      body: '<html>upstream down</html>',
    })
    await assert.rejects(
      () => probePmGoApi(fetchImpl, PROBE_URL),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(err.message.startsWith(PORT_PREFIX))
        // Status + body are surfaced so the operator can see both
        // the HTTP code and what nginx (or whatever) actually said.
        assert.match(err.message, /HTTP 503/)
        assert.match(err.bodySnippet, /upstream down/)
        return true
      },
    )
  })

  it('throws PmGoIdentityMismatchError + [pm-go] port prefix on a non-fetch network error (ac-health-identity-4 vi)', async () => {
    // ECONNREFUSED is the most common case in pm-go: the supervisor
    // isn't running on the configured port. Any thrown error here
    // must be wrapped with the same typed prefix.
    const fetchImpl = fetchThrowing(new Error('connect ECONNREFUSED 127.0.0.1:3001'))
    await assert.rejects(
      () => probePmGoApi(fetchImpl, PROBE_URL),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.strictEqual(err.name, 'PmGoIdentityMismatchError')
        assert.ok(err.message.startsWith(PORT_PREFIX))
        assert.match(err.message, /network error/)
        assert.match(err.message, /ECONNREFUSED/)
        // No body was ever read because no response arrived.
        assert.strictEqual(err.bodySnippet, '')
        return true
      },
    )
  })

  it('rejects a 2xx body that is valid JSON but the wrong service (chains through assertPmGoApi)', async () => {
    const fetchImpl = fetchReturning({
      body: JSON.stringify({ service: 'nginx', version: '1', instance: 'd', port: 3001 }),
    })
    await assert.rejects(
      () => probePmGoApi(fetchImpl, PROBE_URL),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.ok(err.message.startsWith(PORT_PREFIX))
        return true
      },
    )
  })

  it('uses the provided URL on the error (no real network)', async () => {
    const otherUrl = 'http://example.test:9999/health'
    const fetchImpl = fetchThrowing(new Error('boom'))
    await assert.rejects(
      () => probePmGoApi(fetchImpl, otherUrl),
      (err: unknown) => {
        assert.ok(err instanceof PmGoIdentityMismatchError)
        assert.strictEqual(err.url, otherUrl)
        // Port in prefix reflects the new URL, not the default.
        assert.match(err.message, /^\[pm-go\] port 9999 is held by another service/)
        return true
      },
    )
  })
})
