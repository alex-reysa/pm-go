import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WorktreeManagerError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface FastForwardMainInput {
  repoRoot: string;
  /** Target commit that `main` should advance to. */
  newSha: string;
  /**
   * Current `main` HEAD observed when the phase started integrating.
   * `git update-ref` refuses to advance if the actual ref no longer
   * matches this value — optimistic locking against concurrent pushes.
   */
  expectedCurrentSha: string;
  /** Branch to advance. Defaults to `'main'`. */
  targetBranch?: string;
}

export interface FastForwardMainResult {
  headSha: string;
}

/**
 * Advance `refs/heads/main` to `newSha` via `git update-ref`. Atomic,
 * no checkout, optimistically locked against concurrent updates.
 *
 * Two refusal paths, each surfacing a distinct `WorktreeManagerError`
 * code so the caller can branch without string matching:
 *   - `non-fast-forward` — `newSha` is not a descendant of
 *     `expectedCurrentSha` (pre-check via `git merge-base
 *     --is-ancestor`). Publishing a non-descendant commit to `main`
 *     would rewrite history for anyone already pulled — refuse.
 *   - `main-advance-conflict` — `main`'s actual SHA differs from
 *     `expectedCurrentSha`. Someone else advanced the branch between
 *     when the phase captured its baseline and when the audit
 *     completed. The caller must re-partition or escalate.
 *
 * Never checks out any branch. Safe to call regardless of what
 * `HEAD` points at in the repo's working tree.
 */
export async function fastForwardMainViaUpdateRef(
  input: FastForwardMainInput,
): Promise<FastForwardMainResult> {
  const targetBranch = input.targetBranch ?? "main";
  const targetRef = `refs/heads/${targetBranch}`;

  // Ancestry pre-check. `git merge-base --is-ancestor A B` exits 0 iff
  // A is an ancestor of B. We require expectedCurrentSha to be an
  // ancestor of newSha (i.e. newSha is a descendant) so the update
  // is strictly a fast-forward.
  try {
    await execFileAsync("git", [
      "-C",
      input.repoRoot,
      "merge-base",
      "--is-ancestor",
      input.expectedCurrentSha,
      input.newSha,
    ]);
  } catch {
    throw new WorktreeManagerError(
      "non-fast-forward",
      `refuse to advance ${targetBranch}: ${input.newSha} is not a descendant of ${input.expectedCurrentSha}`,
    );
  }

  // Resolve the actual current ref; `update-ref` with two args does its
  // own check but we want a distinct error code for "main moved under
  // us" vs "your new sha is not a descendant".
  let actualCurrentSha: string;
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      input.repoRoot,
      "rev-parse",
      "--verify",
      targetRef,
    ]);
    actualCurrentSha = stdout.trim();
  } catch (err) {
    throw new WorktreeManagerError(
      "git-command-failed",
      `rev-parse ${targetRef} failed: ${extractStderr(err)}`,
    );
  }

  if (actualCurrentSha !== input.expectedCurrentSha) {
    throw new WorktreeManagerError(
      "main-advance-conflict",
      `${targetBranch} expected to be at ${input.expectedCurrentSha} but is at ${actualCurrentSha}`,
    );
  }

  // update-ref with three args is atomic + optimistically locked.
  try {
    await execFileAsync("git", [
      "-C",
      input.repoRoot,
      "update-ref",
      targetRef,
      input.newSha,
      input.expectedCurrentSha,
    ]);
  } catch (err) {
    throw new WorktreeManagerError(
      "main-advance-conflict",
      `git update-ref ${targetRef} ${input.newSha} ${input.expectedCurrentSha} failed: ${extractStderr(err)}`,
    );
  }

  return { headSha: input.newSha };
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
