import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createLease } from "../src/create-lease.js";
import { revokeExpiredLease } from "../src/revoke-expired-lease.js";
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

describe("revokeExpiredLease", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let worktreeRoot: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wt-root-"));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it("removes a clean worktree and reports it gone", async () => {
    const lease = await createLease({
      task: buildTask("revoke-clean"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    const result = await revokeExpiredLease({
      worktreePath: lease.worktreePath,
      repoRoot: lease.repoRoot,
      branchName: lease.branchName,
    });

    expect(result).toEqual({
      worktreeRemoved: true,
      branchRemoved: true,
      dirty: false,
    });
    expect(existsSync(lease.worktreePath)).toBe(false);
  });

  it("preserves a dirty worktree and reports dirty=true", async () => {
    const lease = await createLease({
      task: buildTask("revoke-dirty"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    // Create an untracked file → worktree is now dirty.
    await writeFile(join(lease.worktreePath, "leftover.txt"), "wip\n");

    const result = await revokeExpiredLease({
      worktreePath: lease.worktreePath,
      repoRoot: lease.repoRoot,
      branchName: lease.branchName,
    });

    expect(result).toEqual({
      worktreeRemoved: false,
      branchRemoved: false,
      dirty: true,
    });
    expect(existsSync(lease.worktreePath)).toBe(true);
  });
});
