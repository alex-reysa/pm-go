/**
 * Electron main-process entrypoint — M0 stub.
 *
 * Phase 1 replaces the body of this file with:
 *   - `app.whenReady()` window creation
 *   - the attach-state machine (see `../shared/attachState.ts`)
 *   - a periodic `/health` probe that consumes
 *     {@link import("../shared/health.js").isPmGoHealthEnvelope }
 *   - config persistence at `app.getPath('userData')/config.json`
 *
 * Intentionally NOT importing `electron` at the M0 scaffold: the
 * package-boundary acceptance criteria only require that the
 * stub typecheck and tests pass — phase 1 owns the actual
 * Electron bootstrap. The bundler config (`electron.vite.config.ts`)
 * points at this file as the main entrypoint regardless, so phase 1
 * can fill in `import { app, BrowserWindow } from "electron"` without
 * touching the bundler.
 *
 * Re-exporting the shared contracts here surfaces a compile error
 * if any of them are accidentally deleted or renamed — cheap
 * regression insurance for the modules every later task imports.
 */

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
