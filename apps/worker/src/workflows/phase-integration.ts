import { ApplicationFailure, proxyActivities, uuid4 } from "@temporalio/workflow";
import type {
  MergeRun,
  Phase,
  PhaseIntegrationWorkflowInput,
  PhaseIntegrationWorkflowResult,
  Task,
  UUID,
  WorktreeLease,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

type PhaseStatus =
  | "pending"
  | "planning"
  | "executing"
  | "integrating"
  | "auditing"
  | "completed"
  | "blocked"
  | "failed";

type AttemptMergeResult =
  | { status: "merged"; mergedHeadSha: string }
  | { status: "conflict"; conflictedPaths: string[] }
  | { status: "other_error"; message: string };

interface PhaseIntegrationActivityInterface {
  loadPhase(input: { phaseId: UUID }): Promise<Phase>;
  loadTask(input: { taskId: UUID }): Promise<Task>;
  runPhasePartitionChecks(input: {
    phaseId: UUID;
  }): Promise<{ ok: boolean; reasons: string[] }>;
  createIntegrationLease(input: {
    phaseId: UUID;
  }): Promise<WorktreeLease>;
  integrateTask(input: {
    integrationLease: WorktreeLease;
    taskId: UUID;
  }): Promise<AttemptMergeResult>;
  validatePostMergeState(input: {
    integrationWorktreePath: string;
    testCommands: string[];
  }): Promise<{ passed: boolean; logs: string[] }>;
  readIntegrationWorktreeHeadSha(input: {
    worktreePath: string;
  }): Promise<string>;
  capturePostMergeSnapshotAndStamp(input: {
    integrationWorktreePath: string;
    mergeRunId: UUID;
    nextPhaseId?: UUID;
  }): Promise<{ snapshotId: UUID }>;
  persistMergeRun(run: StoredMergeRun): Promise<UUID>;
  markTaskMerged(input: { taskId: UUID }): Promise<void>;
  updatePhaseStatus(input: {
    phaseId: UUID;
    status: PhaseStatus;
  }): Promise<void>;
  releaseIntegrationLease(input: { leaseId: UUID }): Promise<void>;
}

const {
  loadPhase,
  loadTask,
  runPhasePartitionChecks,
  createIntegrationLease,
  integrateTask,
  validatePostMergeState,
  readIntegrationWorktreeHeadSha,
  capturePostMergeSnapshotAndStamp,
  persistMergeRun,
  markTaskMerged,
  updatePhaseStatus,
  releaseIntegrationLease,
} = proxyActivities<PhaseIntegrationActivityInterface>({
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

const MAX_MERGE_RETRY_ATTEMPTS_PER_TASK = 2;

/**
 * PhaseIntegrationWorkflow — the merge loop.
 *
 * Never touches `main`. Runs the phase-partition re-validator, leases an
 * integration worktree, merges each task's branch sequentially with
 * `--no-ff`, validates the post-merge state via the task's
 * testCommands, captures a post-merge snapshot on success, persists the
 * merge_run row, and flips the phase to `auditing` (or `blocked` on
 * failure). `main` advancement is deferred to `PhaseAuditWorkflow`.
 *
 * Deterministic across replays: `mergeRun.id` comes from `uuid4()` in
 * `@temporalio/workflow`; the merge loop iterates `phase.mergeOrder` in
 * array order.
 */
export async function PhaseIntegrationWorkflow(
  input: PhaseIntegrationWorkflowInput,
): Promise<PhaseIntegrationWorkflowResult> {
  const phase = await loadPhase({ phaseId: input.phaseId });

  // Re-validate the partition against current durable state. On
  // violation, fail structurally; the standalone workflow (if called)
  // would also throw, but when called inline here we prefer to surface
  // the reason straight to the caller.
  const partition = await runPhasePartitionChecks({ phaseId: input.phaseId });
  if (!partition.ok) {
    await updatePhaseStatus({
      phaseId: input.phaseId,
      status: "blocked",
    }).catch(() => undefined);
    throw ApplicationFailure.nonRetryable(
      `phase partition invariants violated: ${partition.reasons.join("; ")}`,
      "PhasePartitionInvariantError",
    );
  }

  // Flip phase to integrating BEFORE creating the lease so an observer
  // sees the transition before on-disk side-effects happen.
  await updatePhaseStatus({
    phaseId: input.phaseId,
    status: "integrating",
  });

  const mergeRunId: UUID = uuid4();
  let lease: WorktreeLease | undefined;

  try {
    lease = await createIntegrationLease({ phaseId: input.phaseId });

    const mergedTaskIds: UUID[] = [];
    let failedTaskId: UUID | undefined;

    for (const taskId of phase.mergeOrder) {
      const task = await loadTask({ taskId });

      // Retry loop for conflicts only. `other_error` aborts the loop
      // immediately so we don't silently swallow unknown failures.
      let mergeResult: AttemptMergeResult | undefined;
      for (
        let attempt = 1;
        attempt <= MAX_MERGE_RETRY_ATTEMPTS_PER_TASK;
        attempt++
      ) {
        mergeResult = await integrateTask({
          integrationLease: lease,
          taskId,
        });
        if (mergeResult.status === "merged") break;
        if (mergeResult.status === "other_error") break;
        // Conflict — retry up to cap, which gives the reviewer path a
        // chance to land a follow-up that resolves the overlap before
        // we give up on this task.
      }

      if (!mergeResult || mergeResult.status !== "merged") {
        failedTaskId = taskId;
        break;
      }

      const validation = await validatePostMergeState({
        integrationWorktreePath: lease.worktreePath,
        testCommands: task.testCommands,
      });
      if (!validation.passed) {
        failedTaskId = taskId;
        break;
      }

      await markTaskMerged({ taskId });
      mergedTaskIds.push(taskId);
    }

    // Read the current HEAD of the integration worktree; may be the
    // baseSha if nothing merged (all tasks failed). `mergedHeadSha` only
    // set when at least one task succeeded.
    const integrationHeadSha = await readIntegrationWorktreeHeadSha({
      worktreePath: lease.worktreePath,
    });

    // Snapshot + stamp the merge_run FK so post-hoc readers can
    // reconstruct the repo state at this merge point. We stamp the
    // merge_run but not the next phase's base_snapshot_id — that
    // propagation only happens on audit pass.
    await capturePostMergeSnapshotAndStamp({
      integrationWorktreePath: lease.worktreePath,
      mergeRunId,
    });

    const startedAt = new Date().toISOString();
    const storedRun: StoredMergeRun = {
      id: mergeRunId,
      planId: phase.planId,
      phaseId: phase.id,
      integrationBranch: lease.branchName,
      baseSha: lease.baseSha,
      mergedTaskIds,
      ...(failedTaskId !== undefined ? { failedTaskId } : {}),
      integrationHeadSha,
      integrationLeaseId: lease.id,
      startedAt,
      completedAt: startedAt,
    };
    await persistMergeRun(storedRun);

    if (failedTaskId !== undefined) {
      await updatePhaseStatus({
        phaseId: input.phaseId,
        status: "blocked",
      });
      // Leave the integration worktree in place so a human can inspect
      // the conflict state. The lease sweeper eventually reclaims it.
      const result: MergeRun = storedRunToContract(storedRun);
      return { phaseId: input.phaseId, mergeRun: result };
    }

    await updatePhaseStatus({
      phaseId: input.phaseId,
      status: "auditing",
    });

    return {
      phaseId: input.phaseId,
      mergeRun: storedRunToContract(storedRun),
    };
  } catch (err) {
    // Post-integrating failure: mark phase failed, best-effort release
    // the lease. Errors from the cleanup path are swallowed so the
    // original error propagates.
    await updatePhaseStatus({
      phaseId: input.phaseId,
      status: "failed",
    }).catch(() => undefined);
    if (lease) {
      await releaseIntegrationLease({ leaseId: lease.id }).catch(
        () => undefined,
      );
    }
    throw err;
  }
}

function storedRunToContract(run: StoredMergeRun): MergeRun {
  // Strip the DB-only fields (`postMergeSnapshotId`, `integrationLeaseId`)
  // when returning to workflow callers — they're only meaningful at
  // persistence time. The contract's `MergeRun` deliberately omits them.
  return {
    id: run.id,
    planId: run.planId,
    phaseId: run.phaseId,
    integrationBranch: run.integrationBranch,
    baseSha: run.baseSha,
    mergedTaskIds: run.mergedTaskIds,
    ...(run.failedTaskId !== undefined ? { failedTaskId: run.failedTaskId } : {}),
    ...(run.integrationHeadSha !== undefined
      ? { integrationHeadSha: run.integrationHeadSha }
      : {}),
    startedAt: run.startedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
  };
}
