import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WorktreeManagerError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface AttemptIntegrationMergeInput {
  /** Integration worktree's on-disk path (kind='integration' lease). */
  integrationWorktreePath: string;
  /** Task branch to merge INTO the integration branch (local ref or SHA). */
  taskBranchName: string;
  /** Optional commit message override. */
  commitMessage?: string;
}

export type AttemptIntegrationMergeResult =
  | { status: "merged"; mergedHeadSha: string }
  | { status: "conflict"; conflictedPaths: string[] }
  | { status: "other_error"; message: string };

/**
 * Merge `taskBranchName` into the integration branch checked out inside
 * `integrationWorktreePath` via `git merge --no-ff`. Classifies
 * failures:
 *   - `status='conflict'` with the paths from `git status
 *     --porcelain=v1`; the helper auto-aborts the merge so the
 *     worktree is left clean for a retry.
 *   - `status='other_error'` with `message` for anything else (detached
 *     HEAD, unknown ref, etc.); the caller decides whether to retry.
 *
 * Uses `LANG=C`/`LC_ALL=C` so the "CONFLICT" + "Automatic merge failed"
 * substrings we parse are locale-independent.
 */
export async function attemptIntegrationMerge(
  input: AttemptIntegrationMergeInput,
): Promise<AttemptIntegrationMergeResult> {
  const commitMessage =
    input.commitMessage ?? `merge(${input.taskBranchName}) into integration`;

  try {
    await execFileAsync(
      "git",
      [
        "-C",
        input.integrationWorktreePath,
        "merge",
        "--no-ff",
        "-m",
        commitMessage,
        input.taskBranchName,
      ],
      { env: { ...process.env, LANG: "C", LC_ALL: "C" } },
    );
  } catch (err) {
    const stdout = extractStdout(err);
    const stderr = extractStderr(err);
    const combined = `${stdout}\n${stderr}`;

    if (isConflict(combined)) {
      // Read conflicted paths BEFORE aborting — `git merge --abort`
      // restores the pre-merge working tree and the `UU`/`AA`/etc.
      // status codes disappear.
      const conflictedPaths = await readConflictedPaths(
        input.integrationWorktreePath,
      );
      // Always try to abort so the integration worktree is usable for a
      // retry. If abort itself fails we surface a distinct error code
      // so the workflow doesn't silently leave the worktree in a
      // half-merged state.
      try {
        await execFileAsync(
          "git",
          ["-C", input.integrationWorktreePath, "merge", "--abort"],
          { env: { ...process.env, LANG: "C", LC_ALL: "C" } },
        );
      } catch (abortErr) {
        throw new WorktreeManagerError(
          "merge-abort-failed",
          `git merge --abort failed after conflict in ${input.integrationWorktreePath}: ${extractStderr(abortErr)}`,
        );
      }
      return { status: "conflict", conflictedPaths };
    }

    return {
      status: "other_error",
      message: stderr.trim() || stdout.trim() || "git merge failed",
    };
  }

  const mergedHeadSha = await readHeadSha(input.integrationWorktreePath);
  return { status: "merged", mergedHeadSha };
}

async function readConflictedPaths(
  integrationWorktreePath: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", integrationWorktreePath, "status", "--porcelain=v1"],
      { env: { ...process.env, LANG: "C", LC_ALL: "C" } },
    );
    // Unmerged (conflict) entries in `git status --porcelain=v1` are
    // any of the seven XY pairs: DD, AU, UD, UA, DU, AA, UU.
    // (`git help status` → Short Format → Unmerged entries.)
    return stdout
      .split(/\r?\n/)
      .filter((line) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(line))
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

async function readHeadSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      cwd,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim();
  } catch (err) {
    throw new WorktreeManagerError(
      "git-command-failed",
      `git rev-parse HEAD failed in ${cwd}: ${extractStderr(err)}`,
    );
  }
}

function extractStdout(err: unknown): string {
  if (err && typeof err === "object") {
    const s = (err as { stdout?: unknown }).stdout;
    if (typeof s === "string") return s;
  }
  return "";
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object") {
    const s = (err as { stderr?: unknown }).stderr;
    if (typeof s === "string") return s;
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

function isConflict(output: string): boolean {
  return (
    /CONFLICT/i.test(output) ||
    /Automatic merge failed/i.test(output) ||
    /fix conflicts/i.test(output)
  );
}
