/**
 * Renderer attach-state machine.
 *
 * The desktop's "is the API up?" indicator is driven by a small,
 * pure state machine. Pulling the transition logic out into a
 * standalone module lets us unit-test the full state matrix without
 * React, JSX, or any DOM environment — Vitest hits this file
 * directly. The React component
 * ({@link import("./AttachScreen.js").AttachScreen}) is a thin
 * wrapper that pipes user input + bridge results into {@link reduce}
 * and renders the resulting {@link AttachContext}.
 *
 * The states themselves are the six values of {@link AttachState}
 * (see `../shared/attachState.ts`). This file ONLY encodes the
 * transitions; the user-visible labels live in
 * `ATTACH_STATE_LABELS` so adding a new state is a single edit
 * there plus a `reduce` case here.
 */

import type { AttachState } from "../shared/attachState.js";
import type { Config } from "../shared/config.js";
import type { HealthEnvelope } from "../shared/health.js";
import type { PmGoDesktopBridge } from "./bridge.js";

/**
 * The full context the renderer carries about its attach status.
 *
 *   - `state`: the active {@link AttachState}; drives the UI label
 *     and which controls are enabled.
 *   - `baseUrl`: the last-known API base URL the operator typed
 *     into the inline settings input. We mirror it in the reducer
 *     (not just in component-local state) so a retry from a failure
 *     state can re-probe without re-reading config.
 *   - `envelope`: the last successful identity envelope. Non-null
 *     iff `state === "connected"`. The post-attach placeholder
 *     route gates on this — it renders only when the envelope is
 *     present, which guarantees `foreign_service` (2xx but wrong
 *     body) can NEVER fall through to the dashboard even if a
 *     stale `connected` state were to leak through.
 */
export interface AttachContext {
  readonly state: AttachState;
  readonly baseUrl: string;
  readonly envelope: HealthEnvelope | null;
}

/**
 * Events that the renderer (or the bridge wrapper {@link runProbe})
 * dispatches into the state machine. Keep the union flat and
 * discriminated so the reducer's `switch` is exhaustive — TS's
 * `noUncheckedIndexedAccess` + the never-fallthrough check together
 * mean a forgotten event surfaces as a compile error.
 */
export type AttachEvent =
  /** A probe is about to start; transition out of any terminal state into `probing`. */
  | { type: "probe_start" }
  /** Probe came back with a valid pm-go-api envelope. */
  | { type: "probe_connected"; envelope: HealthEnvelope }
  /** Network-layer failure (DNS, ECONNREFUSED, timeout). */
  | { type: "probe_unreachable" }
  /** HTTP 2xx but the body is not a pm-go envelope (`isPmGoHealthEnvelope` rejected it). */
  | { type: "probe_foreign" }
  /** HTTP non-2xx, or any reachable-but-broken pm-go-api response. */
  | { type: "probe_api_error" }
  /**
   * The operator typed a new base URL into the settings input.
   * Empty string ⇒ `not_configured`; non-empty ⇒ `probing`
   * (assuming a follow-up probe is dispatched). The reducer drops
   * the envelope on any base-URL change — a new server is not the
   * old server.
   */
  | { type: "set_base_url"; baseUrl: string }
  /**
   * Retry from a failure state. No-op when the base URL is empty
   * (you can't probe nothing); transitions to `probing` otherwise.
   * The component layer is responsible for issuing the actual
   * `runProbe` call after dispatching.
   */
  | { type: "retry" };

/**
 * Build the initial context from a parsed config. Called once on
 * mount.
 *
 *   - Empty `apiBaseUrl` ⇒ stay in `not_configured` (the UI shows
 *     the settings input + an "Apply" button, no probe is issued).
 *   - Non-empty `apiBaseUrl` ⇒ start in `probing`. The component
 *     layer is responsible for kicking off the actual probe in a
 *     `useEffect`; the reducer only encodes the intent.
 */
export function initialContext(config: Config): AttachContext {
  return {
    state: config.apiBaseUrl === "" ? "not_configured" : "probing",
    baseUrl: config.apiBaseUrl,
    envelope: null,
  };
}

/**
 * Pure transition function. Every code path returns a fresh
 * `AttachContext`; no in-place mutation, no side effects.
 *
 * Notes on edge cases:
 *
 *   - `probe_*` events are accepted from ANY state. That's
 *     deliberate: a retry-from-failure dispatches `probe_start`,
 *     then later `probe_connected` (or another terminal). We don't
 *     guard "only from probing" because the React component is the
 *     sole dispatcher and won't fire a stray success.
 *   - `set_base_url` ALWAYS clears the envelope. A new URL means
 *     the old identity is stale until proven otherwise. This is
 *     what stops a `connected → set_base_url → connected (still
 *     showing old envelope)` race from leaking a wrong identity
 *     into the post-attach route.
 *   - `retry` with an empty `baseUrl` is a no-op (returns the same
 *     ctx reference unchanged). The component layer should still
 *     not render a retry button in that case; this is a belt-and-
 *     -suspenders guard.
 */
export function reduce(ctx: AttachContext, event: AttachEvent): AttachContext {
  switch (event.type) {
    case "probe_start":
      return { state: "probing", baseUrl: ctx.baseUrl, envelope: null };
    case "probe_connected":
      return {
        state: "connected",
        baseUrl: ctx.baseUrl,
        envelope: event.envelope,
      };
    case "probe_unreachable":
      return { state: "api_unreachable", baseUrl: ctx.baseUrl, envelope: null };
    case "probe_foreign":
      return { state: "foreign_service", baseUrl: ctx.baseUrl, envelope: null };
    case "probe_api_error":
      return { state: "api_error", baseUrl: ctx.baseUrl, envelope: null };
    case "set_base_url":
      return {
        state: event.baseUrl === "" ? "not_configured" : "probing",
        baseUrl: event.baseUrl,
        envelope: null,
      };
    case "retry":
      if (ctx.baseUrl === "") return ctx;
      return { state: "probing", baseUrl: ctx.baseUrl, envelope: null };
  }
}

/**
 * Bridge-driven probe wrapper. Calls `bridge.probeHealth()` exactly
 * once, then dispatches the matching {@link AttachEvent} into the
 * reducer. Pulled out as a free function (not embedded in the
 * component) so tests can drive it with a hand-rolled mock bridge
 * and assert the exact event sequence — no React, no rendering, no
 * `act()` ceremony.
 *
 * Failure modes: if the bridge itself throws (e.g. the preload was
 * never wired up, `window.pmGoDesktop` is undefined), we surface
 * that as `probe_api_error`. The renderer NEVER lets a thrown
 * bridge call propagate out of the probe pipeline — that would
 * leave the UI stuck in `probing` forever.
 */
export async function runProbe(
  bridge: PmGoDesktopBridge,
  dispatch: (event: AttachEvent) => void,
): Promise<void> {
  dispatch({ type: "probe_start" });
  let result;
  try {
    result = await bridge.probeHealth();
  } catch {
    dispatch({ type: "probe_api_error" });
    return;
  }
  switch (result.kind) {
    case "connected":
      dispatch({ type: "probe_connected", envelope: result.envelope });
      return;
    case "api_unreachable":
      dispatch({ type: "probe_unreachable" });
      return;
    case "foreign_service":
      dispatch({ type: "probe_foreign" });
      return;
    case "api_error":
      dispatch({ type: "probe_api_error" });
      return;
  }
}
