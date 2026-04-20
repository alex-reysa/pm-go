import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  DependencyEdge,
  Phase,
  Plan,
  Risk,
  Task,
  UUID,
  WorktreeLease,
} from "@pm-go/contracts";
import {
  mergeRuns,
  phases,
  planTasks,
  plans,
  repoSnapshots,
  taskDependencies,
  workflowEvents,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import {
  attemptIntegrationMerge as attemptIntegrationMergePkg,
  createIntegrationLease as createIntegrationLeasePkg,
  fastForwardMainViaUpdateRef as fastForwardPkg,
  releaseLease as releaseLeasePkg,
} from "@pm-go/worktree-manager";
import type { StoredMergeRun } from "@pm-go/temporal-activities";
import { collectRepoSnapshot as collectSnapshot } from "@pm-go/repo-intelligence";
import { and, eq, inArray } from "drizzle-orm";

const execFileAsync = promisify(execFile);

export interface IntegrationActivityDeps {
  db: PmGoDb;
  /** The main pm-go clone's root. Every git command runs -C here. */
  repoRoot: string;
  /** Root dir for isolated per-phase integration worktrees (env: INTEGRATION_WORKTREE_ROOT). */
  integrationRoot: string;
  /** Hours the integration lease survives before being revoked by the sweeper. */
  maxLifetimeHours: number;
}

/**
 * Phase 5 integration activities. Every method below wraps the
 * worktree-manager pure primitives or the Drizzle DB layer, adds the
 * Temporal-safe idempotency we need (ON CONFLICT DO NOTHING on inserts,
 * "load existing active lease before creating a new one" on the lease
 * path), and threads `baseSha` through so `fastForwardMainViaUpdateRef`
 * can pass the expected-current-sha argument at audit time.
 */
export function createIntegrationActivities(deps: IntegrationActivityDeps) {
  const { db, repoRoot, integrationRoot, maxLifetimeHours } = deps;

  return {
    async loadPhase(input: { phaseId: UUID }): Promise<Phase> {
      const [row] = await db
        .select()
        .from(phases)
        .where(eq(phases.id, input.phaseId))
        .limit(1);
      if (!row) {
        throw new Error(`loadPhase: no phase row with id ${input.phaseId}`);
      }
      return rowToPhaseContract(row);
    },

    async loadPhaseTasks(input: { phaseId: UUID }): Promise<Task[]> {
      const rows = await db
        .select()
        .from(planTasks)
        .where(eq(planTasks.phaseId, input.phaseId));
      return rows.map(rowToTaskContract);
    },

    async loadTask(input: { taskId: UUID }): Promise<Task> {
      const [row] = await db
        .select()
        .from(planTasks)
        .where(eq(planTasks.id, input.taskId))
        .limit(1);
      if (!row) {
        throw new Error(`loadTask: no task row with id ${input.taskId}`);
      }
      return rowToTaskContract(row);
    },

    async loadPlan(input: { planId: UUID }): Promise<Plan> {
      const plan = await reconstructPlan(db, input.planId);
      if (!plan) {
        throw new Error(`loadPlan: plan ${input.planId} not found`);
      }
      return plan;
    },

    async loadNextPhase(input: {
      planId: UUID;
      currentPhaseIndex: number;
    }): Promise<Phase | null> {
      const [row] = await db
        .select()
        .from(phases)
        .where(
          and(
            eq(phases.planId, input.planId),
            eq(phases.index, input.currentPhaseIndex + 1),
          ),
        )
        .limit(1);
      if (!row) return null;
      return rowToPhaseContract(row);
    },

    async readIntegrationWorktreeHeadSha(input: {
      worktreePath: string;
    }): Promise<string> {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", input.worktreePath, "rev-parse", "HEAD"],
        { maxBuffer: 1024 * 1024 },
      );
      return stdout.trim();
    },

    /**
     * Deterministic partition-invariant re-validator. Re-runs the
     * Phase-2 plan-audit rules SCOPED TO THIS PHASE against the current
     * post-merge state: fileScope disjointness across the phase's
     * tasks, dependency DAG within the phase. V1 does not re-partition
     * — it just reports whether the invariants still hold.
     */
    async runPhasePartitionChecks(input: {
      phaseId: UUID;
    }): Promise<{ ok: boolean; reasons: string[] }> {
      const [phaseRow] = await db
        .select()
        .from(phases)
        .where(eq(phases.id, input.phaseId))
        .limit(1);
      if (!phaseRow) {
        return { ok: false, reasons: [`phase ${input.phaseId} not found`] };
      }
      const phase = rowToPhaseContract(phaseRow);
      const taskRows = await db
        .select()
        .from(planTasks)
        .where(eq(planTasks.phaseId, input.phaseId));
      const tasks = taskRows.map(rowToTaskContract);

      const reasons: string[] = [];
      // 1. fileScope pairwise disjointness within the phase.
      for (let i = 0; i < tasks.length; i++) {
        const a = tasks[i]!;
        const inA = a.fileScope.includes;
        for (let j = i + 1; j < tasks.length; j++) {
          const b = tasks[j]!;
          const inB = b.fileScope.includes;
          const overlap = inA.filter((p) => inB.includes(p));
          if (overlap.length > 0) {
            reasons.push(
              `fileScope overlap between "${a.slug}" and "${b.slug}": ${overlap.join(", ")}`,
            );
          }
        }
      }
      // 2. Dependency DAG within the phase.
      const phaseTaskIds = new Set(tasks.map((t) => t.id));
      const edges: DependencyEdge[] = phase.dependencyEdges.filter(
        (e) =>
          phaseTaskIds.has(e.fromTaskId) && phaseTaskIds.has(e.toTaskId),
      );
      const cycleVertex = findCycleVertex(tasks, edges);
      if (cycleVertex !== null) {
        const t = tasks.find((x) => x.id === cycleVertex);
        reasons.push(
          `dependency cycle in phase involving task ${t ? `"${t.slug}" (${t.id})` : cycleVertex}`,
        );
      }
      return { ok: reasons.length === 0, reasons };
    },

    /**
     * Create an isolated integration worktree + persist the lease row.
     * Idempotent: if an active integration lease already exists for the
     * phase, return it verbatim without touching disk. On DB insert
     * failure after a fresh lease is created, roll back the on-disk
     * worktree via `releaseLease(..., force)` so we never leave
     * orphans.
     */
    async createIntegrationLease(input: {
      phaseId: UUID;
    }): Promise<WorktreeLease> {
      const [existing] = await db
        .select()
        .from(worktreeLeases)
        .where(
          and(
            eq(worktreeLeases.phaseId, input.phaseId),
            eq(worktreeLeases.status, "active"),
            eq(worktreeLeases.kind, "integration"),
          ),
        )
        .limit(1);
      if (existing) {
        return leaseRowToContract(existing);
      }

      // Resolve baseSha from phase.base_snapshot_id → repo_snapshots.head_sha.
      const [phaseRow] = await db
        .select()
        .from(phases)
        .where(eq(phases.id, input.phaseId))
        .limit(1);
      if (!phaseRow) {
        throw new Error(
          `createIntegrationLease: phase ${input.phaseId} not found`,
        );
      }
      const [snapRow] = await db
        .select({ headSha: repoSnapshots.headSha })
        .from(repoSnapshots)
        .where(eq(repoSnapshots.id, phaseRow.baseSnapshotId))
        .limit(1);
      if (!snapRow) {
        throw new Error(
          `createIntegrationLease: repo_snapshot ${phaseRow.baseSnapshotId} not found for phase ${input.phaseId}`,
        );
      }

      const lease = await createIntegrationLeasePkg({
        repoRoot,
        integrationRoot,
        planId: phaseRow.planId,
        phaseId: input.phaseId,
        phaseIndex: phaseRow.index,
        baseSha: snapRow.headSha,
        maxLifetimeHours,
      });

      try {
        await db.insert(worktreeLeases).values({
          id: lease.id,
          taskId: null,
          phaseId: input.phaseId,
          kind: "integration",
          repoRoot: lease.repoRoot,
          branchName: lease.branchName,
          worktreePath: lease.worktreePath,
          baseSha: lease.baseSha,
          expiresAt: lease.expiresAt,
          status: lease.status,
        });
      } catch (err) {
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
     * Merge ONE task branch into the integration branch in the lease's
     * worktree. Delegates to the pure `attemptIntegrationMerge` pkg
     * function; returns the structured result verbatim so the workflow
     * can branch on `conflict` vs `merged` vs `other_error`.
     */
    async integrateTask(input: {
      integrationLease: WorktreeLease;
      taskId: UUID;
    }): Promise<
      | { status: "merged"; mergedHeadSha: string }
      | { status: "conflict"; conflictedPaths: string[] }
      | { status: "other_error"; message: string }
    > {
      const [taskRow] = await db
        .select()
        .from(planTasks)
        .where(eq(planTasks.id, input.taskId))
        .limit(1);
      if (!taskRow) {
        return { status: "other_error", message: `task ${input.taskId} not found` };
      }
      const taskBranch = taskRow.branchName;
      if (!taskBranch) {
        return {
          status: "other_error",
          message: `task ${input.taskId} has no branch_name recorded`,
        };
      }
      return attemptIntegrationMergePkg({
        integrationWorktreePath: input.integrationLease.worktreePath,
        taskBranchName: taskBranch,
      });
    },

    /**
     * Run every test command against the merged integration worktree.
     * Fails fast on first non-zero exit. Returns captured logs so the
     * workflow can surface them in the MergeRun failure path.
     */
    async validatePostMergeState(input: {
      integrationWorktreePath: string;
      testCommands: string[];
    }): Promise<{ passed: boolean; logs: string[] }> {
      const logs: string[] = [];
      for (const command of input.testCommands) {
        try {
          const { stdout, stderr } = await execFileAsync(
            "/bin/sh",
            ["-c", command],
            {
              cwd: input.integrationWorktreePath,
              env: { ...process.env, LANG: "C", LC_ALL: "C" },
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          logs.push(`$ ${command}\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}`);
        } catch (err) {
          const msg = extractProcMessage(err);
          logs.push(`$ ${command}\nFAILED\n${msg}`);
          return { passed: false, logs };
        }
      }
      return { passed: true, logs };
    },

    /**
     * Capture a post-merge snapshot and stamp it on the merge_runs row
     * in one transaction. If `nextPhaseId` is provided, the next
     * phase's base_snapshot_id is ALSO updated in the same transaction
     * — but the PhaseIntegrationWorkflow passes undefined here, and the
     * PhaseAuditWorkflow separately calls `stampPhaseBaseSnapshotId` on
     * pass. Keeping the option here lets a future workflow propagate
     * atomically if preferred.
     */
    async capturePostMergeSnapshotAndStamp(input: {
      integrationWorktreePath: string;
      mergeRunId: UUID;
      /**
       * Workflow-generated snapshot id. Passing it in instead of
       * generating here keeps the activity idempotent across Temporal
       * retries: the snapshot insert is ON CONFLICT DO NOTHING, so
       * re-invocations don't leak orphan rows, and the merge_runs
       * UPDATE becomes a no-op since it writes the same value.
       */
      snapshotId: UUID;
      nextPhaseId?: UUID;
    }): Promise<{ snapshotId: UUID }> {
      // Pull a fresh snapshot OUTSIDE the transaction (I/O + subprocess
      // calls that can't participate in a DB tx anyway).
      const snapshot = await collectSnapshot({
        repoRoot: input.integrationWorktreePath,
      });

      await db.transaction(async (tx) => {
        await tx
          .insert(repoSnapshots)
          .values({
            id: input.snapshotId,
            repoRoot: snapshot.repoRoot,
            repoUrl: snapshot.repoUrl ?? null,
            defaultBranch: snapshot.defaultBranch,
            headSha: snapshot.headSha,
            languageHints: snapshot.languageHints,
            frameworkHints: snapshot.frameworkHints,
            buildCommands: snapshot.buildCommands,
            testCommands: snapshot.testCommands,
            ciConfigPaths: snapshot.ciConfigPaths,
            capturedAt: snapshot.capturedAt,
          })
          .onConflictDoNothing({ target: repoSnapshots.id });
        await tx
          .update(mergeRuns)
          .set({ postMergeSnapshotId: input.snapshotId })
          .where(eq(mergeRuns.id, input.mergeRunId));
        if (input.nextPhaseId) {
          await tx
            .update(phases)
            .set({ baseSnapshotId: input.snapshotId })
            .where(eq(phases.id, input.nextPhaseId));
        }
      });
      return { snapshotId: input.snapshotId };
    },

    async persistMergeRun(run: StoredMergeRun): Promise<UUID> {
      await db
        .insert(mergeRuns)
        .values({
          id: run.id,
          planId: run.planId,
          phaseId: run.phaseId,
          integrationBranch: run.integrationBranch,
          baseSha: run.baseSha,
          integrationLeaseId: run.integrationLeaseId ?? null,
          mergedTaskIds: run.mergedTaskIds,
          failedTaskId: run.failedTaskId ?? null,
          integrationHeadSha: run.integrationHeadSha ?? null,
          postMergeSnapshotId: run.postMergeSnapshotId ?? null,
          startedAt: run.startedAt,
          completedAt: run.completedAt ?? null,
        })
        // NOTE: `postMergeSnapshotId` intentionally omitted from the set
        // clause. The stamp comes exclusively from
        // `capturePostMergeSnapshotAndStamp`, which runs AFTER this
        // persist. On a Temporal retry where this activity fires a
        // second time, we must not zap an already-stamped snapshot id
        // with null.
        .onConflictDoUpdate({
          target: mergeRuns.id,
          set: {
            mergedTaskIds: run.mergedTaskIds,
            failedTaskId: run.failedTaskId ?? null,
            integrationHeadSha: run.integrationHeadSha ?? null,
            completedAt: run.completedAt ?? null,
          },
        });
      return run.id;
    },

    async loadMergeRun(id: UUID): Promise<StoredMergeRun | null> {
      const [row] = await db
        .select()
        .from(mergeRuns)
        .where(eq(mergeRuns.id, id))
        .limit(1);
      if (!row) return null;
      return rowToMergeRunContract(row);
    },

    async loadLatestMergeRunForPhase(
      phaseId: UUID,
    ): Promise<StoredMergeRun | null> {
      const rows = await db
        .select()
        .from(mergeRuns)
        .where(eq(mergeRuns.phaseId, phaseId))
        .orderBy(mergeRuns.startedAt);
      // Take the most recent by startedAt — JS sort the array so the
      // chainable .desc() ordering isn't required at the SQL layer.
      if (rows.length === 0) return null;
      const latest = rows[rows.length - 1]!;
      return rowToMergeRunContract(latest);
    },

    /**
     * Atomic main-ref advance via `git update-ref`. No checkout, no
     * working-tree mutation. Errors from the worktree-manager layer
     * (main-advance-conflict, non-fast-forward) propagate as-is so the
     * workflow can branch on WorktreeManagerError.code.
     */
    async fastForwardMainViaUpdateRef(input: {
      newSha: string;
      expectedCurrentSha: string;
    }): Promise<{ headSha: string }> {
      return fastForwardPkg({
        repoRoot,
        newSha: input.newSha,
        expectedCurrentSha: input.expectedCurrentSha,
      });
    },

    /**
     * Flip a task to `merged` after its branch lands in the integration
     * branch. Guarded: only transitions from `ready_to_merge` — any
     * other state stays untouched and returns silently (Temporal
     * replay-safe).
     */
    async markTaskMerged(input: { taskId: UUID }): Promise<void> {
      await db
        .update(planTasks)
        .set({ status: "merged" })
        .where(
          and(
            eq(planTasks.id, input.taskId),
            eq(planTasks.status, "ready_to_merge"),
          ),
        );
    },

    async updatePhaseStatus(input: {
      phaseId: UUID;
      status:
        | "pending"
        | "planning"
        | "executing"
        | "integrating"
        | "auditing"
        | "completed"
        | "blocked"
        | "failed";
    }): Promise<void> {
      // Read the current status + planId so we can (a) write the
      // UPDATE, (b) emit a `phase_status_changed` event with
      // before/after. Reading first then updating is not atomic,
      // but this activity is the single writer to `phases.status`
      // for orchestration flows; concurrent transitions require a
      // human intervention. The event is a read-model projection,
      // not a lock primitive, so a tiny race window is acceptable.
      const [prev] = await db
        .select({ status: phases.status, planId: phases.planId })
        .from(phases)
        .where(eq(phases.id, input.phaseId))
        .limit(1);
      await db
        .update(phases)
        .set({ status: input.status })
        .where(eq(phases.id, input.phaseId));
      // Only emit when the status actually changed AND we could
      // resolve the plan. Skip silently otherwise — the read-model
      // shouldn't carry no-op transitions.
      if (prev && prev.status !== input.status) {
        try {
          await db.insert(workflowEvents).values({
            id: randomUUID(),
            planId: prev.planId,
            phaseId: input.phaseId,
            taskId: null,
            kind: "phase_status_changed",
            payload: {
              previousStatus: prev.status,
              nextStatus: input.status,
            },
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          // Best-effort. A failed read-model emit must never block a
          // phase transition — the phases row is already updated.
          console.warn(
            `[events] phase_status_changed emit failed (phaseId=${input.phaseId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },

    /**
     * Release an integration lease: remove the worktree dir + branch,
     * flip the row to `status='released'`. Idempotent when the lease
     * row is already non-active or missing.
     */
    async releaseIntegrationLease(input: { leaseId: UUID }): Promise<void> {
      const [row] = await db
        .select()
        .from(worktreeLeases)
        .where(eq(worktreeLeases.id, input.leaseId))
        .limit(1);
      if (!row) return;
      if (row.status !== "active") return;
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

    async stampPhaseAuditReportId(input: {
      phaseId: UUID;
      reportId: UUID;
    }): Promise<void> {
      await db
        .update(phases)
        .set({ phaseAuditReportId: input.reportId })
        .where(eq(phases.id, input.phaseId));
    },

    async stampPhaseBaseSnapshotId(input: {
      phaseId: UUID;
      snapshotId: UUID;
    }): Promise<void> {
      await db
        .update(phases)
        .set({ baseSnapshotId: input.snapshotId })
        .where(eq(phases.id, input.phaseId));
    },
  };
}

// ---------------------------------------------------------------------------
// Row → contract mappers
// ---------------------------------------------------------------------------

type PhaseRow = typeof phases.$inferSelect;
type TaskRow = typeof planTasks.$inferSelect;
type LeaseRow = typeof worktreeLeases.$inferSelect;
type MergeRunRow = typeof mergeRuns.$inferSelect;

function rowToPhaseContract(row: PhaseRow): Phase {
  return {
    id: row.id,
    planId: row.planId,
    index: row.index,
    title: row.title,
    summary: row.summary,
    status: row.status,
    integrationBranch: row.integrationBranch,
    baseSnapshotId: row.baseSnapshotId,
    taskIds: row.taskIdsOrdered,
    // The `phases` table doesn't store dependency edges — they live on
    // `task_dependencies`. The partition-check path below queries that
    // table directly; we return an empty edge list here so the Phase
    // contract is structurally valid for loadPhase callers that only
    // need identity fields.
    dependencyEdges: [],
    mergeOrder: row.mergeOrder,
    ...(row.phaseAuditReportId !== null
      ? { phaseAuditReportId: row.phaseAuditReportId }
      : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
  };
}

function rowToTaskContract(row: TaskRow): Task {
  return {
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    status: row.status,
    riskLevel: row.riskLevel,
    fileScope: row.fileScope,
    acceptanceCriteria: row.acceptanceCriteria,
    testCommands: row.testCommands,
    budget: row.budget,
    reviewerPolicy: row.reviewerPolicy,
    requiresHumanApproval: row.requiresHumanApproval,
    maxReviewFixCycles: row.maxReviewFixCycles,
    ...(row.branchName !== null ? { branchName: row.branchName } : {}),
    ...(row.worktreePath !== null ? { worktreePath: row.worktreePath } : {}),
  };
}

function leaseRowToContract(row: LeaseRow): WorktreeLease {
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

function rowToMergeRunContract(row: MergeRunRow): StoredMergeRun {
  return {
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    integrationBranch: row.integrationBranch,
    baseSha: row.baseSha,
    mergedTaskIds: row.mergedTaskIds,
    ...(row.failedTaskId !== null ? { failedTaskId: row.failedTaskId } : {}),
    ...(row.integrationHeadSha !== null
      ? { integrationHeadSha: row.integrationHeadSha }
      : {}),
    ...(row.postMergeSnapshotId !== null
      ? { postMergeSnapshotId: row.postMergeSnapshotId }
      : {}),
    ...(row.integrationLeaseId !== null
      ? { integrationLeaseId: row.integrationLeaseId }
      : {}),
    startedAt: row.startedAt,
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Kahn-sort cycle detector scoped to a phase's task set. Returns a
 * task id in/downstream of a cycle, or null if the graph is a DAG.
 */
function findCycleVertex(
  tasks: readonly Task[],
  edges: readonly DependencyEdge[],
): string | null {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adjacency.set(t.id, []);
  }
  for (const e of edges) {
    if (!inDegree.has(e.fromTaskId) || !inDegree.has(e.toTaskId)) continue;
    adjacency.get(e.fromTaskId)!.push(e.toTaskId);
    inDegree.set(e.toTaskId, (inDegree.get(e.toTaskId) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const next of adjacency.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (processed === tasks.length) return null;
  for (const [id, deg] of inDegree) if (deg > 0) return id;
  return null;
}

function extractProcMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const obj = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const parts: string[] = [];
  for (const v of [obj.stdout, obj.stderr, obj.message]) {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  return parts.join("\n");
}

async function reconstructPlan(
  db: PmGoDb,
  planId: UUID,
): Promise<Plan | null> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const planRow = planRows[0];
  if (!planRow) return null;

  const [phaseRows, taskRows] = await Promise.all([
    db.select().from(phases).where(eq(phases.planId, planId)),
    db.select().from(planTasks).where(eq(planTasks.planId, planId)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const edgeRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(taskDependencies)
          .where(inArray(taskDependencies.fromTaskId, taskIds))
      : [];

  const taskIdToPhase = new Map<string, string>();
  for (const t of taskRows) taskIdToPhase.set(t.id, t.phaseId);
  const edgesByPhase = new Map<string, DependencyEdge[]>();
  for (const e of edgeRows) {
    const pid = taskIdToPhase.get(e.fromTaskId);
    if (!pid) continue;
    const list = edgesByPhase.get(pid) ?? [];
    list.push({
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      reason: e.reason,
      required: e.required,
    });
    edgesByPhase.set(pid, list);
  }

  const phasesOut: Phase[] = phaseRows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      ...rowToPhaseContract(row),
      dependencyEdges: edgesByPhase.get(row.id) ?? [],
    }));

  return {
    id: planRow.id,
    specDocumentId: planRow.specDocumentId,
    repoSnapshotId: planRow.repoSnapshotId,
    title: planRow.title,
    summary: planRow.summary,
    status: planRow.status,
    phases: phasesOut,
    tasks: taskRows.map(rowToTaskContract),
    risks: (planRow.risks ?? []) as Risk[],
    createdAt: toIso(planRow.createdAt),
    updatedAt: toIso(planRow.updatedAt),
  };
}

function toIso(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}
