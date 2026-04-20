import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { createApp } from "../src/app.js";

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-artifact-xyz",
    workflowId: "wf-artifact-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockImplementation(() => chain);
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const ARTIFACT_ID = "11111111-2222-4333-8444-555555555555";

function appWith(
  artifactDir: string,
  rowsPerSelect: unknown[][],
): ReturnType<typeof createApp> {
  const { client } = makeMockTemporal();
  const db = makeMockDbForLookup(rowsPerSelect);
  return createApp({
    temporal: client,
    taskQueue: "pm-go-worker",
    db,
    artifactDir,
    repoRoot: "/tmp/repo",
    worktreeRoot: "/tmp/repo/.worktrees",
    maxLifetimeHours: 24,
  });
}

describe("GET /artifacts/:id", () => {
  let artifactDir: string;
  let otherDir: string;

  beforeEach(async () => {
    artifactDir = await mkdtemp(path.join(tmpdir(), "pm-go-artifacts-"));
    otherDir = await mkdtemp(path.join(tmpdir(), "pm-go-elsewhere-"));
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  });

  it("returns 400 when the id isn't a UUID", async () => {
    const app = appWith(artifactDir, []);
    const res = await app.request("/artifacts/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the artifact row is missing", async () => {
    const app = appWith(artifactDir, [[]]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(404);
  });

  it("streams bytes with text/markdown for a pr_summary that resolves inside the artifact dir", async () => {
    const mdPath = path.join(artifactDir, "summary.md");
    await writeFile(mdPath, "# hello\nworld\n", "utf8");
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: pathToFileURL(mdPath).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body).toBe("# hello\nworld\n");
  });

  it("streams bytes with application/json for a completion_evidence_bundle", async () => {
    const jsonPath = path.join(artifactDir, "evidence.json");
    const payload = { planId: "abc", phaseAuditReportIds: ["x", "y"] };
    await writeFile(jsonPath, JSON.stringify(payload), "utf8");
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "completion_evidence_bundle",
          uri: pathToFileURL(jsonPath).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(payload);
  });

  it("returns 403 when the URI points outside the artifact directory", async () => {
    const outsidePath = path.join(otherDir, "leak.md");
    await writeFile(outsidePath, "secret", "utf8");
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: pathToFileURL(outsidePath).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 when the path resolves through a symlink that escapes the artifact dir", async () => {
    // A symlink INSIDE artifactDir pointing OUTSIDE to a secret file.
    // Realpath must resolve the symlink and block the containment check.
    const secretPath = path.join(otherDir, "secret.md");
    await writeFile(secretPath, "leaked content", "utf8");
    const symlinkPath = path.join(artifactDir, "decoy.md");
    await symlink(secretPath, symlinkPath);
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: pathToFileURL(symlinkPath).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 when the path resolves to a directory instead of a file", async () => {
    const subDir = path.join(artifactDir, "nested");
    await mkdir(subDir);
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: pathToFileURL(subDir).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the artifact file doesn't exist on disk", async () => {
    const missingPath = path.join(artifactDir, "missing.md");
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: pathToFileURL(missingPath).href,
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the URI is non-file (e.g. https://)", async () => {
    const app = appWith(artifactDir, [
      [
        {
          id: ARTIFACT_ID,
          kind: "pr_summary",
          uri: "https://example.com/summary.md",
        },
      ],
    ]);
    const res = await app.request(`/artifacts/${ARTIFACT_ID}`);
    expect(res.status).toBe(404);
  });
});
