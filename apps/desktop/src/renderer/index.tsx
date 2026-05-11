/**
 * Renderer-process entrypoint.
 *
 * Boots the React tree against the live `window.pmGoDesktop`
 * bridge (published by the preload script — sibling task). On
 * first paint we read the persisted config off the bridge, hand it
 * to {@link App}, and let the attach state machine take over.
 *
 * The renderer is intentionally minimal:
 *
 *   - It MUST NOT import Node built-ins (`fs`, `child_process`,
 *     `path`) — Electron's context isolation means those globals
 *     don't exist in the renderer anyway, but a stray import would
 *     fail the bundler.
 *   - It MUST NOT speak directly to the API. The only `/health`
 *     call goes through `window.pmGoDesktop.probeHealth`, which
 *     the main process services. The renderer's only outbound
 *     traffic at this milestone is bridge IPC.
 *   - It MUST NOT do `file://` navigation or remote module loading
 *     — the CSP in `index.html` already forbids that, but we don't
 *     want to write code that relies on a future CSP relaxation.
 *
 * Everything else (state machine, identity rendering, post-attach
 * phase-0 router) lives in the sibling files under this
 * directory.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
// Re-exported types kept for any test harness or downstream tooling
// that wants a single import surface for the renderer module graph.
export type { AttachContext, AttachEvent } from "./attachMachine.js";
export { initialContext, reduce, runProbe } from "./attachMachine.js";
export type { PmGoDesktopBridge, ProbeResult } from "./bridge.js";
export { AttachScreen } from "./AttachScreen.js";
export type { AttachScreenProps } from "./AttachScreen.js";
export {
  App,
  AppRoutes,
  POST_ATTACH_LANDING_PATH,
  shouldMountPostAttachRouter,
} from "./App.js";
export type { AppProps } from "./App.js";
export { RunsPlaceholder } from "./RunsPlaceholder.js";

async function bootstrap(): Promise<void> {
  const bridge = window.pmGoDesktop;
  if (typeof bridge === "undefined") {
    // Defensive: the preload script should always run before any
    // renderer code, but if a misconfigured bundler ever ships this
    // file without the preload, we want a visible failure rather
    // than a silent black window.
    throw new Error(
      "window.pmGoDesktop is not defined — preload script failed to load",
    );
  }
  const initialConfig = await bridge.getConfig();
  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("renderer root element #root not found in index.html");
  }
  createRoot(container).render(
    <React.StrictMode>
      <App bridge={bridge} initialConfig={initialConfig} />
    </React.StrictMode>,
  );
}

// The `index.html` script tag is `type="module"`; top-level await
// is supported, but we wrap the call so a thrown bootstrap failure
// surfaces with a clear stack trace in DevTools rather than the
// generic unhandled-promise warning.
void bootstrap();
