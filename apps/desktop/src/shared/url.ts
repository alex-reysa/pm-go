/**
 * Base-URL normalization for the desktop's API client.
 *
 * Operators paste the API origin into a config field (or the M0
 * settings file), and we want them to be able to write any of:
 *
 *   `http://localhost:3001`
 *   `http://localhost:3001/`
 *   `  http://localhost:3001///  `
 *   `localhost:3001`
 *
 * ...and have all four normalize to the same canonical value so the
 * `apiFetch` helper can concatenate `${baseUrl}${path}` without
 * worrying about doubled or missing slashes. The TUI's `createApiClient`
 * does an equivalent `.replace(/\/+$/, "")` on the way in
 * (`apps/tui/src/lib/api.ts`); we centralize the rule here so the
 * desktop renderer + main process share one implementation, and
 * extend it with whitespace-trim + default-protocol handling.
 *
 * Pure — no fetch, no env. The output is suitable as both a config
 * key (the desktop persists it back to `userData/config.json`) and
 * a runtime base URL.
 */

/**
 * Normalize a user-supplied API base URL into the canonical form
 * `<scheme>://<host>[:<port>][<path-without-trailing-slash>]`.
 *
 * Rules:
 *
 *   1. Surrounding ASCII whitespace is trimmed.
 *   2. If the input contains no scheme (no `://`), `http://` is
 *      prepended. This is the right default for a local-first
 *      desktop tool that almost always talks to `localhost`; if
 *      operators need https they must write it explicitly.
 *   3. One or more trailing slashes are collapsed and stripped.
 *      The root path `http://host/` collapses to `http://host`
 *      so concatenation with `/plans` produces `http://host/plans`
 *      and not `http://host//plans`.
 *
 * Empty / whitespace-only input is returned as the empty string —
 * upstream config code can treat that as "user hasn't set a value
 * yet" and surface the `not_configured` attach state, rather than
 * silently defaulting to `http://`.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";

  // Scheme detection. We accept anything matching the URI standard's
  // scheme grammar (`[a-zA-Z][a-zA-Z0-9+\-.]*:`) followed by `//` —
  // strictly stricter than `indexOf("://")` because something like
  // `http: //foo` would otherwise sneak through. The pm-go API is
  // always http(s) in practice, so this also rejects nonsense like
  // `javascript://localhost`.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  // Trailing-slash strip. We DON'T parse via `new URL(...)` here:
  // the goal is to preserve the operator's intent verbatim (path
  // segments, query strings, ...) and only canonicalize the
  // trailing separator. `URL` would force-add a `/` after the
  // origin for a bare host, which then has to be stripped again —
  // an avoidable round-trip.
  return withScheme.replace(/\/+$/, "");
}
