/**
 * Renderer-process entrypoint — M0 stub.
 *
 * Phase 1 replaces the body of this file with the React tree:
 * `createRoot(document.getElementById('root')!).render(<App />)`
 * plus a top-level attach-state-aware shell that switches between
 * configure / probing / connected views based on
 * {@link import("../shared/attachState.js").AttachState }.
 *
 * Intentionally NOT importing `react` / `react-dom` at the M0
 * scaffold: typecheck and Vitest unit coverage are the only
 * acceptance gates here, and neither benefits from a placeholder
 * `ReactDOM.createRoot` call.
 *
 * The `.tsx` extension is preserved so phase 1 can drop JSX into
 * this file without a rename. M0 deliberately ships ZERO JSX here:
 * `electron.vite.config.ts` does not yet register
 * `@vitejs/plugin-react`, and adding a placeholder element would
 * either force that dependency in now or fail the bundler `build`
 * step. The shared re-exports below are pure-TS and travel through
 * the bundler unchanged.
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
