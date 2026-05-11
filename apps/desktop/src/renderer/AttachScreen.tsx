/**
 * Top-level UI for the attach state machine.
 *
 * The component is intentionally thin: all transition logic lives in
 * `./attachMachine.ts`. Here we just render the current
 * {@link AttachContext} and wire user gestures (Retry button, base-
 * URL input + Apply button) into bridge calls + reducer dispatches.
 *
 * Why no React Router / no separate "settings page": M0/phase-1
 * keeps the affordance inline so first launch has a single visual
 * surface. The "Settings" requirement from the task is satisfied by
 * the always-visible base-URL input + Apply button. A real settings
 * dialog is a later-milestone concern.
 */

import React, { useCallback, useState } from "react";

import { ATTACH_STATE_LABELS } from "../shared/attachState.js";
import type {
  AttachContext,
  AttachEvent,
} from "./attachMachine.js";
import { runProbe } from "./attachMachine.js";
import type { PmGoDesktopBridge } from "./bridge.js";

export interface AttachScreenProps {
  /** Current reducer state. */
  ctx: AttachContext;
  /** Reducer dispatcher; same one driving the parent `useReducer`. */
  dispatch: (event: AttachEvent) => void;
  /**
   * Bridge to the main process. Injected as a prop (rather than
   * read from `window`) so tests can pass a mock without touching
   * any global.
   */
  bridge: PmGoDesktopBridge;
}

/**
 * Per-state remediation copy. Short, action-oriented, lives next to
 * the component (not in `attachState.ts`) because it's UI prose,
 * not a contract. The labels themselves are in
 * `ATTACH_STATE_LABELS`.
 */
const REMEDIATION: Record<AttachContext["state"], string> = {
  not_configured:
    "Paste the pm-go API base URL below and choose Apply to connect.",
  probing: "Contacting the API…",
  connected: "Attached to the pm-go API.",
  api_unreachable:
    "Could not reach the API. Make sure the server is running and the base URL is correct, then choose Retry.",
  foreign_service:
    "The server at this URL answered, but it is not a pm-go API. Point at the correct port and choose Apply.",
  api_error:
    "The pm-go API answered but returned an error. Check the server logs, then choose Retry.",
};

export function AttachScreen({
  ctx,
  dispatch,
  bridge,
}: AttachScreenProps): React.JSX.Element {
  // Local-only mirror of the input so typing doesn't churn the
  // reducer. Apply commits the value via `set_base_url`.
  const [pendingBaseUrl, setPendingBaseUrl] = useState<string>(ctx.baseUrl);

  const onApply = useCallback(async () => {
    const trimmed = pendingBaseUrl.trim();
    // Persist via the bridge; main re-normalizes and writes
    // `config.json`. We optimistically update the reducer with the
    // user's typed value — the next probe carries the canonical
    // form on the success envelope.
    await bridge.setApiBaseUrl(trimmed);
    dispatch({ type: "set_base_url", baseUrl: trimmed });
    if (trimmed !== "") {
      await runProbe(bridge, dispatch);
    }
  }, [bridge, dispatch, pendingBaseUrl]);

  const onRetry = useCallback(async () => {
    if (ctx.baseUrl === "") return;
    await runProbe(bridge, dispatch);
  }, [bridge, ctx.baseUrl, dispatch]);

  const stateLabel = ATTACH_STATE_LABELS[ctx.state];
  const remediation = REMEDIATION[ctx.state];

  // Retry is offered for every state where the operator can act on
  // it: the three failure states + `connected` (re-check after
  // suspecting a stale connection). It is NOT offered during
  // `probing` (no double-probe) or `not_configured` (Apply does the
  // probe).
  const showRetry =
    ctx.state === "api_unreachable" ||
    ctx.state === "foreign_service" ||
    ctx.state === "api_error" ||
    ctx.state === "connected";

  return (
    <section
      className="attach-screen"
      data-attach-state={ctx.state}
      aria-labelledby="attach-title"
    >
      <h1 id="attach-title">pm-go</h1>
      <p className="attach-label" role="status" aria-live="polite">
        <span data-testid="attach-state-label">{stateLabel}</span>
      </p>
      <p className="attach-remediation">{remediation}</p>

      {ctx.state === "connected" && ctx.envelope !== null ? (
        <dl
          className="identity-envelope"
          data-testid="identity-envelope"
          aria-label="API identity"
        >
          <div>
            <dt>Service</dt>
            <dd data-testid="identity-service">{ctx.envelope.service}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd data-testid="identity-version">{ctx.envelope.version}</dd>
          </div>
          <div>
            <dt>Instance</dt>
            <dd data-testid="identity-instance">{ctx.envelope.instance}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd data-testid="identity-port">{ctx.envelope.port}</dd>
          </div>
        </dl>
      ) : null}

      <form
        className="attach-settings"
        data-testid="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onApply();
        }}
      >
        <label className="attach-settings-field">
          <span>API base URL</span>
          <input
            type="text"
            inputMode="url"
            placeholder="http://localhost:3001"
            value={pendingBaseUrl}
            aria-label="API base URL"
            data-testid="base-url-input"
            onChange={(e) => setPendingBaseUrl(e.target.value)}
          />
        </label>
        <div className="attach-settings-actions">
          <button
            type="submit"
            data-testid="apply-button"
            disabled={ctx.state === "probing"}
          >
            Apply
          </button>
          {showRetry ? (
            <button
              type="button"
              data-testid="retry-button"
              disabled={ctx.baseUrl === ""}
              onClick={() => {
                void onRetry();
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
