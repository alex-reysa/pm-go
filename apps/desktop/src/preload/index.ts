/**
 * Electron preload-process entrypoint — M0 stub.
 *
 * Phase 1 fills this in with `contextBridge.exposeInMainWorld(...)`
 * to publish a narrow, typed bridge: methods the renderer is
 * allowed to call on the main process, and event subscriptions for
 * attach-state changes. The shape of that bridge is intentionally
 * left undefined here — phase 1 owns it, including the IPC channel
 * names and the corresponding `window.pmgo` type declaration.
 *
 * The stub re-exports the shared attach-state vocabulary so:
 *   - this file compiles under the same tsconfig as `main/` and
 *     `renderer/` (a sanity check on the bundler config), and
 *   - a stray `tsc` against just this file would still pick up a
 *     break in `../shared/attachState.ts`.
 */

export type { AttachState } from "../shared/attachState.js";
export { ATTACH_STATE_LABELS } from "../shared/attachState.js";
