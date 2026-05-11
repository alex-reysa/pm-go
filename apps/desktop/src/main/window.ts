/**
 * BrowserWindow factory — the SINGLE place where a renderer window
 * is constructed.
 *
 * Centralizing this guarantees every window in the app gets the same
 * sandboxed `webPreferences`. The acceptance criteria pin three
 * non-negotiable flags:
 *
 *   - `contextIsolation: true` — preload script's globals are
 *     namespaced separately from the renderer's, so a hostile
 *     renderer can't tamper with the bridge.
 *   - `nodeIntegration: false` — the renderer has zero direct
 *     access to Node APIs (`require`, `process`, ...). Every
 *     Node-ish call must go through the preload bridge.
 *   - `sandbox: true` — the renderer process runs inside Chromium's
 *     OS-level sandbox. The preload is bundled as a single file by
 *     electron-vite so it's compatible with sandboxed mode (no
 *     `require`-from-disk at runtime).
 *
 * The renderer can be served from a dev server (electron-vite's
 * `dev` task sets `ELECTRON_RENDERER_URL` to the Vite URL) or from
 * a bundled `index.html` produced by `electron-vite build`. The
 * caller decides which by passing the appropriate `renderer`
 * discriminator — this module makes no `process.env` reads of its
 * own so the choice stays explicit and testable.
 *
 * We do NOT call `shell.openExternal` from here or anywhere else
 * in `src/main/**`. A grep for `shell.openExternal` over the main
 * bundle should return zero matches. Same for `child_process`.
 */

import { BrowserWindow } from "electron";

/**
 * Default window dimensions. Sized to fit a 1366×768 laptop with
 * room for OS chrome — phase-1 dashboard widgets are designed
 * against ~1280×800 of usable area.
 */
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;

/**
 * Renderer source — either a dev server URL (HMR-enabled during
 * `pnpm dev`) or a built `index.html` on disk (`pnpm build`
 * output). Encoded as a discriminated union so callers cannot
 * accidentally pass both / neither.
 */
export type RendererSource =
  | { readonly kind: "devServer"; readonly url: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * Options bag for {@link createMainWindow}. Both fields are required.
 */
export interface CreateMainWindowOptions {
  /**
   * Absolute path to the bundled preload script. Electron-vite
   * emits this at `out/preload/index.js` during build; the caller
   * resolves the path from the running main bundle's location.
   */
  preloadPath: string;
  /** Where the renderer is loaded from — see {@link RendererSource}. */
  renderer: RendererSource;
}

/**
 * Build and show the application's main BrowserWindow.
 *
 * Returns the constructed window so the caller (the bootstrap in
 * `src/main/index.ts`) can hold a reference and reuse it across
 * `activate` events on macOS. We deliberately do NOT register
 * lifecycle handlers (`on('closed', ...)`, etc.) here — those are
 * the bootstrap's job, and adding them inside this factory would
 * make the function harder to unit-test (every test would have to
 * deal with a stub window emitting events).
 *
 * `show: true` (the default) is acceptable for M0/phase-1: there
 * is no splash-screen UX yet. Phase 2 may flip this to
 * `show: false` and gate on `ready-to-show` for a flash-free
 * paint.
 */
export function createMainWindow(
  options: CreateMainWindowOptions,
): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    webPreferences: {
      preload: options.preloadPath,
      // Three pinned-by-acceptance-criteria flags. DO NOT relax any
      // of these without revisiting the security review — they form
      // the perimeter that keeps the renderer from reaching Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (options.renderer.kind === "devServer") {
    void window.loadURL(options.renderer.url);
  } else {
    void window.loadFile(options.renderer.path);
  }

  return window;
}
