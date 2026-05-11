/**
 * Attach state machine — shared vocabulary for "is the desktop
 * actually talking to a pm-go API right now?"
 *
 * The UI renders a small indicator (chip, status bar entry, modal
 * blocker — phase 1 decides which) keyed on these states. Keeping
 * the union + label map here means the renderer, the main process's
 * health-probe loop, and any test harness all agree on the same
 * vocabulary, and a misspelled state becomes a compile error.
 *
 * State transitions are NOT encoded here — that's a phase-1
 * concern. M0 ships the alphabet only.
 */

/**
 * The full set of states the desktop's "attach to API" loop can
 * occupy. Order is roughly the natural progression from launch
 * (`not_configured` / `probing`) toward terminal states (`connected`
 * vs. one of the three error variants).
 *
 *   - `not_configured`: operator has not set `apiBaseUrl` yet
 *     (empty string, or first launch). UI should prompt for config.
 *   - `probing`: a health request is in flight. Transient.
 *   - `connected`: last probe returned a valid {@link
 *     import("./health.js").HealthEnvelope } with
 *     `service === "pm-go-api"`.
 *   - `api_unreachable`: probe failed at the network layer
 *     (ECONNREFUSED, DNS, timeout). The host might be down, or the
 *     URL might point at nothing.
 *   - `foreign_service`: probe completed HTTP-wise but the body
 *     was NOT a pm-go envelope (legacy `{ status: "ok" }`, an nginx
 *     welcome page, a different microservice on the same port).
 *     Distinguishing this from `api_unreachable` matters because
 *     the remediation is different: ask the operator to point at
 *     the correct port, not to start their API.
 *   - `api_error`: the API answered, identified itself, but
 *     returned a non-2xx status, or threw on a follow-up request.
 *     Reachable + correct service, but unhealthy.
 */
export type AttachState =
  | "not_configured"
  | "probing"
  | "connected"
  | "api_unreachable"
  | "foreign_service"
  | "api_error";

/**
 * Human-readable labels for {@link AttachState}, suitable for
 * direct rendering in a status chip or log line. Keep these short
 * — the chip typography in phase 1 is tight. Longer remediation
 * copy lives next to the UI component that renders the state, not
 * here.
 *
 * Declared `as const` + `Record<AttachState, string>` so every new
 * state added to the union forces an entry here at compile time.
 */
export const ATTACH_STATE_LABELS: Record<AttachState, string> = {
  not_configured: "Not configured",
  probing: "Connecting…",
  connected: "Connected",
  api_unreachable: "API unreachable",
  foreign_service: "Foreign service on port",
  api_error: "API error",
} as const;
