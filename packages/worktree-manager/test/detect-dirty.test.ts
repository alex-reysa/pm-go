import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createLease } from "../src/create-lease.js";
import { detectDirty } from "../src/detect-dirty.js";
import { createTempGitRepo } from "./git-helpers.js";

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

describe("detectDirty", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let worktreeRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wt-root-"));
    const lease = await createLease({
      task: buildTask("detect-dirty"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });
    worktreePath = lease.worktreePath;
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it("reports clean on a fresh worktree", async () => {
    const report = await detectDirty({ worktreePath });
    expect(report.dirty).toBe(false);
    expect(report.unknownFiles).toEqual([]);
    expect(report.modifiedFiles).toEqual([]);
  });

  it("lists untracked files under `unknownFiles`", async () => {
    await writeFile(join(worktreePath, "scratch.txt"), "hi\n");
    const report = await detectDirty({ worktreePath });
    expect(report.dirty).toBe(true);
    expect(report.unknownFiles).toContain("scratch.txt");
    expect(report.modifiedFiles).toEqual([]);
  });

  it("lists modified tracked files under `modifiedFiles`", async () => {
    // README.md was seeded in the temp repo and is therefore tracked.
    await writeFile(join(worktreePath, "README.md"), "edited\n");
    const report = await detectDirty({ worktreePath });
    expect(report.dirty).toBe(true);
    expect(report.modifiedFiles).toContain("README.md");
    expect(report.unknownFiles).toEqual([]);
  });
});
