import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorktreeManagerError } from "../src/errors.js";
import { fastForwardMainViaUpdateRef } from "../src/fast-forward-main.js";
import { createTempGitRepo } from "./git-helpers.js";

const exec = promisify(execFile);

describe("fastForwardMainViaUpdateRef", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let baseSha: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    const { stdout } = await exec("git", [
      "-C",
      repo.path,
      "rev-parse",
      "HEAD",
    ]);
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** Produce a descendant commit of `baseSha` on a new branch, return its SHA. */
  async function makeDescendantCommit(branchName: string): Promise<string> {
    await exec("git", ["-C", repo.path, "branch", branchName, baseSha]);
    const wt = await mkdtemp(join(tmpdir(), "pm-go-desc-"));
    await exec("git", ["-C", repo.path, "worktree", "add", wt, branchName]);
    await writeFile(join(wt, "descendant.txt"), "x\n");
    await exec("git", ["-C", wt, "add", "descendant.txt"]);
    await exec("git", ["-C", wt, "commit", "-m", "descendant"]);
    const { stdout } = await exec("git", ["-C", wt, "rev-parse", "HEAD"]);
    await exec("git", ["-C", repo.path, "worktree", "remove", "--force", wt]);
    return stdout.trim();
  }

  it("advances main to a descendant sha without changing the checked-out branch", async () => {
    const newSha = await makeDescendantCommit("integration/p1/phase-0");

    const { stdout: beforeRef } = await exec("git", [
      "-C",
      repo.path,
      "symbolic-ref",
      "HEAD",
    ]);

    const result = await fastForwardMainViaUpdateRef({
      repoRoot: repo.path,
      newSha,
      expectedCurrentSha: baseSha,
    });
    expect(result.headSha).toBe(newSha);

    // main now points at newSha.
    const { stdout: mainSha } = await exec("git", [
      "-C",
      repo.path,
      "rev-parse",
      "refs/heads/main",
    ]);
    expect(mainSha.trim()).toBe(newSha);

    // HEAD symbolic-ref unchanged (no checkout happened).
    const { stdout: afterRef } = await exec("git", [
      "-C",
      repo.path,
      "symbolic-ref",
      "HEAD",
    ]);
    expect(afterRef.trim()).toBe(beforeRef.trim());
  });

  it("refuses with main-advance-conflict when main moved underneath", async () => {
    const newSha = await makeDescendantCommit("integration/p1/phase-0");

    // Simulate concurrent push: somebody else already advanced main to
    // `intermediate` while our phase was auditing. Our expectedCurrentSha
    // is the stale baseSha.
    const intermediateSha = await makeDescendantCommit("other-branch");
    await exec("git", [
      "-C",
      repo.path,
      "update-ref",
      "refs/heads/main",
      intermediateSha,
    ]);

    await expect(
      fastForwardMainViaUpdateRef({
        repoRoot: repo.path,
        newSha,
        expectedCurrentSha: baseSha, // stale
      }),
    ).rejects.toMatchObject({
      code: "main-advance-conflict",
    } satisfies Partial<WorktreeManagerError>);
  });

  it("refuses with non-fast-forward when newSha isn't a descendant of expectedCurrentSha", async () => {
    // Build a divergent branch — not a descendant of baseSha. Easiest
    // way: create a fresh orphan commit via `git commit-tree`.
    const { stdout: emptyTree } = await exec("git", [
      "-C",
      repo.path,
      "write-tree",
    ]);
    const { stdout: orphanSha } = await exec(
      "git",
      [
        "-C",
        repo.path,
        "commit-tree",
        emptyTree.trim(),
        "-m",
        "orphan",
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@pm-go.dev",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@pm-go.dev",
        },
      },
    );

    await expect(
      fastForwardMainViaUpdateRef({
        repoRoot: repo.path,
        newSha: orphanSha.trim(),
        expectedCurrentSha: baseSha,
      }),
    ).rejects.toMatchObject({
      code: "non-fast-forward",
    } satisfies Partial<WorktreeManagerError>);
  });
});
