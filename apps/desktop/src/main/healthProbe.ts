/**
 * Identity-aware `/health` probe for the desktop attach loop.
 *
 * This is the single classification surface that maps a network
 * call's outcome onto the phase-0 {@link AttachState} terminal
 * variants. The mapping is deliberately tight — see the inline
 * cases — so a regression that loosens any branch (e.g. accepting
 * a non-`pm-go-api` envelope as `connected`) fails the Vitest
 * suite under `test/main/healthProbe.test.ts` loudly.
 *
 * Pure module: no `electron` import, no `fs`, no global state. The
 * `fetch` impl and timeout are injectable so tests don't have to
 * spin up an HTTP server. The default `fetch` is the platform
 * global (Node 18+ / Electron 33+ both ship `globalThis.fetch`).
 *
 * Lives in `src/main/` — the renderer must NEVER call this
 * directly. The renderer routes through the `health:probe` IPC
 * channel via the preload bridge so the network surface stays in
 * the main process where Chromium's renderer sandbox can't see
 * Node APIs.
 */

import type { AttachState } from "../shared/attachState.js";
import { isPmGoHealthEnvelope, type HealthEnvelope } from "../shared/health.js";
import { normalizeBaseUrl } from "../shared/url.js";

/**
 * Default wall-clock timeout for a single `/health` probe.
 *
 * 5 seconds is long enough to absorb a cold-start API on a loaded
 * laptop without making the attach UI feel frozen. The attach loop
 * is expected to call this at intervals (phase 1 wires the cadence);
 * a hung probe must not stall the renderer.
 */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Discriminated-union result returned by {@link runHealthProbe}.
 *
 * Each `state` is a terminal {@link AttachState} variant. The
 * transient `probing` and `not_configured` states are NOT produced
 * here — those are owned by the caller (phase 1's attach state
 * machine), which decides when to drop into `probing` before
 * dispatching this call.
 *
 * - `api_unreachable`: fetch rejected at the network layer
 *   (DNS, ECONNREFUSED, aborted by timeout, JSON-not-an-object,
 *   anything that prevents an HTTP response from arriving at all).
 * - `api_error`:      the API responded but with a non-2xx status.
 *   `httpStatus` is preserved for diagnostics / log lines.
 * - `foreign_service`: the response was 2xx but the body did not
 *   satisfy {@link isPmGoHealthEnvelope}. This catches `{ ok: true }`,
 *   the legacy `{ status: "ok" }`-only body, an nginx welcome page,
 *   or any non-pm-go service on the same port.
 * - `connected`:      the response was 2xx and the body is a
 *   genuine pm-go `/health` envelope. The full envelope is
 *   returned so callers can surface `version` / `instance` in the
 *   UI without re-fetching.
 */
export type HealthProbeResult =
  | { state: Extract<AttachState, "api_unreachable"> }
  | { state: Extract<AttachState, "api_error">; httpStatus: number }
  | { state: Extract<AttachState, "foreign_service"> }
  | {
      state: Extract<AttachState, "connected">;
      envelope: HealthEnvelope;
    };

/**
 * Options bag for {@link runHealthProbe}. Both fields are optional;
 * production code calls `runHealthProbe(baseUrl)` and tests inject a
 * mock `fetch` + a small `timeoutMs` so they don't have to wait the
 * default 5 seconds for an abort path.
 */
export interface RunHealthProbeOptions {
  /** Injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Abort timeout in milliseconds. Defaults to {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Run a single identity-aware probe against `${baseUrl}/health` and
 * classify the outcome into the {@link HealthProbeResult} union.
 *
 * The base URL is run through {@link normalizeBaseUrl} first so a
 * trailing slash or missing scheme is handled the same way it would
 * be by the config store. A normalized empty string (e.g. the
 * operator hasn't configured anything yet) produces a request to
 * `/health` against no host — `fetch` rejects and we report
 * `api_unreachable`. Callers should ideally short-circuit on the
 * `not_configured` attach state before reaching here, but the
 * fallback is safe.
 */
export async function runHealthProbe(
  baseUrl: string,
  options: RunHealthProbeOptions = {},
): Promise<HealthProbeResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const normalized = normalizeBaseUrl(baseUrl);
  const url = `${normalized}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch {
    // Anything that prevents an HTTP response — DNS, ECONNREFUSED,
    // timeout, fetch impl missing, generic AbortError — collapses to
    // the same operator-facing remediation: "the API isn't reachable
    // at this URL". We deliberately don't try to peek at the error
    // type and split this further; the UI only ever needs to know
    // "probe didn't make it to a server", and richer diagnostics
    // belong in a log line, not in the AttachState.
    return { state: "api_unreachable" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { state: "api_error", httpStatus: response.status };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 2xx but non-JSON body (e.g. nginx HTML welcome page on the
    // same port). That's the textbook `foreign_service` signal —
    // the host is up and answering, just not with a pm-go envelope.
    return { state: "foreign_service" };
  }

  if (isPmGoHealthEnvelope(body)) {
    return { state: "connected", envelope: body };
  }

  return { state: "foreign_service" };
}
