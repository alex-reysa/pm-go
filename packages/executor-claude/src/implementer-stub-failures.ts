/**
 * Phase 7 chaos harness — implementer stub failure modes.
 *
 * This file is **stub-only**. It does not import the real
 * `@anthropic-ai/claude-agent-sdk` implementer runner and nothing in
 * `implementer-runner.ts` has been changed to accommodate it. Failure
 * modes are activated exclusively by env var — setting the env var
 * flips the wrapper's behaviour; unsetting it returns the wrapper to a
 * transparent pass-through.
 *
 * Three modes:
 *   - merge_conflict : the stub writes a payload guaranteed to conflict
 *     with a pre-staged parallel commit on `main`. The chaos harness
 *     then observes `git merge` failing and flips the task to
 *     `blocked` after retry exhaustion.
 *   - worker_kill    : the stub writes a partial file and then exits
 *     the current Node process with a non-zero code, simulating a
 *     SIGKILL mid-activity. The harness asserts the task stays
 *     `running` across the kill and resumes on the next pass.
 *   - review_rejection (reviewer-side mirror; see reviewer-stub-failures.ts)
 *
 * The wrapper exposed from this module is a pure adapter: it takes an
 * existing `ImplementerRunner` (typically the output of
 * `createStubImplementerRunner`) and returns an `ImplementerRunner`
 * whose behaviour depends on the failure mode. This lets the harness
 * re-use every stub option (write-file, per-slug map) without
 * duplicating logic.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ImplementerRunner,
  ImplementerRunnerInput,
  ImplementerRunnerResult,
} from "./index.js";

const execFile = promisify(execFileCb);

export type ImplementerStubFailureMode = "merge_conflict" | "worker_kill";

/**
 * Read the failure mode from env. Accepts an explicit value for tests;
 * falls back to `process.env.IMPLEMENTER_STUB_FAILURE`. Returns
 * `undefined` when unset or unrecognised so callers can treat "no
 * failure injection" uniformly.
 */
export function resolveImplementerStubFailureMode(
  explicit?: string,
): ImplementerStubFailureMode | undefined {
  const raw = explicit ?? process.env.IMPLEMENTER_STUB_FAILURE;
  if (!raw) return undefined;
  if (raw === "merge_conflict" || raw === "worker_kill") {
    return raw;
  }
  return undefined;
}

export interface ImplementerStubFailureOptions {
  /** Optional override of the failure mode; defaults to env-var lookup. */
  mode?: string;
  /**
   * Called when `worker_kill` fires instead of `process.exit(1)`. Tests
   * inject this to observe the kill as a thrown error rather than
   * actually tearing down the process. Defaults to a wrapper that
   * `process.exit(1)`s so the harness-sub-process semantics match the
   * real SIGKILL path.
   */
  onWorkerKill?: (input: ImplementerRunnerInput) => never | void;
}

/**
 * Wrap an existing `ImplementerRunner` with env-var-activated failure
 * injection. When no mode is active the wrapper is a pure pass-through.
 */
export function wrapImplementerRunnerWithFailureMode(
  inner: ImplementerRunner,
  options: ImplementerStubFailureOptions = {},
): ImplementerRunner {
  const mode = resolveImplementerStubFailureMode(options.mode);
  if (!mode) {
    return inner;
  }

  return {
    async run(
      input: ImplementerRunnerInput,
    ): Promise<ImplementerRunnerResult> {
      if (mode === "merge_conflict") {
        return runWithMergeConflict(inner, input);
      }
      // worker_kill
      return runWithWorkerKill(inner, input, options.onWorkerKill);
    },
  };
}

/**
 * merge_conflict: let the inner runner produce a commit (so the task
 * branch has content), but also write a second commit on `main` that
 * touches the same relative path with different bytes, guaranteeing a
 * conflict at integration time. Returns the inner runner's normal
 * result — the conflict surfaces later, not here.
 */
async function runWithMergeConflict(
  inner: ImplementerRunner,
  input: ImplementerRunnerInput,
): Promise<ImplementerRunnerResult> {
  const result = await inner.run(input);

  // Pre-stage a parallel commit on main. We don't know the file the
  // inner stub wrote, so we reconstruct it from the configured
  // fileScope. For the chaos harness the fileScope has exactly one
  // include glob pointing at `phase7-chaos/<slug>.txt`; we write
  // different bytes to that path on main so integration-time merge
  // hits a textual conflict.
  const conflictRel = inferConflictPath(input);
  if (conflictRel) {
    await stageConflictCommitOnMain(input.worktreePath, conflictRel);
  }

  return result;
}

/**
 * worker_kill: allow a *partial* write to land (mkdir + writeFile, no
 * commit), then simulate SIGKILL by exiting non-zero. Matches the
 * real-world failure where the implementer process dies mid-activity
 * with bytes on disk but no commit. The harness then starts a second
 * pass without the failure env set; the fresh stub commits the file
 * and the task completes.
 */
async function runWithWorkerKill(
  _inner: ImplementerRunner,
  input: ImplementerRunnerInput,
  onWorkerKill?: (input: ImplementerRunnerInput) => never | void,
): Promise<ImplementerRunnerResult> {
  const rel = inferConflictPath(input);
  if (rel) {
    const abs = path.resolve(input.worktreePath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await fsWriteFile(abs, "partial worker_kill payload\n", "utf8");
  }
  if (onWorkerKill) {
    onWorkerKill(input);
    // If onWorkerKill didn't throw/exit, we still model the kill as a
    // thrown error so the caller's catch path fires.
    throw new Error("worker_kill: stub process exiting non-zero (test hook)");
  }
  // Default: exit the current Node process non-zero. The harness runs
  // each chaos pass in a fresh tsx sub-process so this cleanly
  // simulates a crashed worker.
  // eslint-disable-next-line no-process-exit -- intentional: this is the failure mode
  process.exit(137);
}

/**
 * Infer the relative path the inner stub wrote from the task's
 * fileScope. The chaos harness always configures fileScope.includes
 * with exactly one concrete path (no globs), so this is safe. Returns
 * `undefined` when the fileScope is ambiguous — the caller falls back
 * to the inner runner's result unchanged.
 */
function inferConflictPath(
  input: ImplementerRunnerInput,
): string | undefined {
  const includes = input.task.fileScope.includes;
  if (includes.length !== 1) return undefined;
  const only = includes[0]!;
  if (only.includes("*")) return undefined;
  return only;
}

async function stageConflictCommitOnMain(
  worktreePath: string,
  relPath: string,
): Promise<void> {
  const absTarget = path.resolve(worktreePath, relPath);
  await mkdir(path.dirname(absTarget), { recursive: true });
  // Write CONFLICT bytes first on a branch-off-of-main commit so the
  // task branch's version will diverge. We stash the current branch,
  // switch to main, commit, and switch back.
  const { stdout: currentBranch } = await execFile(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: worktreePath },
  );
  const branch = currentBranch.trim();
  // Check out main (creating if needed) and write conflicting contents.
  try {
    await execFile("git", ["checkout", "main"], {
      cwd: worktreePath,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
  } catch {
    // If main doesn't exist (detached fixture), nothing to do.
    return;
  }
  // Re-create the parent directory: the `git checkout main` above may
  // have stripped directories that only existed on the task branch.
  await mkdir(path.dirname(absTarget), { recursive: true });
  await fsWriteFile(
    absTarget,
    `CONFLICT: parallel commit on main\nfor ${relPath}\n`,
    "utf8",
  );
  await execFile("git", ["add", "--", relPath], { cwd: worktreePath });
  try {
    await execFile(
      "git",
      ["commit", "-m", `chore(conflict): parallel commit for ${relPath}`],
      { cwd: worktreePath, env: { ...process.env, LANG: "C", LC_ALL: "C" } },
    );
  } catch {
    // Swallow — if nothing differs we'll just not have a conflict, and
    // the harness will detect that and fail its assertion, which is
    // the correct outcome.
  }
  if (branch && branch !== "main" && branch !== "HEAD") {
    await execFile("git", ["checkout", branch], { cwd: worktreePath });
  }
}

/**
 * Lightweight helper the chaos harness uses to perform the merge step
 * and detect a conflict deterministically. Returns `{ status: "clean"
 * }` on a clean merge and `{ status: "conflict", conflictedPaths: [...]
 * }` when the merge aborts. Living here (rather than in a "real"
 * integration package) keeps Phase 7 W3's ownership narrow.
 */
export async function tryMergeBranchOntoMain(
  worktreePath: string,
  branch: string,
): Promise<
  | { status: "clean" }
  | { status: "conflict"; conflictedPaths: string[] }
> {
  await execFile("git", ["checkout", "main"], {
    cwd: worktreePath,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  try {
    await execFile(
      "git",
      ["merge", "--no-edit", "--no-ff", branch],
      {
        cwd: worktreePath,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
      },
    );
    return { status: "clean" };
  } catch {
    const { stdout } = await execFile(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: worktreePath },
    );
    const paths = stdout
      .split("\n")
      .map((s: string) => s.trim())
      .filter(Boolean);
    // Abort the merge so subsequent ops don't leave the tree dirty.
    await execFile("git", ["merge", "--abort"], {
      cwd: worktreePath,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    }).catch(() => undefined);
    return { status: "conflict", conflictedPaths: paths };
  }
}
