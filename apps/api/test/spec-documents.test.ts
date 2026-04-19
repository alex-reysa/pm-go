import { describe, it, expect, vi } from "vitest";

import type { RepoSnapshot } from "@pm-go/contracts";
import { RepoIntelligenceError } from "@pm-go/repo-intelligence";

import { createApp } from "../src/app.js";

function makeMockDb() {
  const values = vi.fn().mockResolvedValue([]);
  const insert = vi.fn().mockImplementation(() => ({ values }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = { insert } as any;
  return { db, insert, values };
}

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-abc",
    workflowId: "wf-abc",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

function makeSnapshot(id: string): RepoSnapshot {
  return {
    id,
    repoRoot: "/tmp/repo",
    defaultBranch: "main",
    headSha: "abc123",
    languageHints: ["typescript"],
    frameworkHints: [],
    buildCommands: ["pnpm build"],
    testCommands: ["pnpm test"],
    ciConfigPaths: [],
    capturedAt: "2026-04-18T10:00:00.000Z",
  };
}

describe("POST /spec-documents", () => {
  it("returns 201 with specDocumentId + repoSnapshotId on happy path", async () => {
    const { db, insert, values } = makeMockDb();
    const { client } = makeMockTemporal();
    const snapshotId = "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00";
    const collectRepoSnapshot = vi.fn().mockResolvedValue(makeSnapshot(snapshotId));

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/repo/.worktrees",
      maxLifetimeHours: 24,
      collectRepoSnapshot,
    });

    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Test spec",
        body: "# Test\nbody contents",
        repoRoot: "/tmp/repo",
        source: "manual",
      }),
    });

    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      specDocumentId: string;
      repoSnapshotId: string;
    };
    expect(typeof payload.specDocumentId).toBe("string");
    expect(payload.specDocumentId.length).toBeGreaterThan(0);
    expect(payload.repoSnapshotId).toBe(snapshotId);

    // Inserted once for spec_documents and once for repo_snapshots.
    expect(insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledTimes(2);
    expect(collectRepoSnapshot).toHaveBeenCalledWith({ repoRoot: "/tmp/repo" });
  });

  it("returns 400 when title is missing", async () => {
    const { db } = makeMockDb();
    const { client } = makeMockTemporal();
    const collectRepoSnapshot = vi.fn();

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/repo/.worktrees",
      maxLifetimeHours: 24,
      collectRepoSnapshot,
    });

    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "body",
        repoRoot: "/tmp/repo",
      }),
    });

    expect(res.status).toBe(400);
    expect(collectRepoSnapshot).not.toHaveBeenCalled();
  });

  it("returns 400 when repoRoot is missing", async () => {
    const { db } = makeMockDb();
    const { client } = makeMockTemporal();

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/repo/.worktrees",
      maxLifetimeHours: 24,
      collectRepoSnapshot: vi.fn(),
    });

    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Test",
        body: "body",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the repo is not a git repo", async () => {
    const { db } = makeMockDb();
    const { client } = makeMockTemporal();
    const collectRepoSnapshot = vi
      .fn()
      .mockRejectedValue(
        new RepoIntelligenceError(
          "not-a-git-repo",
          "/tmp/not-git is not a git repository",
        ),
      );

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/repo/.worktrees",
      maxLifetimeHours: 24,
      collectRepoSnapshot,
    });

    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Test",
        body: "body",
        repoRoot: "/tmp/not-git",
      }),
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; code?: string };
    expect(payload.error).toContain("repo-intelligence failed");
    expect(payload.code).toBe("not-a-git-repo");
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const { db } = makeMockDb();
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/repo/.worktrees",
      maxLifetimeHours: 24,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
