import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { apiVersion, readApiVersionWith } from "../src/lib/version.js";

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-health-xyz",
    workflowId: "wf-health-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { client };
}

/**
 * Resolve the on-disk `apps/api/package.json` version the same way
 * `src/lib/version.ts` does, so the assertion is anchored to the
 * actual file rather than the cached `apiVersion`. (We *also* assert
 * `apiVersion === ondisk.version`; the two-step gives a clearer
 * failure message if the cache and the on-disk value drift apart.)
 */
function readPackageJsonVersion(): string {
  // version.ts and this test file are both two `..` segments below
  // the api package root, so the same relative URL works.
  const path = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const raw = readFileSync(path, "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("GET /health — identity body (ac-health-identity-1)", () => {
  it("returns the exact identity-body shape with status, service, version, instance, port", async () => {
    const { client } = makeMockTemporal();
    const boundPort = 4242;
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
      instanceName: "default",
      getBoundPort: () => boundPort,
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;

    // Shape matches exactly — no extra keys, no missing keys.
    expect(body).toEqual({
      status: "ok",
      service: "pm-go-api",
      version: apiVersion,
      instance: "default",
      port: boundPort,
    });
  });

  it("reports the version that lives in apps/api/package.json", () => {
    // Independent re-read of the package.json so we catch the case
    // where `apiVersion` was cached at module load against a stale or
    // unexpected file.
    const ondisk = readPackageJsonVersion();
    expect(apiVersion).toBe(ondisk);
    expect(typeof apiVersion).toBe("string");
    expect(apiVersion.length).toBeGreaterThan(0);
  });

  it("instance reflects the injected AppDeps.instanceName", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
      instanceName: "default",
      getBoundPort: () => 1,
    });
    const res = await app.request("/health");
    const body = (await res.json()) as { instance: string };
    expect(body.instance).toBe("default");
  });

  it("port reflects what serve(...) reported back, via the getBoundPort getter (called per request)", async () => {
    const { client } = makeMockTemporal();
    let boundPort = 0;
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
      instanceName: "default",
      getBoundPort: () => boundPort,
    });

    // Before the simulated `serve(...)` callback fires, the holder is
    // still 0 — proving the route reads through the getter at request
    // time and is NOT capturing a snapshot at registration time.
    let res = await app.request("/health");
    let body = (await res.json()) as { port: number };
    expect(body.port).toBe(0);

    // Simulate `serve(...)` resolving with the real bound port.
    boundPort = 5173;

    res = await app.request("/health");
    body = (await res.json()) as { port: number };
    expect(body.port).toBe(5173);
  });

  it("backward compatibility (ac-health-identity-1 / bb2) — `status` is still a top-level 'ok' string, not renamed/nested", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
      instanceName: "default",
      getBoundPort: () => 3001,
    });
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    // The status property must still be present at the top level with
    // the literal value "ok" — i.e. a caller that reads only `status`
    // continues to observe "ok".
    expect(body.status).toBe("ok");
    expect(typeof body.status).toBe("string");

    // It must NOT have been moved into a nested object (e.g.
    // `{ health: { status: "ok" } }`) or renamed (e.g. `state`).
    expect(Object.prototype.hasOwnProperty.call(body, "status")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "state")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "health")).toBe(false);
  });
});

describe("readApiVersionWith — test seam for the package.json reader", () => {
  it("parses the version from a stubbed reader without touching disk", () => {
    const reader = () => JSON.stringify({ version: "9.9.9-test" });
    expect(readApiVersionWith(reader)).toBe("9.9.9-test");
  });

  it("throws when the stubbed package.json lacks a non-empty version string", () => {
    expect(() => readApiVersionWith(() => JSON.stringify({}))).toThrow(
      /version/,
    );
    expect(() =>
      readApiVersionWith(() => JSON.stringify({ version: "" })),
    ).toThrow(/version/);
    expect(() =>
      readApiVersionWith(() => JSON.stringify({ version: 42 })),
    ).toThrow(/version/);
  });
});
