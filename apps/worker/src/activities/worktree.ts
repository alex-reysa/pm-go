import type { Task, WorktreeLease } from "@pm-go/contracts";
import { planTasks, worktreeLeases, type PmGoDb } from "@pm-go/db";
import { and, eq } from "drizzle-orm";
import {
  createLease,
  releaseLease as releaseLeasePkg,
  detectDirty,
  diffScope,
  revokeExpiredLease as revokePkg,
} from "@pm-go/worktree-manager";

export interface WorktreeActivityDeps {
  db: PmGoDb;
}

/**
 * Build the set of Temporal activities that wrap the worktree-manager
 * pure functions with Drizzle persistence. Activities are intentionally
 * thin: the heavy lifting (git, disk, scope checks) lives in
 * `@pm-go/worktree-manager`, so these wrappers only add database side
 * effects and idempotent lookup-by-id.
 */
export function createWorktreeActivities(deps: WorktreeActivityDeps) {
  return {
    /**
     * Create a new on-disk worktree and persist the lease row.
     *
     * Idempotent with respect to Temporal retries: if an active lease
     * already exists for this task, return it verbatim without touching
     * disk or DB. Temporal may re-run the activity after the worker
     * crashes post-success (before the completion event reaches history),
     * and running `createLease()` a second time would fail with
     * `worktree-already-exists`, turning a recoverable retry into a hard
     * workflow failure.
     *
     * If the DB insert fails for a fresh lease (e.g. the partial unique
     * index fires because another process concurrently inserted an
     * active row), the on-disk worktree is rolled back with
     * `releaseLease(..., force)` so we never leave orphan directories
     * behind.
     */
    async leaseWorktree(input: {
      task: Task;
      repoRoot: string;
      worktreeRoot: string;
      maxLifetimeHours: number;
    }): Promise<WorktreeLease> {
      const [existing] = await deps.db
        .select()
        .from(worktreeLeases)
        .where(
          and(
            eq(worktreeLeases.taskId, input.task.id),
            eq(worktreeLeases.status, "active"),
          ),
        )
        .limit(1);
      if (existing) {
        // Re-entry path (Temporal retry or worker restart). The task row
        // may still carry its planner-supplied branch_name from before
        // the first lease landed; re-stamp it from the existing lease so
        // subsequent activities (integrateTask) see the authoritative
        // branch. Idempotent: overwrites with the same value on repeat.
        await deps.db
          .update(planTasks)
          .set({
            branchName: existing.branchName,
            worktreePath: existing.worktreePath,
          })
          .where(eq(planTasks.id, input.task.id));
        return {
          id: existing.id,
          ...(existing.taskId !== null ? { taskId: existing.taskId } : {}),
          ...(existing.phaseId !== null ? { phaseId: existing.phaseId } : {}),
          kind: existing.kind,
          repoRoot: existing.repoRoot,
          branchName: existing.branchName,
          worktreePath: existing.worktreePath,
          baseSha: existing.baseSha,
          expiresAt: existing.expiresAt,
          status: existing.status,
        };
      }
      const lease = await createLease(input);
      try {
        // Single transaction so the lease row and the task-row stamp
        // commit together. If the plan_tasks update fails after the
        // lease insert, both writes roll back and the outer catch
        // reclaims the on-disk worktree — no orphan rows, no divergent
        // branch_name.
        await deps.db.transaction(async (tx) => {
          await tx.insert(worktreeLeases).values({
            id: lease.id,
            taskId: lease.taskId,
            repoRoot: lease.repoRoot,
            branchName: lease.branchName,
            worktreePath: lease.worktreePath,
            baseSha: lease.baseSha,
            expiresAt: lease.expiresAt,
            status: lease.status,
          });
          await tx
            .update(planTasks)
            .set({
              branchName: lease.branchName,
              worktreePath: lease.worktreePath,
            })
            .where(eq(planTasks.id, input.task.id));
        });
      } catch (err) {
        // Roll back the on-disk worktree so we don't leave orphans. The
        // transaction itself rolls back both DB writes.
        await releaseLeasePkg({
          worktreePath: lease.worktreePath,
          repoRoot: lease.repoRoot,
          branchName: lease.branchName,
          force: true,
        }).catch(() => undefined);
        throw err;
      }
      return lease;
    },

    /**
     * Release an active lease. Loads the stored row by id so activity
     * callers only need to pass the lease id (the row carries the
     * worktree path + branch name).
     */
    async releaseLease(input: { leaseId: string }): Promise<void> {
      const [row] = await deps.db
        .select()
        .from(worktreeLeases)
        .where(eq(worktreeLeases.id, input.leaseId))
        .limit(1);
      if (!row) return;
      await releaseLeasePkg({
        worktreePath: row.worktreePath,
        repoRoot: row.repoRoot,
        branchName: row.branchName,
      });
      await deps.db
        .update(worktreeLeases)
        .set({ status: "released" })
        .where(eq(worktreeLeases.id, input.leaseId));
    },

    /**
     * Revoke an expired lease. If the worktree is dirty, the on-disk
     * state is preserved and the row is marked `expired` for human
     * review. If clean, the worktree is removed and the row moves to
     * `revoked`.
     */
    async revokeExpiredLease(input: { leaseId: string }): Promise<void> {
      const [row] = await deps.db
        .select()
        .from(worktreeLeases)
        .where(eq(worktreeLeases.id, input.leaseId))
        .limit(1);
      if (!row) return;
      const result = await revokePkg({
        worktreePath: row.worktreePath,
        repoRoot: row.repoRoot,
        branchName: row.branchName,
      });
      const nextStatus = result.dirty ? "expired" : "revoked";
      await deps.db
        .update(worktreeLeases)
        .set({ status: nextStatus })
        .where(eq(worktreeLeases.id, input.leaseId));
    },

    async detectDirtyWorktree(input: { worktreePath: string }) {
      return detectDirty(input);
    },

    async diffWorktreeAgainstScope(input: {
      worktreePath: string;
      baseSha: string;
      fileScope: Task["fileScope"];
    }) {
      return diffScope(input);
    },

    /**
     * Load the active lease for a task, or null if none exists. Used by
     * the review + fix workflows to reopen the worktree left behind by
     * TaskExecutionWorkflow without creating a new one.
     */
    async loadLatestLease(input: {
      taskId: string;
    }): Promise<WorktreeLease | null> {
      const [row] = await deps.db
        .select()
        .from(worktreeLeases)
        .where(
          and(
            eq(worktreeLeases.taskId, input.taskId),
            eq(worktreeLeases.status, "active"),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        ...(row.taskId !== null ? { taskId: row.taskId } : {}),
        ...(row.phaseId !== null ? { phaseId: row.phaseId } : {}),
        kind: row.kind,
        repoRoot: row.repoRoot,
        branchName: row.branchName,
        worktreePath: row.worktreePath,
        baseSha: row.baseSha,
        expiresAt: row.expiresAt,
        status: row.status,
      };
    },
  };
}
