import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `electron` so importing `src/main/ipc.ts` doesn't try to
// load the real Electron Node module. The handlers themselves take
// an injected `ipc`, so we don't strictly need this for the
// registration test below — but a top-level `import { ipcMain }`
// is evaluated at module load time and would otherwise pull in
// Electron.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

import { createConfigStore } from "../../src/main/configStore.js";
import { IPC_CHANNELS } from "../../src/main/ipcChannels.js";
import { registerIpcHandlers } from "../../src/main/ipc.js";

describe("registerIpcHandlers", () => {
  let dir: string;
  let handle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-go-desktop-ipc-"));
    handle = vi.fn();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers exactly the three pm-go IPC channels — and no others", () => {
    const store = createConfigStore({ userDataDir: dir });
    registerIpcHandlers({ configStore: store, ipc: { handle } });
    const registeredChannels = handle.mock.calls
      .map((call) => call[0] as string)
      .sort();
    // Pinned by the acceptance criteria: any extra channel here is
    // a security-relevant change that must come with a spec.
    expect(registeredChannels).toEqual(
      [
        IPC_CHANNELS.configGet,
        IPC_CHANNELS.configSetApiBaseUrl,
        IPC_CHANNELS.healthProbe,
      ].sort(),
    );
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("config:get returns the current Config", async () => {
    const store = createConfigStore({ userDataDir: dir });
    registerIpcHandlers({ configStore: store, ipc: { handle } });
    const configGetCall = handle.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.configGet,
    );
    expect(configGetCall).toBeDefined();
    const listener = configGetCall![1] as (event: unknown) => Promise<unknown>;
    const result = await listener({});
    expect(result).toEqual({ apiBaseUrl: "http://localhost:3001" });
  });

  it("config:setApiBaseUrl persists and returns the normalized Config", async () => {
    const store = createConfigStore({ userDataDir: dir });
    registerIpcHandlers({ configStore: store, ipc: { handle } });
    const setCall = handle.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.configSetApiBaseUrl,
    );
    expect(setCall).toBeDefined();
    const listener = setCall![1] as (
      event: unknown,
      url: unknown,
    ) => Promise<unknown>;
    const result = await listener({}, "http://example.com:4000/");
    expect(result).toEqual({ apiBaseUrl: "http://example.com:4000" });
    expect(store.getConfig()).toEqual({
      apiBaseUrl: "http://example.com:4000",
    });
  });

  it("config:setApiBaseUrl coerces a non-string arg to empty string at the boundary", async () => {
    // The renderer is hostile by default — `invoke` is structurally
    // typed but a compromised renderer can pass anything. The
    // handler must not crash on a number / null / undefined.
    const store = createConfigStore({ userDataDir: dir });
    registerIpcHandlers({ configStore: store, ipc: { handle } });
    const setCall = handle.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.configSetApiBaseUrl,
    );
    const listener = setCall![1] as (
      event: unknown,
      url: unknown,
    ) => Promise<unknown>;
    const result = await listener({}, 12345);
    expect(result).toEqual({ apiBaseUrl: "" });
  });
});
