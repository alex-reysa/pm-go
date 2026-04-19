import { proxyActivities, uuid4 } from "@temporalio/workflow";
import type {
  AgentRun,
  PolicyDecision,
  ReviewFinding,
  ReviewReport,
  Task,
  TaskReviewWorkflowInput,
  TaskReviewWorkflowResult,
  TaskStatus,
  WorktreeLease,
} from "@pm-go/contracts";

import { evaluateReviewPolicy } from "./review-policy.js";

type StoredReviewReport = ReviewReport & {
  cycleNumber: number;
  reviewedBaseSha: string;
  reviewedHeadSha: string;
};

/**
 * Activity surface consumed by TaskReviewWorkflow. The workflow stays
 * closed over pure contract types + this interface; the Temporal sandbox
 * forbids direct I/O, and keeping the interface explicit here means
 * adding a new activity is a one-line proxy change.
 */
interface TaskReviewActivityInterface {
  loadTask(input: { taskId: string }): Promise<Task>;
  updateTaskStatus(input: {
    taskId: string;
    status: TaskStatus;
  }): Promise<void>;
  loadLatestLease(input: { taskId: string }): Promise<WorktreeLease | null>;
  readWorktreeHeadSha(input: { worktreePath: string }): Promise<string>;
  countFixCyclesForTask(taskId: string): Promise<number>;
  loadLatestReviewReport(taskId: string): Promise<StoredReviewReport | null>;
  runReviewer(input: {
    task: Task;
    worktreePath: string;
    baseSha: string;
    headSha: string;
    cycleNumber: number;
    previousFindings?: ReviewFinding[];
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: ReviewReport; agentRun: AgentRun }>;
  persistAgentRun(run: AgentRun): Promise<string>;
  persistReviewReport(report: StoredReviewReport): Promise<string>;
  persistPolicyDecision(decision: PolicyDecision): Promise<string>;
}

const {
  loadTask,
  updateTaskStatus,
  loadLatestLease,
  readWorktreeHeadSha,
  countFixCyclesForTask,
  loadLatestReviewReport,
  runReviewer,
  persistAgentRun,
  persistReviewReport,
  persistPolicyDecision,
} = proxyActivities<TaskReviewActivityInterface>({
  startToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

/**
 * TaskReviewWorkflow — Phase 4 reviewer loop.
 *
 * 1. Load the task + its active lease (the one the implementer left behind).
 * 2. Read the worktree HEAD so the reviewer sees the implementer's commit sha.
 * 3. Compute cycle number (`countFixCyclesForTask + 1`).
 * 4. Stamp the task `in_review` so API consumers see the correct state.
 * 5. On cycle >= 2, fetch the previous report's findings so the reviewer
 *    can verify they were actually addressed.
 * 6. Run the reviewer → structured `ReviewReport`.
 * 7. Persist the reviewer's AgentRun + the ReviewReport (enriched with
 *    cycleNumber).
 * 8. Evaluate inline review policy → next status + policy decision.
 * 9. Persist the policy decision row.
 * 10. Stamp the next status on the task.
 *
 * Exception hardening mirrors Phase 3: once we've transitioned the task
 * to `in_review`, any downstream activity failure flips the task to
 * `failed` before rethrowing, so the durable state never gets stuck
 * mid-pipeline.
 */
export async function TaskReviewWorkflow(
  input: TaskReviewWorkflowInput,
): Promise<TaskReviewWorkflowResult> {
  const task = await loadTask({ taskId: input.taskId });

  await updateTaskStatus({ taskId: input.taskId, status: "in_review" });

  try {
    const lease = await loadLatestLease({ taskId: input.taskId });
    if (!lease) {
      throw new Error(
        `TaskReviewWorkflow: no active worktree lease for task ${input.taskId}; run TaskExecutionWorkflow first.`,
      );
    }

    const headSha = await readWorktreeHeadSha({
      worktreePath: lease.worktreePath,
    });

    const priorCycleCount = await countFixCyclesForTask(input.taskId);
    const cycleNumber = priorCycleCount + 1;

    // previousFindings is only meaningful when there's a prior review
    // whose findings the new cycle is supposed to verify. Skip the
    // lookup on cycle 1 to avoid an activity round-trip we don't need.
    let previousFindings: ReviewFinding[] | undefined;
    if (cycleNumber > 1) {
      const prior = await loadLatestReviewReport(input.taskId);
      previousFindings = prior?.findings;
    }

    const runnerInput: {
      task: Task;
      worktreePath: string;
      baseSha: string;
      headSha: string;
      cycleNumber: number;
      previousFindings?: ReviewFinding[];
    } = {
      task,
      worktreePath: lease.worktreePath,
      baseSha: lease.baseSha,
      headSha,
      cycleNumber,
    };
    if (previousFindings && previousFindings.length > 0) {
      runnerInput.previousFindings = previousFindings;
    }

    const reviewerResult = await runReviewer(runnerInput);

    await persistAgentRun(reviewerResult.agentRun);

    const storedReport: StoredReviewReport = {
      ...reviewerResult.report,
      cycleNumber,
      reviewedBaseSha: lease.baseSha,
      reviewedHeadSha: headSha,
    };
    await persistReviewReport(storedReport);

    const policyDecision = evaluateReviewPolicy(
      reviewerResult.report,
      task,
      cycleNumber,
    );

    // Separate id from the review report id — the policy_decisions table
    // tracks orthogonal decision events (a plan/merge/review could each
    // produce their own row) and coupling the two on id silently hides
    // that in a 1:1 alias. uuid4() from @temporalio/workflow is
    // deterministic across replays so the ON CONFLICT (id) DO NOTHING
    // path on the persistence activity still gives idempotent retries.
    const policyRow: PolicyDecision = {
      id: uuid4(),
      subjectType: "review",
      subjectId: reviewerResult.report.id,
      riskLevel: task.riskLevel,
      decision: policyDecision.decision,
      reason: policyDecision.reasonText,
      actor: "system",
      createdAt: reviewerResult.report.createdAt,
    };
    await persistPolicyDecision(policyRow);

    await updateTaskStatus({
      taskId: input.taskId,
      status: policyDecision.nextStatus,
    });

    return {
      taskId: input.taskId,
      report: reviewerResult.report,
    };
  } catch (err) {
    await updateTaskStatus({
      taskId: input.taskId,
      status: "failed",
    }).catch(() => undefined);
    throw err;
  }
}
