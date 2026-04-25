import {
  ApplicationFailure,
  condition,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";
import {
  approveSignal,
} from "@pm-go/contracts";
import type {
  ApprovalDecision,
  MergeRun,
  Phase,
  PhaseIntegrationWorkflowInput,
  PhaseIntegrationWorkflowResult,
  Task,
  UUID,
  WorktreeLease,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

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
    /**
     * Workflow-generated snapshot id so retries are idempotent: a
     * Temporal re-execution uses the same id, the repo_snapshots
     * insert is ON CONFLICT DO NOTHING, and the merge_runs UPDATE is
     * a no-op.
     */
    snapshotId: UUID;
    nextPhaseId?: UUID;
  }): Promise<{ snapshotId: UUID }>;
  persistMergeRun(run: StoredMergeRun): Promise<UUID>;
  markTaskMerged(input: { taskId: UUID }): Promise<void>;
  updatePhaseStatus(input: {
    phaseId: UUID;
    status: PhaseStatus;
  }): Promise<void>;
  releaseIntegrationLease(input: { leaseId: UUID }): Promise<void>;
  // Phase 7 — approval gate.
  evaluateApprovalGateActivity(input: { taskId: UUID }): Promise<{
    decision: ApprovalDecision;
    approvalRequestId?: UUID;
  }>;
  // v0.8.2.1 P1.1+P1.2 — DB-backed approval re-check. The signal-only
  // wait pattern broke down when (a) the API signal targeted the wrong
  // workflow id, or (b) the worker restarted between the gate
  // evaluation and the signal. The workflow now races the signal
  // against periodic isApproved polls so the durable approval_requests
  // row IS the source of truth, not just the in-memory signal state.
  isApproved(input: { approvalRequestId: UUID }): Promise<{
    approved: boolean;
    rejected: boolean;
  }>;
  // Phase 7 — budget snapshot at integration time.
  persistBudgetReport(input: { planId: UUID }): Promise<{ id: UUID }>;
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
  evaluateApprovalGateActivity,
  isApproved,
  persistBudgetReport,
} = proxyActivities<PhaseIntegrationActivityInterface>({
  startToCloseTimeout: "20 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("PhaseIntegrationWorkflow")),
});

/**
 * Phase 7: maximum wall time the integration workflow will block
 * waiting for an operator approval before giving up. 24 hours covers
 * a single business cycle; longer waits should be re-driven via a
 * fresh integrate POST after the approval lands.
 */
const APPROVAL_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * v0.8.2.1 P1.1+P1.2: re-check the approval row directly every 30s
 * regardless of whether a signal has arrived. Bounds the signal
 * misdelivery window: even if the API signal targets a stale or
 * never-existing workflow id, the row flip resolves the wait within
 * one tick. 30s is short enough to be invisible to operators and
 * long enough to keep the polling cost cheap.
 */
const APPROVAL_POLL_INTERVAL_MS = 30 * 1000;

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

  // Phase 7 — approval gate. For every task in this phase, ask the
  // policy engine whether human approval is required. The activity
  // inserts an `approval_requests` row (status='pending') if so;
  // we then block the workflow on the `approveSignal` Temporal signal
  // until an operator (or auto-approve logic) sends it. The wait is
  // capped at APPROVAL_WAIT_TIMEOUT_MS so a forgotten approval doesn't
  // keep the worker tied up indefinitely. Idempotent on Temporal
  // retries — the activity reuses any existing pending row before
  // inserting.
  for (const taskId of phase.mergeOrder) {
    const gate = await evaluateApprovalGateActivity({ taskId });
    if (!gate.decision.required || !gate.approvalRequestId) continue;
    const approvalRequestId = gate.approvalRequestId;

    // NOTE: Rejection is deliberately NOT handled via a Temporal signal.
    // The operator rejects an approval by invalidating (soft-deleting or
    // status-updating) the `approval_requests` row through the REST API,
    // then re-calling the integrate endpoint. Keeping rejection out of
    // the signal path avoids a second signal handler, simplifies the
    // state machine to a binary approved/timed-out outcome, and makes
    // the audit trail fully authoritative in the DB rather than split
    // between DB state and Temporal history.
    let approvalResolved = false;
    setHandler(approveSignal, () => {
      approvalResolved = true;
    });

    // v0.8.2.1 P1.1+P1.2: race the in-memory signal against periodic
    // DB re-checks. The API signal may target a stale workflow id, the
    // worker may restart, or the signal may simply be lost; in any of
    // those cases the durable approval_requests row is the source of
    // truth, and the row flip will resolve this wait within one poll
    // tick. The signal-driven path remains unchanged for the happy
    // case — `condition()` resolves immediately when the signal lands,
    // we don't pay the 30s tick cost.
    let approved = false;
    const deadline = Date.now() + APPROVAL_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const tickMs = Math.min(APPROVAL_POLL_INTERVAL_MS, remaining);
      // Wake on either the signal arriving OR the tick timeout.
      const sawSignal = await condition(() => approvalResolved, tickMs);
      if (sawSignal) {
        approved = true;
        break;
      }
      // Tick fired with no signal — re-check the durable row. If the
      // API flipped the row but the signal never reached us (mismatched
      // workflow id, dropped signal, worker restart), this is where we
      // recover.
      const dbState = await isApproved({ approvalRequestId });
      if (dbState.approved) {
        approved = true;
        break;
      }
      if (dbState.rejected) {
        // Operator rejection — surface explicitly rather than waiting
        // out the full timeout. Mirrors the "row is source of truth"
        // contract for the rejection path too.
        break;
      }
    }

    if (!approved) {
      await updatePhaseStatus({
        phaseId: input.phaseId,
        status: "blocked",
      }).catch(() => undefined);
      throw ApplicationFailure.nonRetryable(
        `phase ${input.phaseId} blocked: approval timeout for task ${taskId} (request ${approvalRequestId})`,
        "ApprovalTimeoutError",
      );
    }
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

    const startedAt = new Date().toISOString();
    // Persist the merge_run row FIRST so that the subsequent snapshot
    // stamp has a row to UPDATE. Prior ordering (capture-then-persist)
    // lost the linkage because capturePostMergeSnapshotAndStamp's
    // UPDATE was a no-op against a row that didn't exist yet.
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

    // Snapshot + stamp the merge_run FK. Snapshot id is workflow-
    // generated via uuid4() so Temporal retries are fully idempotent:
    // snapshot insert is ON CONFLICT DO NOTHING, merge_runs UPDATE is
    // a deterministic overwrite with the same value. Skip when no task
    // merged — the pre-failed run has no meaningful post-merge state.
    if (failedTaskId === undefined) {
      const postMergeSnapshotId: UUID = uuid4();
      await capturePostMergeSnapshotAndStamp({
        integrationWorktreePath: lease.worktreePath,
        mergeRunId,
        snapshotId: postMergeSnapshotId,
      });
      // Reflect the stamp on the local object so the returned MergeRun
      // contract carries the snapshot id (used by PhaseAuditWorkflow).
      storedRun.postMergeSnapshotId = postMergeSnapshotId;
    }

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

    // Phase 7: capture a plan-wide budget snapshot at integration time
    // so the operator-facing /plans/:id/budget-report endpoint always
    // has a fresh row to serve. Best-effort — a failed snapshot must
    // not block the auditing transition. The activity itself span-wraps
    // its DB write so failures are observable.
    await persistBudgetReport({ planId: phase.planId }).catch(() => undefined);

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
