import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the `electron` module BEFORE importing the preload so the
// `contextBridge.exposeInMainWorld` side effect at the bottom of
// `src/preload/index.ts` lands on our spies instead of the real
// Electron API (which doesn't exist in a Node test runner anyway).
vi.mock("electron", () => {
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(),
    },
  };
});

import { contextBridge, ipcRenderer } from "electron";

import {
  PM_GO_DESKTOP_BRIDGE_KEY,
  buildPmGoDesktopBridge,
  type PmGoDesktopBridge,
} from "../../src/preload/index.js";
import { IPC_CHANNELS } from "../../src/main/ipcChannels.js";

describe("preload bridge — contextBridge.exposeInMainWorld registration", () => {
  it("exposes the bridge under the `pmGoDesktop` global", () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const calls = (contextBridge.exposeInMainWorld as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls;
    expect(calls[0]?.[0]).toBe(PM_GO_DESKTOP_BRIDGE_KEY);
    expect(calls[0]?.[0]).toBe("pmGoDesktop");
  });

  it("exposes exactly { getConfig, setApiBaseUrl, probeHealth } — no extras", () => {
    const calls = (contextBridge.exposeInMainWorld as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls;
    const api = calls[0]?.[1] as Record<string, unknown>;
    expect(api).toBeDefined();
    // Pinned by acceptance criteria — any extra method here is a
    // load-bearing security change. The sorted equality assertion
    // is intentionally strict: an extra key makes this fail loudly.
    expect(Object.keys(api).sort()).toEqual(
      ["getConfig", "probeHealth", "setApiBaseUrl"],
    );
    expect(typeof api["getConfig"]).toBe("function");
    expect(typeof api["setApiBaseUrl"]).toBe("function");
    expect(typeof api["probeHealth"]).toBe("function");
  });

  it("does NOT expose ipcRenderer or any raw IPC handle", () => {
    const calls = (contextBridge.exposeInMainWorld as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls;
    const api = calls[0]?.[1] as Record<string, unknown>;
    // Defense in depth: the renderer must not be able to reach
    // `ipcRenderer.send`, `ipcRenderer.invoke`, or any other IPC
    // primitive directly. The bridge is the only door.
    expect(api["ipcRenderer"]).toBeUndefined();
    expect(api["send"]).toBeUndefined();
    expect(api["invoke"]).toBeUndefined();
    expect(api["on"]).toBeUndefined();
  });
});

describe("buildPmGoDesktopBridge — routes each method to the correct IPC channel", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let bridge: PmGoDesktopBridge;

  beforeEach(() => {
    invoke = vi.fn();
    bridge = buildPmGoDesktopBridge(
      invoke as unknown as (
        channel: string,
        ...args: unknown[]
      ) => Promise<unknown>,
    );
  });

  afterEach(() => {
    invoke.mockReset();
  });

  it("getConfig invokes `config:get` with no extra args", async () => {
    const expected = { apiBaseUrl: "http://localhost:3001" };
    invoke.mockResolvedValueOnce(expected);
    const result = await bridge.getConfig();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.configGet);
    expect(result).toEqual(expected);
  });

  it("setApiBaseUrl invokes `config:setApiBaseUrl` with the URL", async () => {
    const expected = { apiBaseUrl: "http://example.com:4000" };
    invoke.mockResolvedValueOnce(expected);
    const result = await bridge.setApiBaseUrl("http://example.com:4000/");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.configSetApiBaseUrl,
      "http://example.com:4000/",
    );
    expect(result).toEqual(expected);
  });

  it("probeHealth invokes `health:probe` with the base URL", async () => {
    const expected = { state: "api_unreachable" as const };
    invoke.mockResolvedValueOnce(expected);
    const result = await bridge.probeHealth("http://localhost:3001");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.healthProbe,
      "http://localhost:3001",
    );
    expect(result).toEqual(expected);
  });
});

describe("preload bridge — wired against the mocked ipcRenderer.invoke", () => {
  // The bridge built at module load uses the REAL `ipcRenderer.invoke`
  // mock. These tests exercise the end-to-end path: call the
  // exposed method → it should call `ipcRenderer.invoke(channel, ...args)`.
  let api: Record<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    const calls = (contextBridge.exposeInMainWorld as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls;
    api = calls[0]?.[1] as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    (ipcRenderer.invoke as unknown as { mockReset: () => void }).mockReset();
  });

  it("getConfig routes through ipcRenderer.invoke('config:get')", async () => {
    (ipcRenderer.invoke as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
    }).mockResolvedValueOnce({ apiBaseUrl: "http://x" });
    const result = await api["getConfig"]!();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("config:get");
    expect(result).toEqual({ apiBaseUrl: "http://x" });
  });

  it("setApiBaseUrl routes through ipcRenderer.invoke('config:setApiBaseUrl', url)", async () => {
    (ipcRenderer.invoke as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
    }).mockResolvedValueOnce({ apiBaseUrl: "http://x" });
    await api["setApiBaseUrl"]!("http://x");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "config:setApiBaseUrl",
      "http://x",
    );
  });

  it("probeHealth routes through ipcRenderer.invoke('health:probe', baseUrl)", async () => {
    (ipcRenderer.invoke as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
    }).mockResolvedValueOnce({ state: "api_unreachable" });
    await api["probeHealth"]!("http://x");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("health:probe", "http://x");
  });
});
