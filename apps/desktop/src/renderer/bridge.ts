/**
 * Renderer-side type declarations for the `window.pmGoDesktop`
 * bridge that the preload script exposes via
 * `contextBridge.exposeInMainWorld(...)`.
 *
 * The renderer is a context-isolated Chromium process: it has NO
 * direct access to Node built-ins, no raw IPC, no `require`, no
 * `fs`. Every call into the main process has to go through a
 * narrow, typed surface that the preload script publishes. This
 * file declares that surface so:
 *
 *   - the renderer can call `window.pmGoDesktop.probeHealth()` with
 *     type-checking, instead of poking at an untyped `any`, and
 *   - the type system enforces that no renderer code is reaching for
 *     bridge methods that don't exist on the preload side.
 *
 * The *implementation* of the bridge lives in the preload entrypoint
 * (sibling task). This file is renderer-only: it never imports from
 * `../main` or `../preload`, only from the shared phase-0 contracts.
 * Keeping the contract here means a renderer test can mock
 * `pmGoDesktop` by hand without dragging Electron into the test
 * harness.
 */

import type { Config } from "../shared/config.js";
import type { HealthEnvelope } from "../shared/health.js";

/**
 * Discriminated union returned by {@link PmGoDesktopBridge.probeHealth}.
 *
 * The renderer never performs the `/health` fetch itself — Electron's
 * fetch CORS rules and the renderer's strict CSP make that a fight
 * not worth having. Instead, the main process owns the fetch loop
 * and reports a *classification* of the last response back across the
 * bridge. The four `kind` values map 1:1 onto the four non-trivial
 * attach states (`connected`, `api_unreachable`, `foreign_service`,
 * `api_error`); `not_configured` and `probing` are renderer-local
 * states that don't need a bridge variant.
 */
export type ProbeResult =
  | {
      kind: "connected";
      /** The parsed, validated identity envelope. */
      envelope: HealthEnvelope;
    }
  | {
      kind: "api_unreachable";
      /** Best-effort short message for logs (e.g. `ECONNREFUSED`). */
      message?: string;
    }
  | {
      kind: "foreign_service";
      /**
       * The HTTP status returned by the foreign server, when known.
       * Not load-bearing for state selection (any 2xx-with-wrong-body
       * is `foreign_service`) — kept for the eventual diagnostics
       * panel.
       */
      status?: number;
    }
  | {
      kind: "api_error";
      /** HTTP status (5xx, or any non-2xx from a service that *is* pm-go-api). */
      status?: number;
    };

/**
 * The narrow surface the preload script exposes to the renderer via
 * `contextBridge.exposeInMainWorld("pmGoDesktop", ...)`. The renderer
 * MUST NOT assume any methods beyond these — adding a method here
 * without a matching preload entry will fail at runtime when the
 * renderer calls it.
 */
export interface PmGoDesktopBridge {
  /**
   * Read the persisted desktop config (the same {@link Config}
   * produced by `parseConfig`). The main process owns the on-disk
   * `config.json`; the renderer treats this as the source of truth on
   * mount.
   */
  getConfig(): Promise<Config>;
  /**
   * Persist a new API base URL and re-probe. The returned `Config`
   * reflects the post-normalization value (`normalizeBaseUrl` runs in
   * main, not the renderer). The renderer is responsible for issuing
   * the follow-up `probeHealth()` call on its own — `setApiBaseUrl`
   * does not auto-probe so the state machine stays in renderer hands.
   */
  setApiBaseUrl(url: string): Promise<Config>;
  /**
   * Trigger a single `/health` probe against the current
   * `apiBaseUrl`. The main process performs the fetch, applies
   * `isPmGoHealthEnvelope`, and classifies the response into one of
   * the four {@link ProbeResult} variants.
   */
  probeHealth(): Promise<ProbeResult>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    /**
     * Bridge to the desktop's main process. Populated by the preload
     * script before any renderer code runs. Tests that don't go
     * through the real preload mock this directly.
     */
    pmGoDesktop: PmGoDesktopBridge;
  }
}
