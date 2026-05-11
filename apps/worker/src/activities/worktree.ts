import type { Task, WorktreeLease } from "@pm-go/contracts";
import {
  phases,
  planTasks,
  plans,
  repoSnapshots,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import { and, eq } from "drizzle-orm";
import {
  createLease,
  releaseLease as releaseLeasePkg,
  detectDirty,
  diffScope,
  revokeExpiredLease as revokePkg,
} from "@pm-go/worktree-manager";
import { createSpanWriter, withSpan } from "@pm-go/observability";

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
      const sink = createSpanWriter({
        db: deps.db,
        planId: input.task.planId,
      }).writeSpan;
      return withSpan(
        "worker.activities.worktree.leaseWorktree",
        {
          planId: input.task.planId,
          taskId: input.task.id,
          taskSlug: input.task.slug,
        },
        () => leaseWorktreeImpl(deps.db, input),
        { sink },
      );
    },

    async releaseLease(input: { leaseId: string }): Promise<void> {
      return releaseLeaseImpl(deps.db, input);
    },

    async revokeExpiredLease(input: { leaseId: string }): Promise<void> {
      return revokeExpiredLeaseImpl(deps.db, input);
    },

    async detectDirtyWorktree(input: { worktreePath: string }) {
      return detectDirty(input);
    },

    async diffWorktreeAgainstScope(input: {
      worktreePath: string;
      baseSha: string;
      fileScope: Task["fileScope"];
      /** When present, the plan's `autoApproveLowRisk` flag is forwarded
       *  as `allowBenignExpansion` to {@link diffScope}. */
      taskId?: string;
    }) {
      const allowBenignExpansion = input.taskId
        ? await loadPlanForTask(deps.db, input.taskId)
        : false;
      return diffScope({ ...input, allowBenignExpansion });
    },

    async loadLatestLease(input: {
      taskId: string;
    }): Promise<WorktreeLease | null> {
      return loadLatestLeaseImpl(deps.db, input);
    },
  };
}

async function leaseWorktreeImpl(
  db: PmGoDb,
  input: {
    task: Task;
    repoRoot: string;
    worktreeRoot: string;
    maxLifetimeHours: number;
  },
): Promise<WorktreeLease> {
  const [existing] = await db
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
    await db
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
  // Resolve the phase's recorded base SHA so the agent branch forks
  // from `phases.base_snapshot_id → repo_snapshots.head_sha` rather
  // than the working repo's current `HEAD`. Without this, an
  // override-audit run (where `main` is intentionally NOT
  // fast-forwarded) leaves Phase N+1 worktrees branching off stale
  // main and missing every commit Phase N landed. The lookup is
  // deterministic and idempotent across Temporal retries: the phase's
  // base_snapshot_id changes only when the integration activity
  // advances it for the next phase, so re-running this activity
  // produces the same SHA. Lookup failures fall through to the
  // working-repo HEAD fallback inside `createLease` (preserves
  // golden-path tests + sample-repo flows that haven't recorded a
  // phase snapshot).
  const baseSha = await resolvePhaseBaseSha(db, input.task.phaseId);
  const lease = await createLease({ ...input, ...(baseSha ? { baseSha } : {}) });
  try {
    // Single transaction so the lease row and the task-row stamp
    // commit together. If the plan_tasks update fails after the
    // lease insert, both writes roll back and the outer catch
    // reclaims the on-disk worktree — no orphan rows, no divergent
    // branch_name.
    await db.transaction(async (tx) => {
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
}

async function releaseLeaseImpl(
  db: PmGoDb,
  input: { leaseId: string },
): Promise<void> {
  const [row] = await db
    .select()
    .from(worktreeLeases)
    .where(eq(worktreeLeases.id, input.leaseId))
    .limit(1);
  if (!row) return;
  const planId = await resolvePlanIdForLeaseRow(db, row);
  const sink = planId
    ? createSpanWriter({ db, planId }).writeSpan
    : undefined;
  await withSpan(
    "worker.activities.worktree.releaseLease",
    {
      ...(planId ? { planId } : {}),
      leaseId: input.leaseId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.phaseId ? { phaseId: row.phaseId } : {}),
    },
    async () => {
      await releaseLeasePkg({
        worktreePath: row.worktreePath,
        repoRoot: row.repoRoot,
        branchName: row.branchName,
      });
      await db
        .update(worktreeLeases)
        .set({ status: "released" })
        .where(eq(worktreeLeases.id, input.leaseId));
    },
    sink ? { sink } : {},
  );
}

async function revokeExpiredLeaseImpl(
  db: PmGoDb,
  input: { leaseId: string },
): Promise<void> {
  const [row] = await db
    .select()
    .from(worktreeLeases)
    .where(eq(worktreeLeases.id, input.leaseId))
    .limit(1);
  if (!row) return;
  const planId = await resolvePlanIdForLeaseRow(db, row);
  const sink = planId
    ? createSpanWriter({ db, planId }).writeSpan
    : undefined;
  await withSpan(
    "worker.activities.worktree.revokeExpiredLease",
    {
      ...(planId ? { planId } : {}),
      leaseId: input.leaseId,
    },
    async () => {
      const result = await revokePkg({
        worktreePath: row.worktreePath,
        repoRoot: row.repoRoot,
        branchName: row.branchName,
      });
      const nextStatus = result.dirty ? "expired" : "revoked";
      await db
        .update(worktreeLeases)
        .set({ status: nextStatus })
        .where(eq(worktreeLeases.id, input.leaseId));
    },
    sink ? { sink } : {},
  );
}

async function loadLatestLeaseImpl(
  db: PmGoDb,
  input: { taskId: string },
): Promise<WorktreeLease | null> {
  const [row] = await db
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
}

/**
 * Resolve a phase's recorded base SHA via
 * `phases.base_snapshot_id → repo_snapshots.head_sha`. Returns `null`
 * when either row is missing (which causes `createLease` to fall back
 * to working-repo `HEAD` — safe default for sample-repo / golden-path
 * flows that don't record snapshots). The lookup is read-only and
 * idempotent across Temporal retries.
 */
async function resolvePhaseBaseSha(
  db: PmGoDb,
  phaseId: string,
): Promise<string | null> {
  const [phaseRow] = await db
    .select({ baseSnapshotId: phases.baseSnapshotId })
    .from(phases)
    .where(eq(phases.id, phaseId))
    .limit(1);
  if (!phaseRow) return null;
  const [snapRow] = await db
    .select({ headSha: repoSnapshots.headSha })
    .from(repoSnapshots)
    .where(eq(repoSnapshots.id, phaseRow.baseSnapshotId))
    .limit(1);
  return snapRow?.headSha ?? null;
}

/**
 * Look up the plan associated with `taskId` and return its
 * `autoApproveLowRisk` flag. Returns `false` if the task or plan row
 * cannot be found (safe default — no benign expansion).
 */
async function loadPlanForTask(
  db: PmGoDb,
  taskId: string,
): Promise<boolean> {
  const [taskRow] = await db
    .select({ planId: planTasks.planId })
    .from(planTasks)
    .where(eq(planTasks.id, taskId))
    .limit(1);
  if (!taskRow) return false;

  const [planRow] = await db
    .select({ autoApproveLowRisk: plans.autoApproveLowRisk })
    .from(plans)
    .where(eq(plans.id, taskRow.planId))
    .limit(1);
  return planRow?.autoApproveLowRisk ?? false;
}

async function resolvePlanIdForLeaseRow(
  db: PmGoDb,
  row: { taskId: string | null; phaseId: string | null },
): Promise<string | null> {
  if (row.taskId) {
    const [taskRow] = await db
      .select({ planId: planTasks.planId })
      .from(planTasks)
      .where(eq(planTasks.id, row.taskId))
      .limit(1);
    return taskRow?.planId ?? null;
  }
  // Integration leases carry phaseId not taskId; the integration
  // activity already span-wraps releaseIntegrationLease (different
  // entry point) so this is a defensive fallback only.
  return null;
}
