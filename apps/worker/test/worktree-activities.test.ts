import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Task, WorktreeLease } from "@pm-go/contracts";
import { createWorktreeActivities } from "../src/activities/worktree.js";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const taskFixturePath = resolve(
  __dirname,
  "../../../packages/contracts/src/fixtures/orchestration-review/task.json",
);

async function createTempGitRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pm-go-wta-"));
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@pm-go.dev"], { cwd: dir });
  await exec("git", ["config", "user.name", "test"], { cwd: dir });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "seed"], { cwd: dir });
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function loadTaskFixture(): Task {
  const raw = readFileSync(taskFixturePath, "utf8");
  return JSON.parse(raw) as Task;
}

/**
 * Minimal chainable Drizzle mock: `.insert(...).values(...)` resolves
 * (or rejects if `insertError` set); `.select(...).from(...).where(...).limit(...)`
 * resolves to `selectResult`; `.update(...).set(...).where(...)` resolves.
 */
function makeDbMock(options: {
  insertError?: Error;
  selectResult?: unknown[];
} = {}) {
  const insertValues = vi.fn().mockImplementation(() => {
    if (options.insertError) return Promise.reject(options.insertError);
    return Promise.resolve();
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const limit = vi.fn().mockResolvedValue(options.selectResult ?? []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  return {
    db: { insert, select, update } as unknown as Parameters<typeof createWorktreeActivities>[0]["db"],
    spies: { insert, insertValues, select, from, where, limit, update, set, updateWhere },
  };
}

describe("createWorktreeActivities.leaseWorktree", () => {
  it("creates the worktree on disk and persists the lease row", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      const { db, spies } = makeDbMock();
      const activities = createWorktreeActivities({ db });
      const task = loadTaskFixture();

      const lease = await activities.leaseWorktree({
        task,
        repoRoot: repo.path,
        worktreeRoot,
        maxLifetimeHours: 24,
      });

      expect(lease.status).toBe("active");
      expect(existsSync(lease.worktreePath)).toBe(true);
      expect(spies.insert).toHaveBeenCalledTimes(1);
      expect(spies.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: lease.id,
          taskId: task.id,
          branchName: lease.branchName,
          worktreePath: lease.worktreePath,
          baseSha: lease.baseSha,
          status: "active",
        }),
      );
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("rolls back the on-disk worktree when db insert fails", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      const { db } = makeDbMock({ insertError: new Error("unique constraint") });
      const activities = createWorktreeActivities({ db });
      const task = loadTaskFixture();

      await expect(
        activities.leaseWorktree({
          task,
          repoRoot: repo.path,
          worktreeRoot,
          maxLifetimeHours: 24,
        }),
      ).rejects.toThrow();

      // The worktree directory that the activity would have created
      // should NOT exist after rollback.
      const expectedPath = join(worktreeRoot, task.planId, `${task.id}-${task.slug}`);
      expect(existsSync(expectedPath)).toBe(false);
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("returns the existing active lease on retry (idempotent)", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      const task = loadTaskFixture();
      // Simulate the "first attempt partially succeeded" state by seeding
      // an active-lease row via the select mock. The activity should
      // short-circuit, returning the existing lease WITHOUT calling
      // createLease (which would throw `worktree-already-exists`).
      const existingRow = {
        id: "11111111-2222-4333-8444-555555555555",
        taskId: task.id,
        repoRoot: repo.path,
        branchName: "agent/existing",
        worktreePath: join(worktreeRoot, "existing-worktree"),
        baseSha: "deadbeefcafe",
        expiresAt: "2026-04-20T00:00:00.000Z",
        status: "active" as const,
        createdAt: "2026-04-19T00:00:00.000Z",
      };
      const { db, spies } = makeDbMock({ selectResult: [existingRow] });
      const activities = createWorktreeActivities({ db });

      const lease = await activities.leaseWorktree({
        task,
        repoRoot: repo.path,
        worktreeRoot,
        maxLifetimeHours: 24,
      });

      // No fresh insert happened — idempotent short-circuit.
      expect(spies.insert).not.toHaveBeenCalled();
      expect(lease.id).toBe(existingRow.id);
      expect(lease.worktreePath).toBe(existingRow.worktreePath);
      expect(lease.branchName).toBe(existingRow.branchName);
      expect(lease.baseSha).toBe(existingRow.baseSha);
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });
});

describe("createWorktreeActivities.revokeExpiredLease", () => {
  it("marks the lease 'expired' (not 'revoked') when the worktree is dirty", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      const task = loadTaskFixture();
      // First create a real lease so we have an on-disk worktree.
      const seed = makeDbMock();
      const seedActivities = createWorktreeActivities({ db: seed.db });
      const lease = await seedActivities.leaseWorktree({
        task,
        repoRoot: repo.path,
        worktreeRoot,
        maxLifetimeHours: 24,
      });
      // Dirty it: add an untracked file.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(lease.worktreePath, "DIRTY.txt"), "uncommitted\n");

      const storedRow = {
        ...lease,
        createdAt: new Date().toISOString(),
      };
      const { db, spies } = makeDbMock({ selectResult: [storedRow] });
      const activities = createWorktreeActivities({ db });

      await activities.revokeExpiredLease({ leaseId: lease.id });

      expect(spies.set).toHaveBeenCalledWith({ status: "expired" });
      // Dirty worktree preserved on disk for human review.
      expect(existsSync(lease.worktreePath)).toBe(true);
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });
});
