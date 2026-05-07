import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  decomposeCli,
  parseDecomposeArgv,
  runDecomposeAction,
  type DecomposeDeps,
  type DecomposeOptions,
  type DecomposeTimings,
} from "../decompose.js";

const SPEC_ID = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SNAPSHOT_ID = "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00";
const DECOMPOSITION_ID = "11111111-2222-4333-8444-555555555555";
const PLAN_ID = "22222222-3333-4444-8555-666666666666";
const API_URL = "http://localhost:3001";

const FAST_TIMINGS: DecomposeTimings = {
  pollIntervalMs: 1,
  decomposeTimeoutMs: 100,
  planPersistTimeoutMs: 100,
};

interface ManifestFixture {
  specDocumentId: string;
  repoSnapshotId: string;
  milestones: Array<{
    id: string;
    title: string;
    summary: string;
    sourceSections: string[];
    exitCriteria: string[];
    expectedPhaseCount: number;
    dependsOn: string[];
  }>;
  deferredScope: string[];
}

function makeManifest(): ManifestFixture {
  return {
    specDocumentId: SPEC_ID,
    repoSnapshotId: SNAPSHOT_ID,
    milestones: [
      {
        id: "m01-foundation",
        title: "Foundation",
        summary: "Establish the base contracts.",
        sourceSections: ["§1 Goals"],
        exitCriteria: ["Contracts compile"],
        expectedPhaseCount: 1,
        dependsOn: [],
      },
      {
        id: "m02-behavior",
        title: "Behavior",
        summary: "Wire the workflow end-to-end.",
        sourceSections: ["§2 Behavior"],
        exitCriteria: ["End-to-end smoke passes"],
        expectedPhaseCount: 2,
        dependsOn: ["m01-foundation"],
      },
    ],
    deferredScope: [],
  };
}

interface MockServerState {
  /** Identity body returned from GET /health. */
  healthIdentity: "pm-go" | "foreign";
  /** Decomposition status flips along the poll loop. */
  decompositionStatuses: Array<"pending" | "running" | "ready" | "failed">;
  decompositionStatusIndex: number;
  manifestForGet: ManifestFixture;
  /** When non-null, GET .../decompositions/:id reports failed + this reason. */
  failureReason: string | null;
  /** When false, POST plan-first responds 409. */
  planFirstAllowed: boolean;
  /** When false, GET /plans/:id 404s indefinitely (drives the timeout path). */
  planPersisted: boolean;
  calls: Array<{ method: string; url: string; body?: unknown }>;
  /** Manifest captured by PUT .../manifest, if any. */
  putManifest: ManifestFixture | null;
}

function makeState(overrides: Partial<MockServerState> = {}): MockServerState {
  return {
    healthIdentity: overrides.healthIdentity ?? "pm-go",
    decompositionStatuses: overrides.decompositionStatuses ?? [
      "pending",
      "running",
      "ready",
    ],
    decompositionStatusIndex: 0,
    manifestForGet: overrides.manifestForGet ?? makeManifest(),
    failureReason: overrides.failureReason ?? null,
    planFirstAllowed: overrides.planFirstAllowed ?? true,
    planPersisted: overrides.planPersisted ?? true,
    calls: [],
    putManifest: overrides.putManifest ?? null,
  };
}

function makeDeps(
  state: MockServerState,
  fileFs: Map<string, string> = new Map(),
  editorBehavior: "noop" | "rewrite-manifest" | "throws" = "noop",
): DecomposeDeps & { logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  let nowMs = 0;

  const fetchFn: typeof globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    state.calls.push({ method, url, body });

    if (url.endsWith("/health")) {
      const identity =
        state.healthIdentity === "pm-go"
          ? {
              status: "ok",
              service: "pm-go-api",
              version: "test",
              instance: "default",
              port: 3001,
            }
          : { status: "ok" }; // missing service field
      return new Response(JSON.stringify(identity), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && url === `${API_URL}/spec-documents`) {
      return new Response(
        JSON.stringify({
          specDocumentId: SPEC_ID,
          repoSnapshotId: SNAPSHOT_ID,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (
      method === "POST" &&
      url === `${API_URL}/spec-documents/${SPEC_ID}/decompose`
    ) {
      return new Response(
        JSON.stringify({
          decompositionId: DECOMPOSITION_ID,
          workflowRunId: "wf-run-1",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    if (
      method === "GET" &&
      url ===
        `${API_URL}/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}`
    ) {
      const status =
        state.decompositionStatuses[state.decompositionStatusIndex] ?? "ready";
      // Advance the status pointer one step per poll so the test's
      // tick-cap is reached deterministically.
      if (
        state.decompositionStatusIndex <
        state.decompositionStatuses.length - 1
      ) {
        state.decompositionStatusIndex += 1;
      }
      let decomposition: Record<string, unknown> = {
        id: DECOMPOSITION_ID,
        status,
        specDocumentId: SPEC_ID,
        repoSnapshotId: SNAPSHOT_ID,
        createdAt: "2026-05-07T10:00:00.000Z",
        updatedAt: "2026-05-07T10:00:01.000Z",
      };
      if (status === "ready") {
        decomposition.manifest = state.putManifest ?? state.manifestForGet;
      }
      if (status === "failed" && state.failureReason !== null) {
        decomposition.errorReason = state.failureReason;
      }
      return new Response(JSON.stringify({ decomposition }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      method === "PUT" &&
      url ===
        `${API_URL}/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/manifest`
    ) {
      const incoming = (body as { manifest: ManifestFixture }).manifest;
      state.putManifest = incoming;
      return new Response(
        JSON.stringify({
          decomposition: {
            id: DECOMPOSITION_ID,
            status: "ready",
            specDocumentId: SPEC_ID,
            repoSnapshotId: SNAPSHOT_ID,
            manifest: incoming,
            createdAt: "2026-05-07T10:00:00.000Z",
            updatedAt: "2026-05-07T10:00:02.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      method === "POST" &&
      url ===
        `${API_URL}/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/plan-first`
    ) {
      if (!state.planFirstAllowed) {
        return new Response(
          JSON.stringify({ error: "plan already exists" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          planId: PLAN_ID,
          milestoneId: "m01-foundation",
          decompositionId: DECOMPOSITION_ID,
          workflowRunId: "wf-run-2",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "GET" && url === `${API_URL}/plans/${PLAN_ID}`) {
      if (state.planPersisted) {
        return new Response(
          JSON.stringify({ plan: { id: PLAN_ID, status: "approved" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    fetch: fetchFn,
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    sleep: async () => {},
    log: (l) => logs.push(l),
    errLog: (l) => errs.push(l),
    readFile: async (p) => {
      const v = fileFs.get(p);
      if (v === undefined) throw new Error(`no such file: ${p}`);
      return v;
    },
    writeFile: async (p, contents) => {
      fileFs.set(p, contents);
    },
    makeTempfile: async (suggested) => {
      const tmpPath = `/tmp/pm-go/${suggested}`;
      fileFs.set(tmpPath, "");
      return tmpPath;
    },
    openEditor: async (p) => {
      if (editorBehavior === "throws") {
        throw new Error("editor crashed");
      }
      if (editorBehavior === "rewrite-manifest") {
        // Simulate the operator dropping the second milestone.
        const trimmed = makeManifest();
        trimmed.milestones = trimmed.milestones.slice(0, 1);
        fileFs.set(p, JSON.stringify(trimmed, null, 2));
      }
      // noop: leave the file as-is
    },
    basename: (p, ext) => {
      const last = p.split("/").pop() ?? p;
      if (ext && last.endsWith(ext)) return last.slice(0, -ext.length);
      return last;
    },
    logs,
    errs,
  };
}

function makeOptions(overrides: Partial<DecomposeOptions> = {}): DecomposeOptions {
  return {
    repoRoot: "/tmp/repo",
    specPath: "/tmp/spec.md",
    edit: false,
    manifestOnly: false,
    apiUrl: API_URL,
    ...overrides,
  };
}

describe("parseDecomposeArgv", () => {
  it("requires --repo and --spec", () => {
    const a = parseDecomposeArgv(["--spec", "/tmp/x.md"]);
    assert.equal(a.ok, false);
    if (!a.ok) assert.match(a.error, /--repo/);

    const b = parseDecomposeArgv(["--repo", "."]);
    assert.equal(b.ok, false);
    if (!b.ok) assert.match(b.error, /--spec/);
  });

  it("parses all flags and falls back to default port", () => {
    const r = parseDecomposeArgv([
      "--repo",
      ".",
      "--spec",
      "./spec.md",
      "--edit",
      "--manifest-only",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.options.repoRoot, ".");
      assert.equal(r.options.specPath, "./spec.md");
      assert.equal(r.options.edit, true);
      assert.equal(r.options.manifestOnly, true);
      assert.equal(r.options.apiUrl, "http://localhost:3001");
    }
  });

  it("honors --api-url over --port", () => {
    const r = parseDecomposeArgv([
      "--repo",
      ".",
      "--spec",
      "./spec.md",
      "--port",
      "9001",
      "--api-url",
      "http://api.local",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.options.apiUrl, "http://api.local");
  });

  it("rejects unknown flags", () => {
    const r = parseDecomposeArgv([
      "--repo",
      ".",
      "--spec",
      "./spec.md",
      "--bogus",
    ]);
    assert.equal(r.ok, false);
  });

  it("resolves --repo and --spec against the supplied cwd via the injected resolve", () => {
    // Use `path.posix.resolve` so the assertions are stable on every
    // CI platform — the test verifies that the parser THREADS the
    // resolver through, not the resolver's own logic. The same call
    // shape ships in `apps/cli/src/index.ts` for the production
    // dispatcher.
    const r = parseDecomposeArgv(
      ["--repo", ".", "--spec", "./feature.md"],
      {
        cwd: "/Users/op/projects/foo",
        resolve: (base, p) =>
          path.posix.isAbsolute(p) ? p : path.posix.resolve(base, p),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.options.repoRoot, "/Users/op/projects/foo");
      assert.equal(r.options.specPath, "/Users/op/projects/foo/feature.md");
    }
  });

  it("leaves absolute paths untouched even when cwd is provided", () => {
    const r = parseDecomposeArgv(
      ["--repo", "/abs/repo", "--spec", "/abs/spec.md"],
      {
        cwd: "/Users/op",
        resolve: (base, p) =>
          path.posix.isAbsolute(p) ? p : path.posix.resolve(base, p),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.options.repoRoot, "/abs/repo");
      assert.equal(r.options.specPath, "/abs/spec.md");
    }
  });
});

describe("runDecomposeAction", () => {
  it("fails fast with exit 2 when the API answers as a foreign service", async () => {
    const state = makeState({ healthIdentity: "foreign" });
    const fileFs = new Map<string, string>([["/tmp/spec.md", "# spec"]]);
    const deps = makeDeps(state, fileFs);
    const exit = await runDecomposeAction({
      options: makeOptions(),
      deps,
      timings: FAST_TIMINGS,
    });
    assert.equal(exit, 2);
    assert.ok(deps.errs.some((e) => e.includes("[pm-go] port")));
  });

  it("submits + polls + prints + exits 0 on --manifest-only", async () => {
    const state = makeState();
    const fileFs = new Map<string, string>([["/tmp/spec.md", "# spec body"]]);
    const deps = makeDeps(state, fileFs);
    const exit = await runDecomposeAction({
      options: makeOptions({ manifestOnly: true }),
      deps,
      timings: FAST_TIMINGS,
    });
    assert.equal(exit, 0);
    // Manifest JSON should appear in the logs.
    assert.ok(
      deps.logs.some((l) => l.includes('"id": "m01-foundation"')),
      `expected manifest JSON in logs: ${deps.logs.join("\n")}`,
    );
    // plan-first must NOT have been called.
    assert.equal(
      state.calls.some((c) => c.url.endsWith("plan-first")),
      false,
    );
  });

  it("PUTs the edited manifest when --edit is set, then plan-first", async () => {
    const state = makeState();
    const fileFs = new Map<string, string>([["/tmp/spec.md", "# spec"]]);
    const deps = makeDeps(state, fileFs, "rewrite-manifest");
    const exit = await runDecomposeAction({
      options: makeOptions({ edit: true }),
      deps,
      timings: FAST_TIMINGS,
    });
    assert.equal(exit, 0);
    // The PUT call body must reflect the editor's mutation: only one
    // milestone instead of two.
    const put = state.calls.find((c) => c.method === "PUT");
    assert.ok(put, "expected a PUT /manifest call");
    const putBody = (put!.body as { manifest: ManifestFixture }).manifest;
    assert.equal(putBody.milestones.length, 1);
    // plan-first MUST have been called and the GET /plans poll resolved.
    assert.ok(state.calls.some((c) => c.url.endsWith("plan-first")));
    assert.ok(state.calls.some((c) => c.url === `${API_URL}/plans/${PLAN_ID}`));
  });

  it("returns 1 with the error_reason when the decomposition fails", async () => {
    const state = makeState({
      decompositionStatuses: ["pending", "running", "failed"],
      failureReason: "manifest validation failed: missing milestones",
    });
    const fileFs = new Map<string, string>([["/tmp/spec.md", "# spec"]]);
    const deps = makeDeps(state, fileFs);
    const exit = await runDecomposeAction({
      options: makeOptions(),
      deps,
      timings: FAST_TIMINGS,
    });
    assert.equal(exit, 1);
    assert.ok(
      deps.errs.some((e) =>
        e.includes("manifest validation failed: missing milestones"),
      ),
    );
  });

  it("returns 2 when the editor exits non-zero", async () => {
    const state = makeState();
    const fileFs = new Map<string, string>([["/tmp/spec.md", "# spec"]]);
    const deps = makeDeps(state, fileFs, "throws");
    const exit = await runDecomposeAction({
      options: makeOptions({ edit: true }),
      deps,
      timings: FAST_TIMINGS,
    });
    assert.equal(exit, 2);
    assert.ok(deps.errs.some((e) => e.includes("editor exited with error")));
  });
});

describe("decomposeCli", () => {
  it("prints help and returns 0 on --help", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await decomposeCli({
      argv: ["--help"],
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      buildDecomposeDeps: () => {
        throw new Error("must not build deps on --help");
      },
    });
    assert.equal(exit, 0);
    assert.ok(logs.some((l) => l.includes("Usage: pm-go decompose")));
  });

  it("returns 2 with usage when required flags are missing", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await decomposeCli({
      argv: [],
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      buildDecomposeDeps: () => {
        throw new Error("must not build deps on parse error");
      },
    });
    assert.equal(exit, 2);
    assert.ok(errs.some((e) => e.includes("--repo")));
  });
});
