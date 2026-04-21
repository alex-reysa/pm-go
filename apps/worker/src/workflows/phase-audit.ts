import { proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  Phase,
  PhaseAuditReport,
  PhaseAuditWorkflowInput,
  PhaseAuditWorkflowResult,
  Plan,
  UUID,
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

interface PhaseAuditActivityInterface {
  loadPlan(input: { planId: UUID }): Promise<Plan>;
  loadPhase(input: { phaseId: UUID }): Promise<Phase>;
  loadNextPhase(input: {
    planId: UUID;
    currentPhaseIndex: number;
  }): Promise<Phase | null>;
  loadMergeRun(id: UUID): Promise<StoredMergeRun | null>;
  runPhaseAuditor(input: {
    plan: Plan;
    phase: Phase;
    mergeRun: StoredMergeRun;
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: PhaseAuditReport; agentRun: AgentRun }>;
  persistAgentRun(run: AgentRun): Promise<UUID>;
  persistPhaseAuditReport(report: PhaseAuditReport): Promise<UUID>;
  stampPhaseAuditReportId(input: {
    phaseId: UUID;
    reportId: UUID;
  }): Promise<void>;
  stampPhaseBaseSnapshotId(input: {
    phaseId: UUID;
    snapshotId: UUID;
  }): Promise<void>;
  fastForwardMainViaUpdateRef(input: {
    newSha: string;
    expectedCurrentSha: string;
  }): Promise<{ headSha: string }>;
  updatePhaseStatus(input: {
    phaseId: UUID;
    status: PhaseStatus;
  }): Promise<void>;
  releaseIntegrationLease(input: { leaseId: UUID }): Promise<void>;
}

const {
  loadPlan,
  loadPhase,
  loadNextPhase,
  loadMergeRun,
  runPhaseAuditor,
  persistAgentRun,
  persistPhaseAuditReport,
  stampPhaseAuditReportId,
  stampPhaseBaseSnapshotId,
  fastForwardMainViaUpdateRef,
  updatePhaseStatus,
  releaseIntegrationLease,
} = proxyActivities<PhaseAuditActivityInterface>({
  startToCloseTimeout: "30 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("PhaseAuditWorkflow")),
});

/**
 * PhaseAuditWorkflow — the audit gate that advances `main`.
 *
 * Runs the Claude-backed phase auditor (activity wraps validation
 * errors as `ApplicationFailure.nonRetryable`). On `outcome='pass'`:
 *   - fast-forwards `main` via `git update-ref` (atomic, no checkout),
 *   - propagates the post-merge snapshot to the next phase's
 *     `base_snapshot_id`,
 *   - marks the phase `completed`,
 *   - releases the integration lease.
 *
 * On `changes_requested` or `blocked`: flip phase to `blocked`, leave
 * the integration lease in place for human inspection, return
 * `phaseReady=false`. V1 does not auto-rerun.
 */
export async function PhaseAuditWorkflow(
  input: PhaseAuditWorkflowInput,
): Promise<PhaseAuditWorkflowResult> {
  const mergeRun = await loadMergeRun(input.mergeRunId);
  if (!mergeRun) {
    throw new Error(
      `PhaseAuditWorkflow: merge_run ${input.mergeRunId} not found`,
    );
  }
  if (mergeRun.phaseId !== input.phaseId) {
    throw new Error(
      `PhaseAuditWorkflow: merge_run.phase_id (${mergeRun.phaseId}) != input.phaseId (${input.phaseId})`,
    );
  }
  if (mergeRun.failedTaskId !== undefined) {
    throw new Error(
      `PhaseAuditWorkflow: refusing to audit merge_run ${mergeRun.id} with failed_task_id ${mergeRun.failedTaskId}`,
    );
  }
  if (!mergeRun.integrationHeadSha) {
    throw new Error(
      `PhaseAuditWorkflow: merge_run ${mergeRun.id} has no integration_head_sha`,
    );
  }

  const plan = await loadPlan({ planId: input.planId });
  const phase = await loadPhase({ phaseId: input.phaseId });

  const auditor = await runPhaseAuditor({
    plan,
    phase,
    mergeRun,
  });

  await persistAgentRun(auditor.agentRun);
  await persistPhaseAuditReport(auditor.report);
  await stampPhaseAuditReportId({
    phaseId: input.phaseId,
    reportId: auditor.report.id,
  });

  if (auditor.report.outcome === "pass") {
    // 1. Advance main atomically. `expectedCurrentSha = mergeRun.baseSha`
    //    — the sha main pointed at when the integration started. If
    //    main moved underneath (someone else advanced it), this
    //    refuses, which surfaces as a retryable error.
    await fastForwardMainViaUpdateRef({
      newSha: mergeRun.integrationHeadSha,
      expectedCurrentSha: mergeRun.baseSha,
    });

    // 2. Propagate post-merge snapshot to next phase's base + transition
    //    the next phase from `pending` to `executing`. Without the status
    //    transition, POST /phases/:next/integrate would 409 — the state
    //    machine only allows `executing` or `integrating`. Stamp the
    //    snapshot BEFORE the status flip so any observer that sees
    //    `executing` also sees a valid base_snapshot_id.
    const next = await loadNextPhase({
      planId: input.planId,
      currentPhaseIndex: phase.index,
    });
    if (next) {
      if (mergeRun.postMergeSnapshotId !== undefined) {
        await stampPhaseBaseSnapshotId({
          phaseId: next.id,
          snapshotId: mergeRun.postMergeSnapshotId,
        });
      }
      await updatePhaseStatus({
        phaseId: next.id,
        status: "executing",
      });
    }

    // 3. Mark the phase completed, release the lease.
    await updatePhaseStatus({
      phaseId: input.phaseId,
      status: "completed",
    });
    if (mergeRun.integrationLeaseId !== undefined) {
      await releaseIntegrationLease({
        leaseId: mergeRun.integrationLeaseId,
      }).catch(() => undefined);
    }

    return {
      planId: input.planId,
      phaseId: input.phaseId,
      report: auditor.report,
      phaseReady: true,
    };
  }

  // changes_requested or blocked — keep worktree for inspection.
  await updatePhaseStatus({
    phaseId: input.phaseId,
    status: "blocked",
  });
  return {
    planId: input.planId,
    phaseId: input.phaseId,
    report: auditor.report,
    phaseReady: false,
  };
}
