import { proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  FileScope,
  Task,
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult,
  TaskStatus,
  WorktreeLease,
} from "@pm-go/contracts";

/**
 * Union of durable `TaskStatus` plus the workflow-local `"ready_for_review"`
 * marker the activity maps to the nearest DB enum value. Keeping it at
 * the workflow boundary means the rest of the pipeline stays closed over
 * the canonical `TaskStatus`.
 */
type TaskStatusTransition = TaskStatus | "ready_for_review";

/**
 * The workflow sandbox forbids dynamic I/O imports: git, disk, Drizzle,
 * and the Claude Agent SDK must all stay behind the activity boundary.
 * This subset is the only activity surface the workflow touches — the
 * real worker wires in a superset that also includes planner + spec
 * intake + persistence activities.
 */
interface TaskExecutionActivityInterface {
  loadTask(input: { taskId: string }): Promise<Task>;
  updateTaskStatus(input: {
    taskId: string;
    status: TaskStatusTransition;
  }): Promise<void>;
  leaseWorktree(input: {
    task: Task;
    repoRoot: string;
    worktreeRoot: string;
    maxLifetimeHours: number;
  }): Promise<WorktreeLease>;
  runImplementer(input: {
    task: Task;
    worktreePath: string;
    baseSha: string;
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

// Cap retries explicitly. Same pattern as SpecToPlanWorkflow — bounded
// attempts with exponential backoff keep transient blips recoverable
// without infinite retry storms on fatal errors. The startToClose
// timeout is deliberately longer than the planner's because real
// implementer runs can chew through their budget for up to 15 minutes.
const {
  loadTask,
  updateTaskStatus,
  leaseWorktree,
  runImplementer,
  persistAgentRun,
  commitAgentWork,
  diffWorktreeAgainstScope,
} = proxyActivities<TaskExecutionActivityInterface>({
  startToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

/**
 * Task execution orchestration:
 * 1. Load the task + mark it `running`.
 * 2. Lease a worktree (branch + on-disk worktree + durable lease row).
 * 3. Run the implementer inside the worktree.
 * 4. Persist the implementer's AgentRun.
 * 5. If the implementer did not produce a commit, run the post-execution
 *    commit activity so downstream diff-scope has something to compare
 *    against.
 * 6. Diff the worktree against the lease's baseSha and check the
 *    changed files against `task.fileScope`.
 * 7. Stamp the task status: `blocked` on any fileScope violation,
 *    `ready_for_review` otherwise. Return the full workflow result so
 *    the caller can surface lease + agent-run + changed-file info in
 *    one place.
 */
export async function TaskExecutionWorkflow(
  input: TaskExecutionWorkflowInput,
): Promise<TaskExecutionWorkflowResult> {
  const task = await loadTask({ taskId: input.taskId });

  await updateTaskStatus({ taskId: input.taskId, status: "running" });

  const lease = await leaseWorktree({
    task,
    repoRoot: input.repoRoot,
    worktreeRoot: input.worktreeRoot,
    maxLifetimeHours: input.maxLifetimeHours,
  });

  const implementerResult = await runImplementer({
    task,
    worktreePath: lease.worktreePath,
    baseSha: lease.baseSha,
  });

  await persistAgentRun(implementerResult.agentRun);

  // The runner returns `finalCommitSha` only when the implementer
  // committed itself (stub path) or the live runner observed a HEAD
  // change. When absent, stage+commit any pending worktree changes on
  // the task's behalf so diff-scope sees a non-empty diff.
  if (implementerResult.finalCommitSha === undefined) {
    const commitTitle = `feat(${task.slug}): ${task.title}`;
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
    await updateTaskStatus({
      taskId: input.taskId,
      status: "blocked",
    });
    return {
      taskId: input.taskId,
      status: "blocked",
      leaseId: lease.id,
      branchName: lease.branchName,
      worktreePath: lease.worktreePath,
      agentRunId: implementerResult.agentRun.id,
      changedFiles: diffResult.changedFiles,
      fileScopeViolations: diffResult.violations,
    };
  }

  await updateTaskStatus({
    taskId: input.taskId,
    status: "ready_for_review",
  });

  return {
    taskId: input.taskId,
    status: "ready_for_review",
    leaseId: lease.id,
    branchName: lease.branchName,
    worktreePath: lease.worktreePath,
    agentRunId: implementerResult.agentRun.id,
    changedFiles: diffResult.changedFiles,
    fileScopeViolations: [],
  };
}
