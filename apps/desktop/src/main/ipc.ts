/**
 * IPC bridge wiring — registers the THREE main-process handlers the
 * preload bridge can invoke.
 *
 * The channel set is fixed at {@link IPC_CHANNELS}; this module is the
 * only place `ipcMain.handle` is called in `src/main/**`. A grep
 * over the main bundle for `ipcMain.handle` should return exactly
 * three matches, one per channel. Adding a new IPC surface is a
 * security-relevant change: it must come paired with the matching
 * preload `contextBridge` entry AND a task spec / reviewer
 * sign-off.
 *
 * The handlers themselves are deliberately thin — they delegate to
 * the pure-data modules ({@link runHealthProbe},
 * {@link createConfigStore}) so unit coverage can exercise the
 * logic without spinning up `ipcMain`. This file's tests verify
 * the registration shape only.
 */

import { ipcMain, type IpcMain } from "electron";

import type { ConfigStore } from "./configStore.js";
import { runHealthProbe, type HealthProbeResult } from "./healthProbe.js";
import { IPC_CHANNELS } from "./ipcChannels.js";
import type { Config } from "../shared/config.js";

/**
 * Options bag for {@link registerIpcHandlers}. The `ipc` field is
 * injectable so the Vitest registration test can supply a mock
 * `IpcMain`-shaped object — real Electron `ipcMain` only exists
 * inside an Electron runtime.
 */
export interface RegisterIpcHandlersOptions {
  /** Config store backing `config:get` and `config:setApiBaseUrl`. */
  configStore: ConfigStore;
  /** Injectable `ipcMain`. Defaults to the real Electron singleton. */
  ipc?: Pick<IpcMain, "handle">;
}

/**
 * Subset of {@link IpcMain} the handlers need — just `.handle`. Used
 * by tests to type the mock without dragging in the full
 * Electron `IpcMain` interface.
 */
export type IpcMainSubset = Pick<IpcMain, "handle">;

/**
 * Register the three pm-go IPC channels on the supplied `ipcMain`.
 *
 * Channel contracts (mirrored in the preload bridge):
 *
 *   - `config:get`           — `() => Promise<Config>`
 *   - `config:setApiBaseUrl` — `(url: string) => Promise<Config>`
 *   - `health:probe`         — `(baseUrl: string) => Promise<HealthProbeResult>`
 *
 * Returns nothing; side effect only. Callers should invoke this
 * exactly once during main-process bootstrap, AFTER constructing
 * the config store and BEFORE creating the renderer window (so the
 * window has a working bridge from its first paint).
 */
export function registerIpcHandlers(
  options: RegisterIpcHandlersOptions,
): void {
  const { configStore, ipc = ipcMain } = options;

  ipc.handle(IPC_CHANNELS.configGet, async (): Promise<Config> => {
    return configStore.getConfig();
  });

  ipc.handle(
    IPC_CHANNELS.configSetApiBaseUrl,
    async (_event: unknown, url: unknown): Promise<Config> => {
      // The IPC boundary is untyped — the renderer is hostile by
      // default. Coerce-and-validate at the seam rather than trust
      // the preload bridge: a compromised renderer can call invoke
      // with arbitrary args.
      const safeUrl = typeof url === "string" ? url : "";
      return configStore.setApiBaseUrl(safeUrl);
    },
  );

  ipc.handle(
    IPC_CHANNELS.healthProbe,
    async (_event: unknown, baseUrl: unknown): Promise<HealthProbeResult> => {
      const safeBaseUrl = typeof baseUrl === "string" ? baseUrl : "";
      return runHealthProbe(safeBaseUrl);
    },
  );
}
