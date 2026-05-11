import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createLease } from "../src/create-lease.js";
import { WorktreeManagerError } from "../src/errors.js";
import { createTempGitRepo } from "./git-helpers.js";

const exec = promisify(execFile);

// Short, git-safe IDs keep the resulting branch name inside the 80-char body
// cap so the full slug survives truncation — tests can then match on the
// expected suffix without worrying about per-fixture length.
const PLAN_ID = "plan-01";
const TASK_ID = "task-01";

function buildTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: TASK_ID,
    planId: PLAN_ID,
    phaseId: "phase-01",
    slug: "add-feature-x",
    title: "Add feature X",
    summary: "",
    kind: "implementation",
    status: "pending",
    riskLevel: "low",
    fileScope: { includes: ["src/**"] },
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
  return { ...base, ...overrides };
}

describe("createLease", () => {
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

  it("creates a worktree with the agent branch checked out", async () => {
    const task = buildTask();
    const lease = await createLease({
      task,
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    expect(existsSync(lease.worktreePath)).toBe(true);
    expect(lease.status).toBe("active");
    expect(lease.branchName).toMatch(/^agent\/plan-01\/task-01-add-feature-x$/);

    const { stdout } = await exec("git", [
      "-C",
      lease.worktreePath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(stdout.trim()).toBe(lease.branchName);
  });

  it("rejects a non-git directory with code 'not-a-git-repo'", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "pm-go-nogit-"));
    try {
      await expect(
        createLease({
          task: buildTask(),
          repoRoot: notARepo,
          worktreeRoot,
          maxLifetimeHours: 1,
        }),
      ).rejects.toMatchObject({
        name: "WorktreeManagerError",
        code: "not-a-git-repo",
      });
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it("rejects when the worktree path already exists", async () => {
    const task = buildTask();
    await createLease({
      task,
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    await expect(
      createLease({
        task,
        repoRoot: repo.path,
        worktreeRoot,
        maxLifetimeHours: 1,
      }),
    ).rejects.toMatchObject({
      name: "WorktreeManagerError",
      code: "worktree-already-exists",
    });
  });

  it("honours injected `now` + `maxLifetimeHours` for `expiresAt`", async () => {
    const fixedNow = new Date("2026-04-18T12:00:00.000Z");
    const lease = await createLease({
      task: buildTask(),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 2,
      now: () => fixedNow,
    });

    expect(lease.expiresAt).toBe("2026-04-18T14:00:00.000Z");
  });

  it("echoes the injected `newUuid` into `lease.id`", async () => {
    const fakeId = "11111111-2222-4333-8444-555555555555";
    const lease = await createLease({
      task: buildTask(),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
      newUuid: () => fakeId,
    });

    expect(lease.id).toBe(fakeId);
  });

  it("forks the agent branch from the supplied `baseSha` (phase snapshot override)", async () => {
    // Regression for bug #11: pre-fix, createLease always passed `HEAD`
    // to `git worktree add`, so Phase N+1 task worktrees branched off
    // the working repo's current HEAD instead of the phase's recorded
    // `base_snapshot_id → repo_snapshots.head_sha`. After an
    // override-audit run (main intentionally NOT fast-forwarded),
    // Phase N+1's worktrees would miss every commit Phase N landed on
    // the integration branch. The fix threads an optional `baseSha`
    // through `CreateLeaseInput`; this test pins both halves of the
    // contract: (1) the worktree HEAD matches the supplied SHA, not
    // the repo's current HEAD, and (2) `lease.baseSha` echoes the
    // supplied SHA so downstream diff-scope reads from the same
    // baseline.
    const initialHead = (
      await exec("git", ["-C", repo.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    // Advance the working repo's HEAD one commit beyond the snapshot.
    await writeFile(join(repo.path, "drift.txt"), "drift\n");
    await exec("git", ["-C", repo.path, "add", "."]);
    await exec("git", ["-C", repo.path, "commit", "-m", "drift"]);
    const driftedHead = (
      await exec("git", ["-C", repo.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(driftedHead).not.toBe(initialHead);

    const lease = await createLease({
      task: buildTask(),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
      baseSha: initialHead,
    });

    // The worktree's HEAD must point at the snapshot SHA, not the
    // working repo's current (drifted) HEAD.
    const worktreeHead = (
      await exec("git", ["-C", lease.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(worktreeHead).toBe(initialHead);
    expect(worktreeHead).not.toBe(driftedHead);

    // The persisted lease.baseSha mirrors the supplied SHA so
    // diff-scope downstream reads from the right base.
    expect(lease.baseSha).toBe(initialHead);
  });

  it("falls back to working-repo HEAD when no `baseSha` is supplied", async () => {
    // Back-compat: golden-path tests and sample-repo flows don't
    // record phase snapshots. The activity layer falls through to
    // undefined `baseSha`; createLease must keep the legacy behavior.
    const headSha = (
      await exec("git", ["-C", repo.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    const lease = await createLease({
      task: buildTask(),
      repoRoot: repo.path,
      worktreeRoot,
      maxLifetimeHours: 1,
    });

    expect(lease.baseSha).toBe(headSha);
    const worktreeHead = (
      await exec("git", ["-C", lease.worktreePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(worktreeHead).toBe(headSha);
  });

  it("surfaces WorktreeManagerError — never a raw Error", async () => {
    // Confirms the error type is the tagged class the orchestrator branches on.
    try {
      await createLease({
        task: buildTask(),
        repoRoot: join(worktreeRoot, "does-not-exist"),
        worktreeRoot,
        maxLifetimeHours: 1,
      });
      throw new Error("expected createLease to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeManagerError);
    }
  });
});
