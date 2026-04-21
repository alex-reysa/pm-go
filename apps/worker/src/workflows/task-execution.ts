import { proxyActivities, uuid4 } from "@temporalio/workflow";
import type {
  AgentRun,
  BudgetDecision,
  FileScope,
  PolicyDecision,
  Task,
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult,
  TaskStatus,
  WorktreeLease,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

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
  // Phase 7 — policy gate + decision persistence.
  evaluateBudgetGateActivity(input: {
    taskId: string;
  }): Promise<BudgetDecision>;
  persistPolicyDecision(decision: PolicyDecision): Promise<string>;
}

// Phase 7: retry policy comes from the centralized PHASE7_RETRY_POLICIES
// catalog in `@pm-go/temporal-workflows`. The startToClose timeout
// stays workflow-local because it captures the maximum activity wall
// time, which is task-execution-specific (real implementer runs can
// chew through their budget for up to 15 minutes).
const {
  loadTask,
  updateTaskStatus,
  leaseWorktree,
  runImplementer,
  persistAgentRun,
  commitAgentWork,
  diffWorktreeAgainstScope,
  evaluateBudgetGateActivity,
  persistPolicyDecision,
} = proxyActivities<TaskExecutionActivityInterface>({
  startToCloseTimeout: "15 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("TaskExecutionWorkflow")),
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

  // Phase 7 — pre-flight budget gate. Looks at every prior agent_run
  // for this task; if cumulative spend already exceeds the task's
  // budget, transition to `blocked` + persist a policy_decisions row
  // citing the overrun and bail. The first ever invocation of a task
  // is a no-op pass (no prior runs, nothing to count).
  const budgetDecision = await evaluateBudgetGateActivity({
    taskId: input.taskId,
  });
  if (!budgetDecision.ok) {
    await updateTaskStatus({ taskId: input.taskId, status: "blocked" });
    await persistPolicyDecision({
      id: uuid4(),
      subjectType: "task",
      subjectId: input.taskId,
      riskLevel: task.riskLevel,
      decision: "budget_exceeded",
      reason: formatBudgetReason(budgetDecision),
      actor: "system",
      createdAt: new Date().toISOString(),
    });
    return {
      taskId: input.taskId,
      status: "blocked",
      leaseId: "",
      branchName: "",
      worktreePath: "",
      agentRunId: "",
      changedFiles: [],
      fileScopeViolations: [],
    };
  }

  await updateTaskStatus({ taskId: input.taskId, status: "running" });

  try {
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
  } catch (err) {
    // Any activity that fails after we've already transitioned the task
    // to `running` leaves the durable state in an in-flight status. Mark
    // the task `failed` so downstream consumers (reviewers, human
    // operators) see a terminal outcome rather than a permanently-stale
    // `running`. The status update itself is wrapped in a catch so a
    // failure persisting the transition does not mask the original
    // error — Temporal will still record the workflow as failed.
    await updateTaskStatus({
      taskId: input.taskId,
      status: "failed",
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * Render the short `policy_decisions.reason` text for a budget overrun.
 * Joined dimensions surface as comma-separated entries — operators
 * skim this on the TUI without expanding the full policy_decisions row.
 */
function formatBudgetReason(decision: BudgetDecision): string {
  if (decision.ok) return "ok";
  const parts: string[] = [];
  if (decision.over.usd !== undefined)
    parts.push(`+${decision.over.usd}usd`);
  if (decision.over.tokens !== undefined)
    parts.push(`+${decision.over.tokens}tok`);
  if (decision.over.wallClockMinutes !== undefined)
    parts.push(`+${decision.over.wallClockMinutes}min`);
  return `budget_exceeded: ${parts.join(", ")}`;
}
