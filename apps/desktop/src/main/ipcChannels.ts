/**
 * Canonical list of IPC channel names exchanged between the desktop
 * main process and its preload bridge.
 *
 * Lives in a leaf module — no `electron` import, no `fs`, no
 * runtime side effects — so both `src/main/ipc.ts` (which imports
 * `ipcMain`) and `src/preload/index.ts` (which imports
 * `ipcRenderer`) can pull in the same string literals without
 * dragging main-process-only APIs into the preload bundle.
 *
 * The set is intentionally small and FIXED:
 *
 *   - `config:get`          — renderer asks for the current Config
 *   - `config:setApiBaseUrl`— renderer updates `apiBaseUrl`
 *   - `health:probe`        — renderer asks main to run `/health`
 *
 * Adding a channel here is a load-bearing security decision: the
 * preload bridge is the renderer's only attack surface into Node.
 * Any new entry must come with a paired task spec and reviewer
 * sign-off — this constant is `as const` so a typo at a call site
 * is a compile error.
 */

export const IPC_CHANNELS = {
  configGet: "config:get",
  configSetApiBaseUrl: "config:setApiBaseUrl",
  healthProbe: "health:probe",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
