import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createLease } from "../src/create-lease.js";
import { diffScope } from "../src/diff-scope.js";
import { createTempGitRepo } from "./git-helpers.js";

const exec = promisify(execFile);

function buildTask(slug: string): Task {
  return {
    id: "task-01",
    planId: "plan-01",
    phaseId: "phase-01",
    slug,
    title: "t",
    summary: "",
    kind: "implementation",
    status: "pending",
    riskLevel: "low",
    fileScope: { includes: ["**"] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 30 },
    reviewerPolicy: {
      required: false,
      strictness: "standard",
      maxCycles: 1,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 1,
  };
}

async function writeFileEnsuringDir(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("diffScope", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let worktreeRoot: string;
  let worktreePath: string;
  let baseSha: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wt-root-"));
    const lease = await createLease({
      task: buildTask("diff-scope"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });
    worktreePath = lease.worktreePath;
    baseSha = lease.baseSha;
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it("returns empty results when nothing has changed", async () => {
    const result = await diffScope({
      worktreePath,
      baseSha,
      fileScope: { includes: ["src/**"] },
    });
    expect(result.changedFiles).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("lists committed files inside the include glob without violating scope", async () => {
    const filePath = join(worktreePath, "src", "feature.ts");
    await writeFileEnsuringDir(filePath, "export const x = 1;\n");
    await exec("git", ["-C", worktreePath, "add", "."]);
    await exec("git", ["-C", worktreePath, "commit", "-m", "add feature"]);

    const result = await diffScope({
      worktreePath,
      baseSha,
      fileScope: { includes: ["src/**"] },
    });
    expect(result.changedFiles).toContain("src/feature.ts");
    expect(result.violations).not.toContain("src/feature.ts");
  });

  it("lists untracked in-scope files without flagging them as violations", async () => {
    const filePath = join(worktreePath, "src", "untracked.ts");
    await writeFileEnsuringDir(filePath, "export const y = 2;\n");

    const result = await diffScope({
      worktreePath,
      baseSha,
      fileScope: { includes: ["src/**"] },
    });
    expect(result.changedFiles).toContain("src/untracked.ts");
    expect(result.violations).not.toContain("src/untracked.ts");
  });

  it("flags changes outside `fileScope.includes` as violations", async () => {
    const filePath = join(worktreePath, "docs", "note.md");
    await writeFileEnsuringDir(filePath, "forbidden\n");

    const result = await diffScope({
      worktreePath,
      baseSha,
      fileScope: { includes: ["src/**"] },
    });
    expect(result.changedFiles).toContain("docs/note.md");
    expect(result.violations).toContain("docs/note.md");
  });

  it("treats `fileScope.excludes` as overriding includes", async () => {
    const filePath = join(worktreePath, "src", "legacy", "old.ts");
    await writeFileEnsuringDir(filePath, "export const z = 3;\n");

    const result = await diffScope({
      worktreePath,
      baseSha,
      fileScope: {
        includes: ["src/**"],
        excludes: ["src/legacy/**"],
      },
    });
    expect(result.changedFiles).toContain("src/legacy/old.ts");
    expect(result.violations).toContain("src/legacy/old.ts");
  });
});
