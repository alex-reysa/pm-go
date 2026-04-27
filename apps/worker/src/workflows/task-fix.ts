import { proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  FileScope,
  ReviewFinding,
  ReviewReport,
  Task,
  TaskFixWorkflowInput,
  TaskFixWorkflowResult,
  TaskStatus,
  WorktreeLease,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

type StoredReviewReport = ReviewReport & {
  cycleNumber: number;
  reviewedBaseSha: string;
  reviewedHeadSha: string;
};

interface TaskFixActivityInterface {
  loadTask(input: { taskId: string }): Promise<Task>;
  updateTaskStatus(input: {
    taskId: string;
    status: TaskStatus;
  }): Promise<void>;
  loadLatestLease(input: { taskId: string }): Promise<WorktreeLease | null>;
  loadReviewReport(reportId: string): Promise<StoredReviewReport | null>;
  runImplementer(input: {
    task: Task;
    worktreePath: string;
    baseSha: string;
    reviewFeedback?: {
      reportId: string;
      cycleNumber: number;
      maxCycles: number;
      findings: ReviewFinding[];
    };
  }): Promise<{ agentRun: AgentRun; finalCommitSha?: string }>;
  persistAgentRun(run: AgentRun): Promise<string>;
  commitAgentWork(input: {
    worktreePath: string;
    taskSlug: string;
    commitTitle: string;
  }): Promise<string | undefined>;
  diffWorktreeAgainstScope(input: {
    worktreePath: string;
    baseSha: string;
    fileScope: FileScope;
  }): Promise<{ changedFiles: string[]; violations: string[] }>;
}

const {
  loadTask,
  updateTaskStatus,
  loadLatestLease,
  loadReviewReport,
  runImplementer,
  persistAgentRun,
  commitAgentWork,
  diffWorktreeAgainstScope,
} = proxyActivities<TaskFixActivityInterface>({
  startToCloseTimeout: "60 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("TaskFixWorkflow")),
});

/**
 * TaskFixWorkflow — Phase 4 fix cycle.
 *
 * Runs the implementer a second (or later) time against the same worktree,
 * with the reviewer's findings injected via the `reviewFeedback` preamble.
 * On success the task flips back to `in_review` so the next
 * TaskReviewWorkflow cycle can evaluate the fixed commit.
 *
 * Policy / cycle-cap enforcement happens at the END of the review
 * workflow, not here. This workflow assumes it has been invoked because
 * the last review returned `changes_requested` within cycle cap; the API
 * endpoint guards that precondition.
 *
 * Exception hardening mirrors TaskReviewWorkflow: any failure after the
 * status transitions to `running` flips the task to `failed` before
 * rethrowing.
 */
export async function TaskFixWorkflow(
  input: TaskFixWorkflowInput,
): Promise<TaskFixWorkflowResult> {
  const task = await loadTask({ taskId: input.taskId });
  const report = await loadReviewReport(input.reviewReportId);
  if (!report) {
    throw new Error(
      `TaskFixWorkflow: no review_reports row with id ${input.reviewReportId}`,
    );
  }
  if (report.taskId !== input.taskId) {
    throw new Error(
      `TaskFixWorkflow: review_report ${input.reviewReportId} belongs to task ${report.taskId}, not ${input.taskId}`,
    );
  }

  await updateTaskStatus({ taskId: input.taskId, status: "running" });

  try {
    const lease = await loadLatestLease({ taskId: input.taskId });
    if (!lease) {
      throw new Error(
        `TaskFixWorkflow: no active worktree lease for task ${input.taskId}`,
      );
    }

    const implementerResult = await runImplementer({
      task,
      worktreePath: lease.worktreePath,
      baseSha: lease.baseSha,
      reviewFeedback: {
        reportId: report.id,
        cycleNumber: report.cycleNumber,
        maxCycles: task.maxReviewFixCycles,
        findings: report.findings,
      },
    });

    await persistAgentRun(implementerResult.agentRun);

    if (implementerResult.finalCommitSha === undefined) {
      const commitTitle = `fix(${task.slug}): address reviewer findings (cycle ${report.cycleNumber})`;
      await commitAgentWork({
        worktreePath: lease.worktreePath,
        taskSlug: task.slug,
        commitTitle,
      });
    }

    const diffResult = await diffWorktreeAgainstScope({
      worktreePath: lease.worktreePath,
      baseSha: lease.baseSha,
      fileScope: task.fileScope,
    });

    if (diffResult.violations.length > 0) {
      // Scope violation after the fix attempt — human review required.
      await updateTaskStatus({
        taskId: input.taskId,
        status: "blocked",
      });
      return {
        taskId: input.taskId,
        completed: false,
        retryReview: false,
      };
    }

    await updateTaskStatus({ taskId: input.taskId, status: "in_review" });

    return {
      taskId: input.taskId,
      completed: true,
      retryReview: true,
    };
  } catch (err) {
    await updateTaskStatus({
      taskId: input.taskId,
      status: "failed",
    }).catch(() => undefined);
    throw err;
  }
}
