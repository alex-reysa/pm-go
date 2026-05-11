/**
 * Electron preload bridge.
 *
 * The renderer is sandboxed (`contextIsolation: true`,
 * `nodeIntegration: false`, `sandbox: true` — see
 * `src/main/window.ts`). The ONLY way the renderer reaches the
 * main process is through the small, typed bridge exposed below
 * via `contextBridge.exposeInMainWorld('pmGoDesktop', ...)`.
 *
 * The bridge surface is intentionally exactly THREE methods —
 * matching the three IPC channels in {@link IPC_CHANNELS}:
 *
 *   - `getConfig()`          → `Promise<Config>`
 *   - `setApiBaseUrl(url)`   → `Promise<Config>`
 *   - `probeHealth(baseUrl)` → `Promise<HealthProbeResult>`
 *
 * We do NOT expose raw `ipcRenderer`. We do NOT add convenience
 * methods that proxy `fs` / `child_process` / arbitrary IPC. Doing
 * so would re-open the renderer attack surface the sandbox is
 * there to close. A grep for `exposeInMainWorld` over `src/preload/`
 * should return exactly one match (this file), and a grep for
 * `ipcRenderer` over the renderer bundle should return zero.
 *
 * The exported {@link PmGoDesktopBridge} interface and
 * {@link PM_GO_DESKTOP_BRIDGE_KEY} constant let the renderer (phase 1)
 * declare `window.pmGoDesktop` with the same TypeScript types the
 * preload is bound against — single source of truth, no drift.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { HealthProbeResult } from "../main/healthProbe.js";
import { IPC_CHANNELS } from "../main/ipcChannels.js";
import type { Config } from "../shared/config.js";

/**
 * Global key under which the bridge is mounted in the renderer.
 * Renderer code accesses the bridge as `window.pmGoDesktop`.
 */
export const PM_GO_DESKTOP_BRIDGE_KEY = "pmGoDesktop" as const;

/**
 * Typed surface of `window.pmGoDesktop` in the renderer. Phase-1
 * renderer code can `declare global { interface Window { pmGoDesktop:
 * PmGoDesktopBridge } }` to pick this up without re-typing.
 *
 * Every method is `async`/Promise-returning because IPC over
 * `contextBridge` is inherently async (`ipcRenderer.invoke` returns
 * a Promise). Synchronous variants would require `sendSync`, which
 * we explicitly do not expose.
 */
export interface PmGoDesktopBridge {
  /** Fetch the current Config from the main process. */
  getConfig(): Promise<Config>;
  /**
   * Persist a new `apiBaseUrl` (normalized in main) and return the
   * resulting Config.
   */
  setApiBaseUrl(url: string): Promise<Config>;
  /**
   * Run an identity-aware `/health` probe against `baseUrl` in the
   * main process. The renderer never opens a network socket; all
   * HTTP lives behind this call.
   */
  probeHealth(baseUrl: string): Promise<HealthProbeResult>;
}

/**
 * Build the bridge object against an arbitrary `invoke` function.
 * Extracted so the Vitest preload suite can assert "the bridge
 * shape has exactly { getConfig, setApiBaseUrl, probeHealth } and
 * each method routes to the matching channel" without needing to
 * load the whole `electron` module under test.
 *
 * Production calls this with `ipcRenderer.invoke.bind(ipcRenderer)`
 * once at module load and hands the result to `contextBridge`.
 */
export function buildPmGoDesktopBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): PmGoDesktopBridge {
  return {
    getConfig: () => invoke(IPC_CHANNELS.configGet) as Promise<Config>,
    setApiBaseUrl: (url: string) =>
      invoke(IPC_CHANNELS.configSetApiBaseUrl, url) as Promise<Config>,
    probeHealth: (baseUrl: string) =>
      invoke(IPC_CHANNELS.healthProbe, baseUrl) as Promise<HealthProbeResult>,
  };
}

// ---------------------------------------------------------------------------
// M0 stub re-exports — kept so the renderer can still import the
// attach-state vocabulary from the preload entrypoint if it wants.
// ---------------------------------------------------------------------------
export type { AttachState } from "../shared/attachState.js";
export { ATTACH_STATE_LABELS } from "../shared/attachState.js";
export type { HealthProbeResult } from "../main/healthProbe.js";
export type { Config } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Side effect: mount the bridge in the renderer's `window`. This is
// the entire reason the preload script exists. Guarded so importing
// this module outside an Electron preload context (e.g. inside a
// Vitest test that mocked the `electron` module) does not crash —
// `contextBridge.exposeInMainWorld` is a function in both cases, the
// guard just lets the module be imported safely.
// ---------------------------------------------------------------------------
if (
  typeof contextBridge !== "undefined" &&
  typeof contextBridge.exposeInMainWorld === "function"
) {
  contextBridge.exposeInMainWorld(
    PM_GO_DESKTOP_BRIDGE_KEY,
    buildPmGoDesktopBridge(ipcRenderer.invoke.bind(ipcRenderer)),
  );
}
