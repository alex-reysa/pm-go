import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { desc, eq } from "drizzle-orm";

import type {
  AgentRun,
  Task,
  TaskStatus,
} from "@pm-go/contracts";
import {
  agentRuns,
  planTasks,
  workflowEvents,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import type {
  ImplementerReviewFeedback,
  ImplementerRunner,
} from "@pm-go/executor-claude";
import { runImplementer as runImplementerPkg } from "@pm-go/planner";
import { createSpanWriter, withSpan } from "@pm-go/observability";

const execFileAsync = promisify(execFile);

/**
 * v0.8.6 P0 hygiene-guard symbol. The `commitAgentWork` activity
 * surfaces this string both as the discriminated `reason` on a typed
 * failure and as the prefix of the `agent_runs.errorReason` text it
 * persists. Reviewers, the TUI, and the failure-mode runbook all key
 * off the same literal so a single grep finds every site.
 *
 * Phase 0 of the v0.8.6 plan owns the canonical declaration; activity
 * code re-exports it as the source of truth until the symbol moves to
 * `@pm-go/contracts` in a follow-up that touches that package's
 * public surface (out of scope here).
 */
export const IGNORED_ARTIFACT_COMMITTED = "IGNORED_ARTIFACT_COMMITTED" as const;
export type IgnoredArtifactCommitted = typeof IGNORED_ARTIFACT_COMMITTED;

/**
 * Discriminated result of `commitAgentWork`. The legacy shape returned
 * a bare `string | undefined` (commit sha or "nothing to commit"); we
 * widen it here so the hygiene guard can surface a typed rejection
 * without throwing — keeps Temporal retries off the hot path for an
 * authored-content failure.
 */
export type CommitAgentWorkResult =
  | { ok: true; sha?: string }
  | { ok: false; reason: IgnoredArtifactCommitted; paths: string[] };

/**
 * Injectable signature used by the hygiene guard. Default
 * implementation shells out to `git -C <worktree> check-ignore -v
 * --stdin`. Tests stub this to assert the guard's branching without
 * spawning a real git process.
 */
export type CheckIgnoreFn = (
  worktreePath: string,
  paths: string[],
) => Promise<string[]>;

export interface TaskExecutionActivityDeps {
  db: PmGoDb;
  implementerRunner: ImplementerRunner;
  repoRoot: string;
  worktreeRoot: string;
  /** Claude model id. When unset, the implementer package default applies. */
  implementerModel?: string;
  /**
   * Override for tests. Defaults to `defaultCheckIgnore` (spawn-based
   * `git check-ignore`). Production wiring leaves this undefined so
   * the activity uses the real git binary inside the worktree.
   */
  checkIgnore?: CheckIgnoreFn;
  /**
   * Override for tests that want to short-circuit `git status`,
   * `git add`, `git commit`, and `git rev-parse` without running a
   * real git binary. Defaults to `promisify(execFile)`.
   */
  exec?: typeof execFileAsync;
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
  const exec = deps.exec ?? execFileAsync;
  const checkIgnore = deps.checkIgnore ?? defaultCheckIgnore;
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
        // v0.8.2.1: hydrate sizeHint so the small-task fast path
        // actually fires for persisted tasks. Persistence side stamps
        // size_hint nullable; absent → undefined → effective medium.
        ...(row.sizeHint !== null ? { sizeHint: row.sizeHint } : {}),
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
     *
     * Also projects the transition onto `workflow_events` as a
     * `task_status_changed` event. Best-effort — mirrors the
     * phase-status pattern in `createIntegrationActivities`. A failed
     * read-model emit must never block the underlying task transition.
     *
     * v0.8.6 P0 hygiene guard — sticky-blocked: once a task has been
     * durably parked at `"blocked"` (e.g. by `commitAgentWork`'s
     * ignored-artifact rejection), subsequent transitions to a
     * non-blocked status are silently dropped. Without this, the
     * outer workflow's catch clause would happily clobber a freshly
     * blocked row with `"failed"` and the operator would lose the
     * authored-content failure reason.
     */
    async updateTaskStatus(input: {
      taskId: string;
      status: TaskStatusTransition;
    }): Promise<void> {
      const dbStatus = toDbStatus(input.status);
      // Read the prior status + subject ids BEFORE the UPDATE so the
      // event carries accurate before/after. Single writer via this
      // activity means the tiny window between select and update is
      // acceptable for a read-model projection.
      const [prev] = await deps.db
        .select({
          status: planTasks.status,
          planId: planTasks.planId,
          phaseId: planTasks.phaseId,
        })
        .from(planTasks)
        .where(eq(planTasks.id, input.taskId))
        .limit(1);
      if (!prev) {
        // Task missing — treat the UPDATE as a no-op and skip the span
        // (no plan to scope it to). Mirrors integration.updatePhaseStatus.
        await deps.db
          .update(planTasks)
          .set({ status: dbStatus })
          .where(eq(planTasks.id, input.taskId));
        return;
      }
      // Sticky-blocked guard. The hygiene guard in `commitAgentWork`
      // sets `blocked` directly on the row; the workflow's later
      // happy-path or catch-arm transitions must not silently override
      // it. `blocked → blocked` stays a no-op via the prev===next
      // event check below.
      if (prev.status === "blocked" && dbStatus !== "blocked") {
        return;
      }
      const sink = createSpanWriter({
        db: deps.db,
        planId: prev.planId,
      }).writeSpan;
      await withSpan(
        "worker.activities.task-execution.updateTaskStatus",
        {
          planId: prev.planId,
          phaseId: prev.phaseId,
          taskId: input.taskId,
          previousStatus: prev.status,
          nextStatus: dbStatus,
        },
        async () => {
          await deps.db
            .update(planTasks)
            .set({ status: dbStatus })
            .where(eq(planTasks.id, input.taskId));
          if (prev.status !== dbStatus) {
            try {
              await deps.db.insert(workflowEvents).values({
                id: randomUUID(),
                planId: prev.planId,
                phaseId: prev.phaseId,
                taskId: input.taskId,
                kind: "task_status_changed",
                payload: {
                  previousStatus: prev.status,
                  nextStatus: dbStatus,
                },
                createdAt: new Date().toISOString(),
              });
            } catch (err) {
              console.warn(
                `[events] task_status_changed emit failed (taskId=${input.taskId}): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        },
        { sink },
      );
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
      /** Populated on fix cycles; forwarded verbatim to the runner. */
      reviewFeedback?: ImplementerReviewFeedback;
    }): Promise<{ agentRun: AgentRun; finalCommitSha?: string }> {
      const result = await runImplementerPkg({
        task: input.task,
        worktreePath: input.worktreePath,
        baseSha: input.baseSha,
        requestedBy: input.reviewFeedback
          ? "task-fix-workflow"
          : "task-execution-workflow",
        runner: deps.implementerRunner,
        ...(input.reviewFeedback ? { reviewFeedback: input.reviewFeedback } : {}),
        ...(deps.implementerModel !== undefined ? { model: deps.implementerModel } : {}),
      });
      return result.finalCommitSha !== undefined
        ? { agentRun: result.agentRun, finalCommitSha: result.finalCommitSha }
        : { agentRun: result.agentRun };
    },

    /**
     * Stage + commit any pending changes in the worktree on behalf of
     * the implementer when the runner did not commit itself.
     *
     * v0.8.6 P0: before staging, the activity collects the set of
     * paths that `git add -A` *would* stage and runs them through
     * `assertNoIgnoredPaths`. If any path is matched by a gitignore
     * rule (think `node_modules/`, `dist/`, `.venv/` — the implementer
     * accidentally committed an artifact), the activity:
     *
     *   1. Persists the offending repo-relative paths on the agent
     *      run record (`agent_runs.errorReason`).
     *   2. Stamps the task `blocked` directly. The workflow's
     *      `updateTaskStatus` honors the sticky-blocked guard, so the
     *      catch-arm `failed` transition becomes a no-op.
     *   3. Returns `{ ok: false, reason: IGNORED_ARTIFACT_COMMITTED,
     *      paths }` so callers (and tests) can distinguish "nothing
     *      to commit" from "rejected on hygiene".
     *
     * On the happy path the legacy behavior is preserved: stage, try
     * to commit, treat "nothing to commit" as `{ ok: true }` (no
     * `sha`), otherwise return `{ ok: true, sha }`.
     *
     * All git invocations go through `execFile` with an explicit argv
     * (never a shell) so arbitrary `taskSlug` or `commitTitle` values
     * can't inject. `check-ignore` is the one exception — it needs
     * stdin — and uses a tightly-scoped `spawn`.
     */
    async commitAgentWork(input: {
      worktreePath: string;
      taskSlug: string;
      commitTitle: string;
    }): Promise<CommitAgentWorkResult> {
      // Hygiene guard (Phase 0). Look at the working-tree changes that
      // `git add -A` is about to stage, before we actually stage them,
      // so we can refuse the commit without leaving an index in a
      // half-staged state.
      const stagedPaths = await listPendingPaths(exec, input.worktreePath);
      const ignoredPaths = await assertNoIgnoredPaths(
        checkIgnore,
        input.worktreePath,
        stagedPaths,
      );
      if (ignoredPaths.length > 0) {
        await persistIgnoredArtifactBlock(
          deps.db,
          input.worktreePath,
          ignoredPaths,
        );
        return {
          ok: false,
          reason: IGNORED_ARTIFACT_COMMITTED,
          paths: ignoredPaths,
        };
      }

      await exec("git", ["add", "-A"], {
        cwd: input.worktreePath,
      });

      // `git commit` fails with exit code 1 when there is nothing to
      // commit. We distinguish that case (expected) from a real error
      // (unexpected) via the stdout/stderr signature rather than the
      // exit code alone — some environments localize the message, so
      // fall back to the stdout marker too.
      try {
        await exec(
          "git",
          ["commit", "-m", input.commitTitle],
          { cwd: input.worktreePath },
        );
      } catch (err) {
        const message = extractExecMessage(err);
        if (isNothingToCommit(message)) return { ok: true };
        throw err;
      }

      const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: input.worktreePath,
      });
      const sha = stdout.trim();
      return sha.length > 0 ? { ok: true, sha } : { ok: true };
    },

    /**
     * Read-only `git rev-parse HEAD` inside a worktree. Used by the
     * review + fix workflows to capture the implementer's tip sha at
     * review time (distinct from the lease's `baseSha`, which is the
     * branch-from-main sha).
     */
    async readWorktreeHeadSha(input: {
      worktreePath: string;
    }): Promise<string> {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
        cwd: input.worktreePath,
      });
      const sha = stdout.trim();
      if (sha.length === 0) {
        throw new Error(
          `readWorktreeHeadSha: empty HEAD in worktree ${input.worktreePath}`,
        );
      }
      return sha;
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

/**
 * Run `git status --porcelain` in `worktreePath` and return the set
 * of paths that `git add -A` is about to stage. Handles renames
 * (`R  old -> new`) by returning the new path — that's the path
 * `check-ignore` cares about.
 */
async function listPendingPaths(
  exec: typeof execFileAsync,
  worktreePath: string,
): Promise<string[]> {
  const { stdout } = await exec("git", ["status", "--porcelain"], {
    cwd: worktreePath,
  });
  if (typeof stdout !== "string" || stdout.length === 0) return [];
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    // Porcelain v1: "XY <path>" where X/Y are status chars and the
    // path starts at column 3. Renames carry " -> " between the old
    // and new paths.
    const tail = line.length > 3 ? line.slice(3) : "";
    if (tail.length === 0) continue;
    const arrow = tail.indexOf(" -> ");
    paths.push(arrow >= 0 ? tail.slice(arrow + 4) : tail);
  }
  return paths;
}

/**
 * Hygiene guard. Runs `stagedPaths` through `git check-ignore` (via
 * the injected `checkIgnore` dep) and returns the subset that match
 * a gitignore rule. Empty input → empty output (no spawn).
 */
async function assertNoIgnoredPaths(
  checkIgnore: CheckIgnoreFn,
  worktreePath: string,
  stagedPaths: string[],
): Promise<string[]> {
  if (stagedPaths.length === 0) return [];
  return checkIgnore(worktreePath, stagedPaths);
}

/**
 * Default `git check-ignore` runner. Uses `spawn` (not `execFile`)
 * because we pipe the candidate paths through stdin to avoid argv
 * length limits and shell-quoting hazards.
 *
 * `git check-ignore -v --stdin` exits:
 *   - 0 when at least one path matched a rule (we want this output);
 *   - 1 when none matched (empty output, no error);
 *   - 128 on a real error (corrupted repo, missing worktree, etc.).
 */
function defaultCheckIgnore(
  worktreePath: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", worktreePath, "check-ignore", "-v", "--stdin"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(parseCheckIgnoreOutput(stdout));
        return;
      }
      reject(
        new Error(
          `git check-ignore exited ${code} in ${worktreePath}: ${stderr.trim()}`,
        ),
      );
    });
    child.stdin.write(paths.join("\n") + "\n");
    child.stdin.end();
  });
}

/**
 * `git check-ignore -v --stdin` output line:
 *   `<source>:<lineno>:<pattern>\t<path>`
 * Strip the verbose prefix and return repo-relative paths.
 */
function parseCheckIgnoreOutput(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tab = line.lastIndexOf("\t");
    out.push(tab >= 0 ? line.slice(tab + 1) : line);
  }
  return out;
}

/**
 * Persist the ignored-artifact failure on the agent run record and
 * stamp the task `blocked`. Best-effort lookups: if the worktree
 * lease, task, or agent run have been GC'd between the implementer
 * commit and this guard, we still return cleanly so the activity
 * surfaces the typed failure to the workflow.
 */
async function persistIgnoredArtifactBlock(
  db: PmGoDb,
  worktreePath: string,
  ignoredPaths: string[],
): Promise<void> {
  const [lease] = await db
    .select({ taskId: worktreeLeases.taskId })
    .from(worktreeLeases)
    .where(eq(worktreeLeases.worktreePath, worktreePath))
    .limit(1);
  const taskId = lease?.taskId ?? null;
  if (taskId !== null) {
    const [run] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    if (run) {
      await db
        .update(agentRuns)
        .set({
          errorReason: `${IGNORED_ARTIFACT_COMMITTED}: ${ignoredPaths.join(",")}`,
        })
        .where(eq(agentRuns.id, run.id));
    }
    await db
      .update(planTasks)
      .set({ status: "blocked" })
      .where(eq(planTasks.id, taskId));
  }
}
