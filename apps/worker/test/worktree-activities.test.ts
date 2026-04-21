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
 * Minimal chainable Drizzle mock supporting:
 *   - `.insert(...).values(...)` — resolves, or rejects if `insertError`
 *   - `.select(...).from(...).where(...).limit(...)` — resolves to `selectResult`
 *   - `.update(...).set(...).where(...)` — resolves, or rejects if `updateError`
 *   - `.transaction(async tx => ...)` — invokes the callback with a tx
 *     that exposes the same insert/update chain. Rejects the whole tx
 *     and propagates the first callback rejection so the outer activity
 *     catch path runs.
 */
function makeDbMock(options: {
  insertError?: Error;
  updateError?: Error;
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
  const updateWhere = vi.fn().mockImplementation(() => {
    if (options.updateError) return Promise.reject(options.updateError);
    return Promise.resolve();
  });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  const transaction = vi.fn().mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      // Give the callback the same insert/update/select surface. Whatever
      // it throws propagates out; for the rollback test we want this to
      // reject so the outer catch runs releaseLeasePkg.
      return cb({ insert, update, select });
    },
  );
  return {
    db: { insert, select, update, transaction } as unknown as Parameters<
      typeof createWorktreeActivities
    >[0]["db"],
    spies: {
      insert,
      insertValues,
      select,
      from,
      where,
      limit,
      update,
      set,
      updateWhere,
      transaction,
    },
  };
}

describe("createWorktreeActivities.leaseWorktree", () => {
  it("creates the worktree, persists the lease, and stamps task.branch_name transactionally", async () => {
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
      // Both lease+task writes happen inside the same transaction.
      // Phase 7 adds a separate `db.insert(workflowEvents)` call after
      // the transaction commits (the span sink), so insert spies fire
      // twice total: once for the lease row, once for the span.
      expect(spies.transaction).toHaveBeenCalledTimes(1);
      expect(spies.insert).toHaveBeenCalledTimes(2);
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
      // plan_tasks.branch_name + worktree_path stamped from the lease so
      // integrateTask (which reads taskRow.branchName) sees the real
      // branch, not the planner-supplied fixture value.
      expect(spies.set).toHaveBeenCalledWith({
        branchName: lease.branchName,
        worktreePath: lease.worktreePath,
      });
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("rolls back the on-disk worktree when the lease insert fails", async () => {
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

      const expectedPath = join(worktreeRoot, task.planId, `${task.id}-${task.slug}`);
      expect(existsSync(expectedPath)).toBe(false);
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("rolls back everything when the plan_tasks stamp inside the transaction fails", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      // Lease insert succeeds, but the plan_tasks update inside the
      // transaction throws. The activity's outer catch must still invoke
      // releaseLeasePkg so the on-disk worktree is reclaimed — lease row
      // and task row both roll back via the transaction abort.
      const { db } = makeDbMock({
        updateError: new Error("plan_tasks update failed"),
      });
      const activities = createWorktreeActivities({ db });
      const task = loadTaskFixture();

      await expect(
        activities.leaseWorktree({
          task,
          repoRoot: repo.path,
          worktreeRoot,
          maxLifetimeHours: 24,
        }),
      ).rejects.toThrow(/plan_tasks update failed/);

      const expectedPath = join(
        worktreeRoot,
        task.planId,
        `${task.id}-${task.slug}`,
      );
      expect(existsSync(expectedPath)).toBe(false);
    } finally {
      await repo.cleanup();
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("re-stamps task.branch_name on the existing-lease early-return path", async () => {
    const repo = await createTempGitRepo();
    const worktreeRoot = await mkdtemp(join(tmpdir(), "pm-go-wtroot-"));
    try {
      const task = loadTaskFixture();
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

      // No fresh worktree-lease insert — short-circuit via the
      // existing lease. Phase 7 wraps leaseWorktree in `withSpan`, which
      // emits a `workflow_events` row through `db.insert(workflowEvents)`
      // — so the spy is called exactly once for the span sink, with
      // workflow_events as the table.
      expect(spies.insert).toHaveBeenCalledTimes(1);
      expect(spies.transaction).not.toHaveBeenCalled();
      expect(lease.id).toBe(existingRow.id);
      // But the task row still gets stamped so Temporal retries / worker
      // restarts leave the durable state consistent with the lease.
      expect(spies.update).toHaveBeenCalledTimes(1);
      expect(spies.set).toHaveBeenCalledWith({
        branchName: existingRow.branchName,
        worktreePath: existingRow.worktreePath,
      });
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
