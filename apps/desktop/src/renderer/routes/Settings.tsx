/**
 * Settings — the top-level configuration surface.
 *
 * Information architecture (docs/desktop/03-information-architecture.md
 * §Route Map row `/settings`):
 *
 *   - Top-level route. No EventDrawer, no RightInspector. Smoke tests
 *     assert their absence from this route's rendered markup.
 *   - The API base URL is **read-only** here: it is loaded from
 *     `bridge.getConfig()` on mount and displayed verbatim. Editing
 *     the base URL still lives on the Attach screen (the inline
 *     input + Apply); pulling that affordance into Settings is a
 *     deliberate non-goal for M2 because it would re-implement the
 *     attach state machine on a second surface.
 *   - The "Recent paths" section is a placeholder — M3 lands the
 *     real recent-spec / recent-repo memory.
 *   - "Test connection" is the only mutating action. It calls
 *     `bridge.probeHealth()` (the same channel the Attach screen
 *     uses) and renders the classified result inline. No other
 *     bridge methods or network calls happen from this route.
 *   - The page renders loading / error / loaded variants for the
 *     config fetch, and idle / probing / success / failure variants
 *     for the test-connection result, with the M2 fixture banner
 *     surfaced above the content.
 */

import React, { useEffect, useState } from "react";

import type { Config } from "../../shared/config.js";
import type { PmGoDesktopBridge, ProbeResult } from "../bridge.js";
import { FIXTURE_BANNER_LABEL } from "../fixtures/index.js";
import { ROUTES } from "../router/index.js";

/**
 * Discriminated state for the `bridge.getConfig()` load. `loading` is
 * the first-mount state until the bridge call resolves; `loaded`
 * holds the canonical config; `error` captures a bridge failure (the
 * preload script returns a Promise, so a rejected Promise routes
 * through the catch arm).
 */
export type SettingsLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly config: Config }
  | { readonly kind: "error"; readonly message: string };

/**
 * Discriminated state for the Test Connection action. `idle` is the
 * initial state; `probing` shows the in-flight spinner-equivalent
 * label; `success` and `failure` are the terminal states.
 */
export type SettingsTestStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "probing" }
  | {
      readonly kind: "success";
      readonly service: string;
      readonly version: string;
      readonly instance: string;
      readonly port: number;
    }
  | { readonly kind: "failure"; readonly reason: string };

export interface SettingsState {
  readonly load: SettingsLoadState;
  readonly test: SettingsTestStatus;
}

export const INITIAL_SETTINGS_STATE: SettingsState = Object.freeze({
  load: { kind: "loading" },
  test: { kind: "idle" },
}) as SettingsState;

/**
 * Pure helper: classify a {@link ProbeResult} into a
 * {@link SettingsTestStatus}. Exported so tests can drive each branch
 * without re-implementing the mapping.
 */
export function describeProbeResult(result: ProbeResult): SettingsTestStatus {
  switch (result.kind) {
    case "connected":
      return {
        kind: "success",
        service: result.envelope.service,
        version: result.envelope.version,
        instance: result.envelope.instance,
        port: result.envelope.port,
      };
    case "api_unreachable":
      return {
        kind: "failure",
        reason:
          result.message === undefined || result.message === ""
            ? "API unreachable (no connection)."
            : `API unreachable: ${result.message}`,
      };
    case "foreign_service":
      return {
        kind: "failure",
        reason:
          result.status === undefined
            ? "Foreign service — server responded but is not pm-go-api."
            : `Foreign service (HTTP ${result.status}) — not a pm-go-api instance.`,
      };
    case "api_error":
      return {
        kind: "failure",
        reason:
          result.status === undefined
            ? "API error (no status returned)."
            : `API error (HTTP ${result.status}).`,
      };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read Settings' config through the narrow bridge method this route
 * owns. Exported for tests so they can verify the bridge contract
 * without relying on React effects in a DOM-less harness.
 */
export async function loadSettingsConfig(
  bridge: Pick<PmGoDesktopBridge, "getConfig">,
): Promise<SettingsLoadState> {
  try {
    const config = await bridge.getConfig();
    return { kind: "loaded", config };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

/**
 * Run the Test Connection action through the existing health probe
 * bridge channel and map the result into route-local UI state.
 */
export async function testSettingsConnection(
  bridge: Pick<PmGoDesktopBridge, "probeHealth">,
): Promise<SettingsTestStatus> {
  try {
    const result = await bridge.probeHealth();
    return describeProbeResult(result);
  } catch (err) {
    return { kind: "failure", reason: errorMessage(err) };
  }
}

export interface SettingsProps {
  readonly bridge: PmGoDesktopBridge;
  /**
   * Test-only seam: pre-seed state. Production callers should leave
   * this unset; the route starts in `loading` and the mount effect
   * resolves `bridge.getConfig()` into the loaded variant.
   */
  readonly initialState?: SettingsState;
}

export function Settings(props: SettingsProps): React.JSX.Element {
  const { bridge } = props;
  const [state, setState] = useState<SettingsState>(
    () => props.initialState ?? INITIAL_SETTINGS_STATE,
  );

  useEffect(() => {
    // Respect a pre-seeded `loaded` / `error` state from the test
    // seam — don't blow it away by re-fetching on mount.
    if (state.load.kind !== "loading") return;
    let cancelled = false;
    void loadSettingsConfig(bridge).then((load) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, load }));
    });
    return (): void => {
      cancelled = true;
    };
    // Mount-only effect: we deliberately do NOT re-run on bridge or
    // state changes. `bridge` is a stable reference for the renderer
    // lifetime, and the `state.load.kind` guard means re-running on
    // every state change would just no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTestConnection = async (): Promise<void> => {
    setState((prev) => ({ ...prev, test: { kind: "probing" } }));
    const test = await testSettingsConnection(bridge);
    setState((prev) => ({ ...prev, test }));
  };

  return (
    <section
      className="settings"
      data-testid="settings-route"
      data-route="settings"
      data-load-kind={state.load.kind}
      data-test-kind={state.test.kind}
      aria-labelledby="settings-title"
    >
      <header className="settings__header">
        <h1 id="settings-title">{ROUTES.settings.title}</h1>
      </header>
      <p
        className="settings__fixture-banner"
        data-testid="fixture-banner"
        role="status"
      >
        {FIXTURE_BANNER_LABEL} · settings · recent-paths placeholder
      </p>

      <section
        className="settings__api-base-url"
        aria-labelledby="settings-api-base-url-heading"
      >
        <h2 id="settings-api-base-url-heading">API base URL</h2>
        {state.load.kind === "loading" ? (
          <p data-testid="settings-api-base-url-loading" role="status">
            Loading from desktop config…
          </p>
        ) : state.load.kind === "error" ? (
          <p
            data-testid="settings-api-base-url-error"
            role="alert"
            className="settings__error"
          >
            Failed to read desktop config: {state.load.message}
          </p>
        ) : (
          <p
            data-testid="settings-api-base-url-value"
            data-empty={state.load.config.apiBaseUrl === "" ? "true" : "false"}
          >
            {state.load.config.apiBaseUrl === ""
              ? "(not configured — set from the Attach screen)"
              : state.load.config.apiBaseUrl}
          </p>
        )}
        <p className="settings__api-base-url-hint">
          Editing the base URL still lives on the Attach screen; this
          page renders the current value read-only.
        </p>
      </section>

      <section
        className="settings__recent-paths"
        aria-labelledby="settings-recent-paths-heading"
      >
        <h2 id="settings-recent-paths-heading">Recent paths</h2>
        <p
          className="settings__recent-paths-placeholder"
          data-testid="settings-recent-paths-placeholder"
        >
          Recent repo / spec paths land here in M3.
        </p>
      </section>

      <section
        className="settings__test-connection"
        aria-labelledby="settings-test-connection-heading"
      >
        <h2 id="settings-test-connection-heading">Test connection</h2>
        <button
          type="button"
          className="settings__test-connection-button"
          data-testid="settings-test-connection-button"
          disabled={state.test.kind === "probing"}
          aria-disabled={state.test.kind === "probing"}
          onClick={() => {
            void handleTestConnection();
          }}
        >
          {state.test.kind === "probing" ? "Probing…" : "Test connection"}
        </button>
        {state.test.kind === "success" ? (
          <p
            className="settings__test-result settings__test-result--success"
            data-testid="settings-test-result-success"
            role="status"
          >
            Reached {state.test.service} v{state.test.version} (
            {state.test.instance}) on port {state.test.port}.
          </p>
        ) : null}
        {state.test.kind === "failure" ? (
          <p
            className="settings__test-result settings__test-result--failure"
            data-testid="settings-test-result-failure"
            role="alert"
          >
            {state.test.reason}
          </p>
        ) : null}
      </section>
    </section>
  );
}
