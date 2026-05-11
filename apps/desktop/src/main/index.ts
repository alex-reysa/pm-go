/**
 * Electron main-process entrypoint.
 *
 * Phase-1 fill-in of the M0 stub. Responsibilities, in order:
 *
 *   1. Wait for `app.whenReady()`.
 *   2. Build a {@link ConfigStore} rooted at `app.getPath('userData')`.
 *   3. Register the three IPC handlers (`config:get`,
 *      `config:setApiBaseUrl`, `health:probe`) via
 *      {@link registerIpcHandlers}. NO other channels.
 *   4. Build the BrowserWindow via {@link createMainWindow}, loading
 *      the renderer from the dev-server URL when
 *      `ELECTRON_RENDERER_URL` is set (set by `electron-vite dev`),
 *      otherwise from the bundled `index.html` on disk.
 *
 * Things this file deliberately does NOT do — pinned by the
 * task's acceptance criteria:
 *
 *   - No `shell.openExternal`. No `shell` import at all.
 *   - No `child_process`. No `node:child_process` import.
 *   - No `fs` outside {@link createConfigStore} (which gates its
 *     fs access on the `userData` path).
 *   - No IPC handlers other than the three above.
 *
 * The re-exports below preserve the M0 contract: a grep over the
 * scaffold to confirm "shared module X still flows through the
 * main entrypoint" continues to pass. Phase-1 implementation
 * additions (config store, IPC, window factory, health probe) are
 * also re-exported so unit tests and any future tooling can
 * import everything from `@pm-go/desktop/src/main/index.js`.
 */

import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfigStore } from "./configStore.js";
import { registerIpcHandlers } from "./ipc.js";
import { createMainWindow } from "./window.js";

// ---------------------------------------------------------------------------
// M0 stub re-exports — preserved so the existing scaffold contract
// holds. A break in any of these surfaces a compile error at the
// import site, which is the cheapest regression alarm we have.
// ---------------------------------------------------------------------------
export { isPmGoHealthEnvelope } from "../shared/health.js";
export type { HealthEnvelope } from "../shared/health.js";
export { normalizeBaseUrl } from "../shared/url.js";
export {
  DEFAULT_API_BASE_URL,
  DEFAULT_CONFIG,
  parseConfig,
} from "../shared/config.js";
export type { Config } from "../shared/config.js";
export { ATTACH_STATE_LABELS } from "../shared/attachState.js";
export type { AttachState } from "../shared/attachState.js";

// ---------------------------------------------------------------------------
// Phase-1 surface re-exports. These let tests import the leaf
// modules directly via the entrypoint without needing to know the
// internal file layout.
// ---------------------------------------------------------------------------
export { createConfigStore } from "./configStore.js";
export type { ConfigStore, CreateConfigStoreOptions } from "./configStore.js";
export { runHealthProbe, DEFAULT_HEALTH_PROBE_TIMEOUT_MS } from "./healthProbe.js";
export type { HealthProbeResult, RunHealthProbeOptions } from "./healthProbe.js";
export { IPC_CHANNELS } from "./ipcChannels.js";
export type { IpcChannel } from "./ipcChannels.js";
export { registerIpcHandlers } from "./ipc.js";
export type { RegisterIpcHandlersOptions } from "./ipc.js";
export { createMainWindow } from "./window.js";
export type { CreateMainWindowOptions, RendererSource } from "./window.js";

/**
 * Wire the main process together. Idempotent in principle but should
 * be called exactly once per process — the second call would
 * re-register IPC handlers, which `ipcMain.handle` rejects with a
 * runtime error.
 */
function bootstrap(): void {
  // The config store is constructed BEFORE `app.whenReady()` resolves
  // so the first IPC call (which can in theory arrive immediately
  // after the renderer paints) doesn't race a partially-constructed
  // store. `app.getPath('userData')` is safe to call before ready —
  // Electron derives it from `app.getName()` + the OS user dir, and
  // doesn't need the event loop to be primed.
  const configStore = createConfigStore({
    userDataDir: app.getPath("userData"),
  });
  registerIpcHandlers({ configStore });

  void app.whenReady().then(() => {
    const here = dirname(fileURLToPath(import.meta.url));
    // electron-vite emits both `out/main/index.js` and
    // `out/preload/index.js` as siblings under `out/`. The path
    // calculation mirrors the bundler's output layout.
    const preloadPath = join(here, "..", "preload", "index.js");
    const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
    createMainWindow({
      preloadPath,
      renderer:
        typeof devServerUrl === "string" && devServerUrl !== ""
          ? { kind: "devServer", url: devServerUrl }
          : {
              kind: "file",
              path: join(here, "..", "renderer", "index.html"),
            },
    });
  });

  app.on("window-all-closed", () => {
    // Matches the Electron convention: macOS apps stay alive when
    // all windows close (the dock icon represents the running app);
    // other platforms quit on last-window-close.
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

// Only run bootstrap when this module is loaded by an actual
// Electron runtime. Tests import this file purely for its
// re-exports; without this guard, Vitest would invoke `app.whenReady`
// against the `electron` Node module's CLI shim and deadlock.
//
// `process.versions.electron` is set by Electron itself (and only
// Electron); plain Node leaves it `undefined`.
if (process.versions["electron"] !== undefined) {
  bootstrap();
}
