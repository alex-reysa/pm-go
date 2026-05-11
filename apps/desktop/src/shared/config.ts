/**
 * Desktop-local config schema.
 *
 * The desktop process owns its own configuration file, persisted at
 * `app.getPath('userData')/config.json` (per the M0 README). The
 * shape is deliberately minimal at this stage: only the
 * `apiBaseUrl` matters for the attach state machine. Phase 1 grows
 * this with telemetry opt-in, theme, and recent-plan history.
 *
 * Schema + parser live here (and not in the orchestrator-side
 * `@pm-go/contracts` package) because the desktop config is a
 * *local-only* concern. The server has no business knowing the
 * operator's chosen API base URL, and we don't want a contracts
 * bump every time we add a desktop UI preference. If a config field
 * ever does need to cross the wire, it gets promoted into
 * `@pm-go/contracts` at that point.
 */

import { normalizeBaseUrl } from "./url.js";

/** Default API base URL — matches the API's default bind port (3001). */
export const DEFAULT_API_BASE_URL = "http://localhost:3001";

/**
 * The full desktop config. Every field is required in the parsed
 * form; the parser fills in defaults for fields missing from the
 * on-disk JSON so callers never have to deal with `undefined`.
 */
export interface Config {
  /**
   * Canonical, normalized base URL of the pm-go API the desktop
   * should attach to. Empty string is the sentinel for "operator
   * hasn't pasted a value yet" — that lights up the
   * `not_configured` attach state in the UI.
   */
  apiBaseUrl: string;
}

/**
 * Default Config. Returned by `parseConfig` when the on-disk file
 * is missing/empty, and used by the M0 scaffold so first-launch
 * always has something sane to render against.
 */
export const DEFAULT_CONFIG: Config = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an unknown blob (typically `JSON.parse(<file contents>)`)
 * into a {@link Config}. The parser is forgiving: a missing or
 * wrong-shaped field falls back to its default rather than
 * throwing. The desktop should be resilient to a partially-written
 * config file (e.g. a crash mid-save) — there's no value in
 * refusing to launch over a malformed preference.
 *
 * `apiBaseUrl` is run through {@link normalizeBaseUrl} so the
 * canonical form is what every downstream consumer sees,
 * regardless of how it was written to disk.
 */
export function parseConfig(value: unknown): Config {
  if (!isPlainObject(value)) return { ...DEFAULT_CONFIG };
  const rawBaseUrl =
    typeof value.apiBaseUrl === "string" ? value.apiBaseUrl : DEFAULT_API_BASE_URL;
  return {
    apiBaseUrl: normalizeBaseUrl(rawBaseUrl),
  };
}
