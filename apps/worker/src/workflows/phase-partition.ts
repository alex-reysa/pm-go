import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type {
  Phase,
  PhasePartitionWorkflowInput,
  PhasePartitionWorkflowResult,
  Task,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

/**
 * Activity surface for PhasePartitionWorkflow. The workflow is a
 * re-validator in V1: it does NOT rewrite tasks or call Claude; it
 * confirms the pre-planned partition still holds post-merge. Partition
 * invariant failures surface as `ApplicationFailure.nonRetryable` so the
 * orchestrator sees a structural failure, not a transient retry.
 */
interface PhasePartitionActivityInterface {
  loadPhase(input: { phaseId: string }): Promise<Phase>;
  loadPhaseTasks(input: { phaseId: string }): Promise<Task[]>;
  runPhasePartitionChecks(input: {
    phaseId: string;
  }): Promise<{ ok: boolean; reasons: string[] }>;
  updatePhaseStatus(input: {
    phaseId: string;
    status:
      | "pending"
      | "planning"
      | "executing"
      | "integrating"
      | "auditing"
      | "completed"
      | "blocked"
      | "failed";
  }): Promise<void>;
}

const { loadPhase, loadPhaseTasks, runPhasePartitionChecks, updatePhaseStatus } =
  proxyActivities<PhasePartitionActivityInterface>({
    startToCloseTimeout: "2 minutes",
    retry: temporalRetryFromConfig(retryPolicyFor("PhasePartitionWorkflow")),
  });

/**
 * PhasePartitionWorkflow — deterministic re-validator.
 *
 * Confirms the pre-planned phase partition still holds against the
 * current durable state (fileScope disjointness, dependency DAG, task
 * count). On violation: flip phase to `blocked`, throw a nonRetryable
 * `PhasePartitionInvariantError` so the orchestrator stops.
 *
 * V1 never re-plans tasks; `partitionedTasks` equals the current phase
 * tasks.
 */
export async function PhasePartitionWorkflow(
  input: PhasePartitionWorkflowInput,
): Promise<PhasePartitionWorkflowResult> {
  const phase = await loadPhase({ phaseId: input.phaseId });
  const result = await runPhasePartitionChecks({ phaseId: input.phaseId });
  if (!result.ok) {
    await updatePhaseStatus({
      phaseId: input.phaseId,
      status: "blocked",
    }).catch(() => undefined);
    throw ApplicationFailure.nonRetryable(
      `phase partition invariants violated: ${result.reasons.join("; ")}`,
      "PhasePartitionInvariantError",
    );
  }
  const tasks = await loadPhaseTasks({ phaseId: input.phaseId });
  return {
    planId: phase.planId,
    phaseId: phase.id,
    partitionedTasks: tasks,
  };
}
