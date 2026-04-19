import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import type {
  AgentRun,
  Task,
  TaskStatus,
} from "@pm-go/contracts";
import { planTasks, type PmGoDb } from "@pm-go/db";
import type { ImplementerRunner } from "@pm-go/executor-claude";
import { runImplementer as runImplementerPkg } from "@pm-go/planner";

const execFileAsync = promisify(execFile);

export interface TaskExecutionActivityDeps {
  db: PmGoDb;
  implementerRunner: ImplementerRunner;
  repoRoot: string;
  worktreeRoot: string;
}

/**
 * Workflow-local status marker. The DB enum does not carry
 * `"ready_for_review"`, so the activity maps it to the nearest durable
 * value (`"in_review"`) before persisting. The workflow result still
 * carries the richer string for API consumers.
 */
type TaskStatusTransition = TaskStatus | "ready_for_review";

/**
 * Map a workflow-local status transition to the canonical DB-persisted
 * `TaskStatus`. Only `"ready_for_review"` is rewritten; everything else
 * passes through unchanged so the enum stays authoritative.
 */
function toDbStatus(status: TaskStatusTransition): TaskStatus {
  return status === "ready_for_review" ? "in_review" : status;
}

/**
 * Task execution activities used by `TaskExecutionWorkflow`. The heavy
 * lifting (git, lease lifecycle, diff-scope) lives in the worktree
 * activities; this factory only owns the implementer-runner binding
 * plus the two very small task-row operations (`loadTask`,
 * `updateTaskStatus`) and the post-implementer `commitAgentWork` hook.
 */
export function createTaskExecutionActivities(
  deps: TaskExecutionActivityDeps,
) {
  return {
    /**
     * Hydrate the durable Task row into the in-memory `Task` contract
     * shape. JSON columns (`fileScope`, `acceptanceCriteria`,
     * `testCommands`, `budget`, `reviewerPolicy`) are already typed
     * via drizzle's `$type<...>()` annotations, so this is a narrow
     * mapping — no JSON.parse.
     */
    async loadTask(input: { taskId: string }): Promise<Task> {
      const rows = await deps.db
        .select()
        .from(planTasks)
        .where(eq(planTasks.id, input.taskId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error(
          `loadTask: no plan_tasks row with id ${input.taskId}`,
        );
      }
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
        ...(row.worktreePath !== null
          ? { worktreePath: row.worktreePath }
          : {}),
      };
    },

    /**
     * Stamp the task's status. Workflow callers may pass the
     * workflow-local `"ready_for_review"` marker; this wrapper maps it
     * to the persistable `TaskStatus` before writing.
     */
    async updateTaskStatus(input: {
      taskId: string;
      status: TaskStatusTransition;
    }): Promise<void> {
      const dbStatus = toDbStatus(input.status);
      await deps.db
        .update(planTasks)
        .set({ status: dbStatus })
        .where(eq(planTasks.id, input.taskId));
    },

    /**
     * Delegate to the pure `runImplementer` in `@pm-go/planner`, which
     * loads the prompt + forwards options to the injected runner. The
     * activity wrapper exists so Temporal can retry network-backed
     * implementer failures with the policy configured on the workflow.
     */
    async runImplementer(input: {
      task: Task;
      worktreePath: string;
      baseSha: string;
    }): Promise<{ agentRun: AgentRun; finalCommitSha?: string }> {
      const result = await runImplementerPkg({
        task: input.task,
        worktreePath: input.worktreePath,
        baseSha: input.baseSha,
        requestedBy: "task-execution-workflow",
        runner: deps.implementerRunner,
      });
      return result.finalCommitSha !== undefined
        ? { agentRun: result.agentRun, finalCommitSha: result.finalCommitSha }
        : { agentRun: result.agentRun };
    },

    /**
     * Stage + commit any pending changes in the worktree on behalf of
     * the implementer when the runner did not commit itself. Returns
     * `undefined` when nothing was staged (no changes) so the workflow
     * can distinguish an empty run from a real commit.
     *
     * All git invocations go through `execFile` with an explicit argv
     * (never a shell) so arbitrary `taskSlug` or `commitTitle` values
     * can't inject.
     */
    async commitAgentWork(input: {
      worktreePath: string;
      taskSlug: string;
      commitTitle: string;
    }): Promise<string | undefined> {
      await execFileAsync("git", ["add", "-A"], {
        cwd: input.worktreePath,
      });

      // `git commit` fails with exit code 1 when there is nothing to
      // commit. We distinguish that case (expected) from a real error
      // (unexpected) via the stdout/stderr signature rather than the
      // exit code alone — some environments localize the message, so
      // fall back to the stdout marker too.
      try {
        await execFileAsync(
          "git",
          ["commit", "-m", input.commitTitle],
          { cwd: input.worktreePath },
        );
      } catch (err) {
        const message = extractExecMessage(err);
        if (isNothingToCommit(message)) return undefined;
        throw err;
      }

      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: input.worktreePath,
      });
      const sha = stdout.trim();
      return sha.length > 0 ? sha : undefined;
    },
  };
}

function extractExecMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const record = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const parts: string[] = [];
  for (const v of [record.stdout, record.stderr, record.message]) {
    if (typeof v === "string") parts.push(v);
  }
  return parts.join("\n");
}

const NOTHING_TO_COMMIT_PATTERNS = [
  /nothing to commit/i,
  /no changes added to commit/i,
  /nothing added to commit/i,
];

function isNothingToCommit(message: string): boolean {
  return NOTHING_TO_COMMIT_PATTERNS.some((re) => re.test(message));
}
