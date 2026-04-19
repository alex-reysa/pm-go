import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createLease } from "../src/create-lease.js";
import { releaseLease } from "../src/release-lease.js";
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

async function branchExists(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  try {
    await exec("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      `refs/heads/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

describe("releaseLease", () => {
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

  it("removes the worktree and branch when the branch has no new commits", async () => {
    const lease = await createLease({
      task: buildTask("no-commits"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    await releaseLease({
      worktreePath: lease.worktreePath,
      repoRoot: lease.repoRoot,
      branchName: lease.branchName,
    });

    expect(existsSync(lease.worktreePath)).toBe(false);
    expect(await branchExists(repo.path, lease.branchName)).toBe(false);
  });

  it("preserves the branch when it carries a commit", async () => {
    const lease = await createLease({
      task: buildTask("with-commit"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    // Make a commit on the agent branch so `rev-list HEAD..<branch>` > 0.
    await writeFile(join(lease.worktreePath, "new-file.txt"), "hello\n");
    await exec("git", ["-C", lease.worktreePath, "add", "."]);
    await exec("git", [
      "-C",
      lease.worktreePath,
      "commit",
      "-m",
      "agent work",
    ]);

    await releaseLease({
      worktreePath: lease.worktreePath,
      repoRoot: lease.repoRoot,
      branchName: lease.branchName,
    });

    expect(existsSync(lease.worktreePath)).toBe(false);
    expect(await branchExists(repo.path, lease.branchName)).toBe(true);
  });

  it("is idempotent — second call is a no-op", async () => {
    const lease = await createLease({
      task: buildTask("idempotent"),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    await releaseLease({
      worktreePath: lease.worktreePath,
      repoRoot: lease.repoRoot,
      branchName: lease.branchName,
    });

    // Second call should not throw.
    await expect(
      releaseLease({
        worktreePath: lease.worktreePath,
        repoRoot: lease.repoRoot,
        branchName: lease.branchName,
      }),
    ).resolves.toBeUndefined();
  });
});
