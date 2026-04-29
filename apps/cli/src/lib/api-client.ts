/**
 * pm-go API identity probe.
 *
 * Phase-1 CLI commands (status / drive / why / recover / run /
 * implement) all hit the same JSON identity endpoint to confirm the
 * thing answering on the configured port is *our* API and not, say,
 * a stray nginx, an unrelated dev server, or another pm-go instance
 * that happened to claim port 3001 first. Without an identity check
 * the CLI would silently drive against whatever speaks HTTP on
 * 3001 and surface confusing downstream errors when `/plans` or
 * `/health` returns a body it doesn't recognise. With it, every
 * mismatch is converted to a single typed
 * `PmGoIdentityMismatchError` whose first line begins with the
 * stable, machine-greppable string
 *
 *   `[pm-go] port <port> is held by another service`
 *
 * Operators (and CI) can grep for that prefix to fail fast on a
 * mis-pointed host. The remainder of the message gives them the URL
 * that was probed, the raw body truncated to 200 chars, and a
 * one-line remediation: `use --port <other> or stop the conflicting
 * process`.
 *
 * The module is intentionally lib-level — a pure validator
 * (`assertPmGoApi`) plus a thin fetch wrapper (`probePmGoApi`),
 * with no commands, no env reads, and no top-level I/O. That keeps
 * it free of circular-dep risk so every phase-1 command can import
 * it. `assertPmGoApi` is the half that gets reused inside callers
 * that already have a parsed body in hand; `probePmGoApi` is the
 * half that handles HTTP, JSON, and network plumbing.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON envelope a pm-go API must return on its
 * identity probe. `service` is fixed as the literal `"pm-go-api"`;
 * `version` / `instance` / `port` are typed but otherwise opaque to
 * this helper — callers display them in human-readable status
 * output but do not parse them further here.
 */
export interface PmGoApiIdentity {
  service: 'pm-go-api'
  version: string
  instance: string
  port: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One-line remediation appended to every mismatch message. */
const REMEDIATION = 'use --port <other> or stop the conflicting process'

/**
 * Maximum number of raw-body characters surfaced in the error
 * message. Operators want enough to recognise the offending service
 * (e.g. an nginx welcome page) but not so much that the message
 * floods the terminal. 200 is the spec-mandated cap.
 */
const BODY_SNIPPET_MAX = 200

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown whenever the probe target either fails to answer or
 * answers with something that is not a pm-go identity envelope.
 * `name` is set explicitly so structured logging keeps the class
 * label across `JSON.stringify` and so callers using a duck-type
 * `err.name === 'PmGoIdentityMismatchError'` check still work in
 * environments where `instanceof` crosses a realm boundary
 * (e.g. tests that re-import the module).
 */
export class PmGoIdentityMismatchError extends Error {
  readonly url: string
  /** Raw response body (or empty string for network errors), truncated to 200 chars. */
  readonly bodySnippet: string

  constructor(message: string, url: string, bodySnippet: string) {
    super(message)
    this.name = 'PmGoIdentityMismatchError'
    this.url = url
    this.bodySnippet = bodySnippet
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — message construction
// ---------------------------------------------------------------------------

function truncateBody(s: string): string {
  if (s.length <= BODY_SNIPPET_MAX) return s
  return s.slice(0, BODY_SNIPPET_MAX)
}

/**
 * Stringify an arbitrary parsed body into something safe for the
 * snippet field. Strings pass through; everything else round-trips
 * via `JSON.stringify`. If even that throws (circular refs, BigInt)
 * we fall back to `String(v)` so the error is always emittable.
 */
function bodyToSnippet(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * Extract the TCP port from a probe URL for the `[pm-go] port
 * <port> ...` prefix. We prefer the explicit port; if the URL
 * omitted one we fall back to the protocol default. Anything we
 * can't parse becomes the literal `<unknown>` placeholder so the
 * error message is always emittable — failing to surface the error
 * because we couldn't extract a port would defeat the purpose.
 */
function portForUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.port !== '') return u.port
    if (u.protocol === 'http:') return '80'
    if (u.protocol === 'https:') return '443'
    return '<unknown>'
  } catch {
    return '<unknown>'
  }
}

/**
 * Build the multi-line error message. The first line is the stable
 * greppable prefix; subsequent lines surface the URL probed, the
 * raw body, the one-line remediation, and the specific failure
 * detail so a reviewer reading it knows *why* the body was rejected
 * (missing field vs. wrong service vs. malformed JSON).
 */
function buildMessage(url: string, detail: string, bodySnippet: string): string {
  return [
    `[pm-go] port ${portForUrl(url)} is held by another service`,
    `  url:    ${url}`,
    `  body:   ${bodySnippet === '' ? '(empty)' : bodySnippet}`,
    `  fix:    ${REMEDIATION}`,
    `  detail: ${detail}`,
  ].join('\n')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(url: string, detail: string, snippet: string): never {
  throw new PmGoIdentityMismatchError(
    buildMessage(url, detail, snippet),
    url,
    snippet,
  )
}

// ---------------------------------------------------------------------------
// assertPmGoApi — pure validator
// ---------------------------------------------------------------------------

/**
 * Validate that `body` is the JSON envelope produced by the pm-go
 * API's identity endpoint. Returns the typed identity on success;
 * throws `PmGoIdentityMismatchError` on any shape mismatch with
 * the original body re-stringified into the error's `bodySnippet`.
 *
 * Strictly pure: no fetch, no env reads, no clock. Callers that
 * already have a parsed body in hand (e.g. they share an HTTP
 * client across endpoints) reuse this directly without going
 * through `probePmGoApi`.
 */
export function assertPmGoApi(
  body: unknown,
  ctx: { url: string },
): PmGoApiIdentity {
  const { url } = ctx
  const snippet = truncateBody(bodyToSnippet(body))

  if (!isPlainObject(body)) {
    fail(url, 'response body was not a JSON object', snippet)
  }

  // service: required + literal "pm-go-api".
  if (!('service' in body) || body.service === undefined) {
    fail(url, 'response body is missing required field `service`', snippet)
  }
  if (body.service !== 'pm-go-api') {
    fail(
      url,
      `expected service="pm-go-api" but got service=${JSON.stringify(body.service)}`,
      snippet,
    )
  }

  // version: required + string.
  if (typeof body.version !== 'string') {
    fail(
      url,
      body.version === undefined
        ? 'response body is missing required field `version`'
        : 'response body field `version` must be a string',
      snippet,
    )
  }

  // instance: required + string.
  if (typeof body.instance !== 'string') {
    fail(
      url,
      body.instance === undefined
        ? 'response body is missing required field `instance`'
        : 'response body field `instance` must be a string',
      snippet,
    )
  }

  // port: required + finite integer. We reject non-integers and
  // NaN/Infinity even though they're typeof 'number' — a port that
  // round-trips to NaN tells us the API is misconfigured, not that
  // the envelope is acceptable.
  if (
    typeof body.port !== 'number' ||
    !Number.isFinite(body.port) ||
    !Number.isInteger(body.port)
  ) {
    fail(
      url,
      body.port === undefined
        ? 'response body is missing required field `port`'
        : 'response body field `port` must be a finite integer',
      snippet,
    )
  }

  return {
    service: 'pm-go-api',
    version: body.version,
    instance: body.instance,
    port: body.port,
  }
}

// ---------------------------------------------------------------------------
// probePmGoApi — thin fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch `url` and validate that the response is a pm-go identity
 * envelope. Every failure mode (non-fetch network error, HTTP
 * non-2xx, malformed JSON, identity mismatch) is converted into a
 * single `PmGoIdentityMismatchError` with the
 * `[pm-go] port <port> ...` prefix so callers downstream just need
 * one catch arm.
 *
 * The `fetch` impl is injected so tests can stub it without
 * touching the network. In production callers pass
 * `globalThis.fetch`. The wrapper does not set timeouts or signals
 * — that's the caller's job, because the right timeout depends on
 * whether this is being called from `pm-go status` (snappy) or from
 * `pm-go run`'s pre-flight (more generous).
 */
export async function probePmGoApi(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<PmGoApiIdentity> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (err) {
    // No response, no body — bodySnippet is empty. The detail
    // carries the underlying network error message so an operator
    // can distinguish ECONNREFUSED from a DNS failure.
    fail(
      url,
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      '',
    )
  }

  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch (err) {
    fail(
      url,
      `failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
      '',
    )
  }
  const snippet = truncateBody(bodyText)

  if (!res.ok) {
    const statusLine = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
    fail(url, statusLine, snippet)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch (err) {
    fail(
      url,
      `response body is not valid JSON: ${(err as Error).message}`,
      snippet,
    )
  }

  return assertPmGoApi(parsed, { url })
}
