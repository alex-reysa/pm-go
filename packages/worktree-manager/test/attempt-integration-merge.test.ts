import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { abortIntegrationMerge } from "../src/abort-integration-merge.js";
import { attemptIntegrationMerge } from "../src/attempt-integration-merge.js";
import { createIntegrationLease } from "../src/create-integration-lease.js";
import { createTempGitRepo } from "./git-helpers.js";

const exec = promisify(execFile);

describe("attemptIntegrationMerge", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let integrationRoot: string;
  let baseSha: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    integrationRoot = await mkdtemp(join(tmpdir(), "pm-go-int-root-"));
    const { stdout } = await exec("git", ["-C", repo.path, "rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(integrationRoot, { recursive: true, force: true });
  });

  /** Create a task branch at baseSha, add one commit, return its name. */
  async function makeTaskBranch(name: string, file: string, contents: string): Promise<void> {
    await exec("git", ["-C", repo.path, "branch", name, baseSha]);
    const tempWt = await mkdtemp(join(tmpdir(), "pm-go-task-"));
    await exec("git", ["-C", repo.path, "worktree", "add", tempWt, name]);
    await writeFile(join(tempWt, file), contents);
    await exec("git", ["-C", tempWt, "add", file]);
    await exec("git", ["-C", tempWt, "commit", "-m", `change on ${name}`]);
    await exec("git", ["-C", repo.path, "worktree", "remove", "--force", tempWt]);
  }

  it("merges a non-conflicting task branch with a merge commit (status=merged)", async () => {
    await makeTaskBranch("task-a", "a.txt", "a\n");

    const lease = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "p1",
      phaseId: "ph0",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });

    const result = await attemptIntegrationMerge({
      integrationWorktreePath: lease.worktreePath,
      taskBranchName: "task-a",
    });

    expect(result.status).toBe("merged");
    if (result.status !== "merged") throw new Error("unreachable");
    expect(result.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    // Should be a merge commit (two parents).
    const { stdout: parents } = await exec("git", [
      "-C",
      lease.worktreePath,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ]);
    const parentCount = parents.trim().split(/\s+/).length - 1;
    expect(parentCount).toBe(2);
  });

  it("returns status=conflict with conflictedPaths and leaves the worktree clean (auto-abort)", async () => {
    // Two branches touching the same file with divergent content produce
    // a conflict when the second is merged into the integration branch.
    await exec("git", ["-C", repo.path, "branch", "task-a", baseSha]);
    await exec("git", ["-C", repo.path, "branch", "task-b", baseSha]);

    const wtA = await mkdtemp(join(tmpdir(), "pm-go-taska-"));
    await exec("git", ["-C", repo.path, "worktree", "add", wtA, "task-a"]);
    await writeFile(join(wtA, "conflict.txt"), "A\n");
    await exec("git", ["-C", wtA, "add", "conflict.txt"]);
    await exec("git", ["-C", wtA, "commit", "-m", "A"]);
    await exec("git", ["-C", repo.path, "worktree", "remove", "--force", wtA]);

    const wtB = await mkdtemp(join(tmpdir(), "pm-go-taskb-"));
    await exec("git", ["-C", repo.path, "worktree", "add", wtB, "task-b"]);
    await writeFile(join(wtB, "conflict.txt"), "B\n");
    await exec("git", ["-C", wtB, "add", "conflict.txt"]);
    await exec("git", ["-C", wtB, "commit", "-m", "B"]);
    await exec("git", ["-C", repo.path, "worktree", "remove", "--force", wtB]);

    const lease = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "p1",
      phaseId: "ph0",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });

    // First merge succeeds.
    const first = await attemptIntegrationMerge({
      integrationWorktreePath: lease.worktreePath,
      taskBranchName: "task-a",
    });
    expect(first.status).toBe("merged");

    // Second merge conflicts on conflict.txt.
    const second = await attemptIntegrationMerge({
      integrationWorktreePath: lease.worktreePath,
      taskBranchName: "task-b",
    });
    expect(second.status).toBe("conflict");
    if (second.status !== "conflict") throw new Error("unreachable");
    expect(second.conflictedPaths).toContain("conflict.txt");

    // Worktree must be clean of the aborted merge — `git status
    // --porcelain=v1` returns empty when there are no in-progress merges
    // or uncommitted changes.
    const { stdout: status } = await exec("git", [
      "-C",
      lease.worktreePath,
      "status",
      "--porcelain=v1",
    ]);
    expect(status.trim()).toBe("");
  });
});

describe("abortIntegrationMerge", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let integrationRoot: string;
  let baseSha: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    integrationRoot = await mkdtemp(join(tmpdir(), "pm-go-int-root-"));
    const { stdout } = await exec("git", ["-C", repo.path, "rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(integrationRoot, { recursive: true, force: true });
  });

  it("is idempotent: succeeds even when no merge is in progress", async () => {
    const lease = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "p1",
      phaseId: "ph0",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });
    await expect(
      abortIntegrationMerge({
        integrationWorktreePath: lease.worktreePath,
      }),
    ).resolves.toBeUndefined();
  });
});
