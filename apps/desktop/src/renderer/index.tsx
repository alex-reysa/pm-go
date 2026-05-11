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
 * `ReactDOM.createRoot` call. The `.tsx` extension is preserved so
 * the bundler is already wired for JSX when phase 1 lands. A
 * single throw-away JSX element is emitted below to keep the
 * jsx-runtime resolver path exercised under typecheck — replacing
 * the entire body in phase 1 will remove it.
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

/**
 * Placeholder JSX element so the tsconfig's `"jsx": "react-jsx"`
 * resolver actually resolves `react/jsx-runtime` at typecheck time.
 * Phase 1 mounts a real component and deletes this export.
 */
export const __M0_PLACEHOLDER__ = <div data-testid="m0-placeholder" />;
