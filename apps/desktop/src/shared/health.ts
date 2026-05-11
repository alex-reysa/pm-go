/**
 * Health-envelope contract shared between main and renderer.
 *
 * The pm-go API answers its identity probe at `GET /health` with an
 * envelope whose `service` field is the literal `"pm-go-api"`. Every
 * downstream attach state in the desktop UI (connected, foreign
 * service, api_error, ...) hinges on whether that probe parses
 * cleanly into this shape. The guard MUST reject:
 *
 *   - The legacy `{ status: "ok" }` body (pre-v0.8.8 API, or any
 *     pre-identity-aware service that happens to answer `ok`).
 *   - Foreign envelopes like `{ ok: true }` from nginx welcome
 *     pages, unrelated dev servers, or another pm-go-adjacent
 *     service that happens to listen on the same port.
 *
 * The guard is intentionally pure: no fetch, no env reads. Callers
 * that already have a parsed JSON body in hand (e.g. the
 * `apiFetch` copy the desktop main process owns) feed it in
 * directly. The CLI counterpart lives at
 * `apps/cli/src/lib/api-client.ts` — keep the two in lock-step on
 * the required field set.
 */

/**
 * JSON envelope returned by the pm-go API's `GET /health` endpoint
 * once identity is wired (v0.8.8+). Earlier servers returned only
 * `{ status: "ok" }`; the guard below rejects that legacy shape so
 * an out-of-date API surface presents as `api_error`, not
 * `connected`.
 */
export interface HealthEnvelope {
  /** Always `"ok"` when the API decides to respond at all. */
  status: "ok";
  /** Fixed service tag — the load-bearing identity bit. */
  service: "pm-go-api";
  /** Human-readable build version, e.g. `"0.8.8.0"`. */
  version: string;
  /** Stable instance label so multi-instance setups are distinguishable. */
  instance: string;
  /** TCP port the API is actually bound to (post-`serve(...)`). */
  port: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for {@link HealthEnvelope}.
 *
 * Returns `true` only when every required field is present AND
 * `service === "pm-go-api"`. Returns `false` for:
 *
 *   - non-objects (`null`, arrays, primitives)
 *   - the legacy `{ status: "ok" }`-only body (missing `service`)
 *   - foreign payloads like `{ ok: true }`
 *   - envelopes whose `service` is anything other than `"pm-go-api"`
 *   - envelopes missing or wrong-typed `version` / `instance` / `port`
 *
 * The guard is deliberately conservative on `port`: `number` is not
 * enough, because a port that round-trips to `NaN` or `Infinity`
 * tells us the server is misconfigured rather than that the envelope
 * is acceptable. A non-integer `port` is rejected too.
 */
export function isPmGoHealthEnvelope(body: unknown): body is HealthEnvelope {
  if (!isPlainObject(body)) return false;
  if (body.status !== "ok") return false;
  if (body.service !== "pm-go-api") return false;
  if (typeof body.version !== "string") return false;
  if (typeof body.instance !== "string") return false;
  if (typeof body.port !== "number") return false;
  if (!Number.isFinite(body.port)) return false;
  if (!Number.isInteger(body.port)) return false;
  return true;
}
