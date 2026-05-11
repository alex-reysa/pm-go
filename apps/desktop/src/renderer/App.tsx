/**
 * Root component for the desktop renderer.
 *
 * Routing model (M0/phase-1): the desktop has exactly two top-level
 * "routes":
 *
 *   1. {@link AttachScreen}, always rendered. It owns the state-
 *      machine UI, the inline settings input, and the per-state
 *      remediation copy.
 *   2. {@link RunsPlaceholder}, the stub for the eventual runs
 *      dashboard. It is mounted ONLY when both:
 *        - `ctx.state === "connected"`, AND
 *        - `ctx.envelope !== null` (a valid pm-go-api identity).
 *
 * The double check is deliberate: `connected` could only ever be set
 * by a `probe_connected` event that carried an envelope, so the
 * envelope check is logically redundant. It is, however, the
 * load-bearing guard that proves to a static reader (and a fuzz
 * test) that `foreign_service` can never fall through to the runs
 * page even if a future bug let `state` drift out of sync with
 * `envelope`. The cost of the extra check is one boolean; the
 * benefit is a hard invariant on the gating contract.
 *
 * We deliberately don't use react-router here: a real router is
 * overkill for two surfaces, and pulling it in would also drag a new
 * dependency. Later milestones can introduce one when there are
 * three+ post-attach routes worth navigating between.
 */

import React, { useEffect, useReducer } from "react";

import type { Config } from "../shared/config.js";
import { AttachScreen } from "./AttachScreen.js";
import type { AttachContext, AttachEvent } from "./attachMachine.js";
import { initialContext, reduce, runProbe } from "./attachMachine.js";
import type { PmGoDesktopBridge } from "./bridge.js";
import { RunsPlaceholder } from "./RunsPlaceholder.js";

export interface AppProps {
  /** Bridge to the main process; mockable in tests. */
  bridge: PmGoDesktopBridge;
  /** Initial config (already read off the bridge by the bootstrap). */
  initialConfig: Config;
}

/**
 * Build the reducer's initial context from an `AppProps.initialConfig`.
 * Extracted as a named function so the `useReducer` initializer
 * argument is a stable reference even across re-renders.
 */
function initContextFromConfig(config: Config): AttachContext {
  return initialContext(config);
}

export function App({
  bridge,
  initialConfig,
}: AppProps): React.JSX.Element {
  const [ctx, dispatch] = useReducer(
    reduce,
    initialConfig,
    initContextFromConfig,
  );

  // First-mount auto-probe. If the operator already has a configured
  // base URL, kick the probe off immediately so the UI lands on
  // `connected` (or a failure state) without manual intervention.
  // If `apiBaseUrl` is empty, we stay in `not_configured` — the
  // user has to type a URL and choose Apply.
  useEffect(() => {
    if (initialConfig.apiBaseUrl === "") return;
    void runProbe(bridge, dispatch);
    // The auto-probe runs once per mount with the initial config.
    // Subsequent config changes go through `set_base_url + runProbe`
    // in the AttachScreen's Apply handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showRunsRoute = ctx.state === "connected" && ctx.envelope !== null;

  return (
    <div className="app-root" data-testid="app-root">
      <AttachScreen ctx={ctx} dispatch={dispatch} bridge={bridge} />
      {showRunsRoute ? <RunsPlaceholder /> : null}
    </div>
  );
}

/**
 * Re-export the reducer types from this module so consumers can rely
 * on `App.tsx` as the single import surface for the renderer tree.
 */
export type { AttachContext, AttachEvent };
