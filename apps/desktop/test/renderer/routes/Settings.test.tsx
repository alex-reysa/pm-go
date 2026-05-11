import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Config } from "../../../src/shared/config.js";
import type { HealthEnvelope } from "../../../src/shared/health.js";
import { FIXTURE_BANNER_LABEL } from "../../../src/renderer/fixtures/index.js";
import type {
  PmGoDesktopBridge,
  ProbeResult,
} from "../../../src/renderer/bridge.js";
import {
  describeProbeResult,
  INITIAL_SETTINGS_STATE,
  loadSettingsConfig,
  Settings,
  testSettingsConnection,
  type SettingsState,
} from "../../../src/renderer/routes/Settings.js";

const BASE_URL = "http://localhost:3001";
const CONFIG: Config = { apiBaseUrl: BASE_URL };
const ENVELOPE: HealthEnvelope = {
  status: "ok",
  service: "pm-go-api",
  version: "0.8.8.0",
  instance: "primary",
  port: 3001,
};
const CONNECTED: ProbeResult = { kind: "connected", envelope: ENVELOPE };
const SETTINGS_ROUTE = path.resolve(
  __dirname,
  "../../../src/renderer/routes/Settings.tsx",
);

function makeBridge(options?: {
  config?: Config;
  configError?: Error;
  probe?: ProbeResult;
  probeError?: Error;
}): PmGoDesktopBridge {
  return {
    getConfig: vi.fn(async () => {
      if (options?.configError !== undefined) {
        throw options.configError;
      }
      return options?.config ?? CONFIG;
    }),
    setApiBaseUrl: vi.fn(async (url: string) => ({ apiBaseUrl: url })),
    probeHealth: vi.fn(async () => {
      if (options?.probeError !== undefined) {
        throw options.probeError;
      }
      return options?.probe ?? CONNECTED;
    }),
  };
}

function render(
  initialState: SettingsState = {
    load: { kind: "loaded", config: CONFIG },
    test: { kind: "idle" },
  },
): string {
  return renderToStaticMarkup(
    <Settings bridge={makeBridge()} initialState={initialState} />,
  );
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Settings route", () => {
  it("loads the API base URL through bridge.getConfig only", async () => {
    const bridge = makeBridge({ config: CONFIG });
    const load = await loadSettingsConfig(bridge);

    expect(load).toEqual({ kind: "loaded", config: CONFIG });
    expect(bridge.getConfig).toHaveBeenCalledTimes(1);
    expect(bridge.probeHealth).not.toHaveBeenCalled();
    expect(bridge.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it("renders loading, loaded, empty-config, and error states", () => {
    const loading = render(INITIAL_SETTINGS_STATE);
    const loaded = render({
      load: { kind: "loaded", config: CONFIG },
      test: { kind: "idle" },
    });
    const empty = render({
      load: { kind: "loaded", config: { apiBaseUrl: "" } },
      test: { kind: "idle" },
    });
    const error = render({
      load: { kind: "error", message: "config read failed" },
      test: { kind: "idle" },
    });

    expect(loading).toContain(FIXTURE_BANNER_LABEL);
    expect(loading).toMatch(/data-testid="settings-api-base-url-loading"/);
    expect(loaded).toContain(BASE_URL);
    expect(loaded).toMatch(/data-testid="settings-api-base-url-value"/);
    expect(empty).toContain("(not configured");
    expect(empty).toContain('data-empty="true"');
    expect(error).toMatch(/data-testid="settings-api-base-url-error"/);
    expect(error).toContain("config read failed");
  });

  it("wires Test Connection through bridge.probeHealth only", async () => {
    const bridge = makeBridge({ probe: CONNECTED });
    const status = await testSettingsConnection(bridge);

    expect(status).toEqual({
      kind: "success",
      service: "pm-go-api",
      version: "0.8.8.0",
      instance: "primary",
      port: 3001,
    });
    expect(bridge.probeHealth).toHaveBeenCalledTimes(1);
    expect(bridge.getConfig).not.toHaveBeenCalled();
    expect(bridge.setApiBaseUrl).not.toHaveBeenCalled();
  });

  it("renders test-connection idle, probing, success, and failure variants", () => {
    const idle = render({
      load: { kind: "loaded", config: CONFIG },
      test: { kind: "idle" },
    });
    const probing = render({
      load: { kind: "loaded", config: CONFIG },
      test: { kind: "probing" },
    });
    const success = render({
      load: { kind: "loaded", config: CONFIG },
      test: describeProbeResult(CONNECTED),
    });
    const failure = render({
      load: { kind: "loaded", config: CONFIG },
      test: describeProbeResult({ kind: "api_unreachable", message: "ECONNREFUSED" }),
    });

    expect(idle).toContain("Test connection");
    expect(probing).toContain("Probing");
    expect(probing).toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(success).toMatch(/data-testid="settings-test-result-success"/);
    expect(success).toContain("Reached pm-go-api v0.8.8.0");
    expect(failure).toMatch(/data-testid="settings-test-result-failure"/);
    expect(failure).toContain("API unreachable: ECONNREFUSED");
  });

  it("keeps Settings top-level with no EventDrawer or RightInspector", () => {
    for (const html of [
      render(INITIAL_SETTINGS_STATE),
      render({
        load: { kind: "loaded", config: CONFIG },
        test: { kind: "idle" },
      }),
      render({
        load: { kind: "error", message: "config read failed" },
        test: { kind: "idle" },
      }),
    ]) {
      expect(html).not.toMatch(/data-testid="event-drawer"/);
      expect(html).not.toMatch(/data-testid="right-inspector"/);
    }
  });

  it("does not add direct fetches or base-url mutation to Settings", async () => {
    const source = stripComments(await readFile(SETTINGS_ROUTE, "utf8"));

    expect(source).toMatch(/\.getConfig\s*\(/);
    expect(source).toMatch(/\.probeHealth\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bsetApiBaseUrl\s*\(/);
  });
});
