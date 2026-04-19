import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WorktreeManagerError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface AbortIntegrationMergeInput {
  integrationWorktreePath: string;
}

/**
 * Standalone `git merge --abort` wrapper for workflow retry paths that
 * need to abort without first re-running `attemptIntegrationMerge`.
 * Idempotent: if no merge is in progress, git exits non-zero with
 * "There is no merge to abort" — we treat that as success because the
 * post-condition (worktree clean of an in-progress merge) holds.
 */
export async function abortIntegrationMerge(
  input: AbortIntegrationMergeInput,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["-C", input.integrationWorktreePath, "merge", "--abort"],
      { env: { ...process.env, LANG: "C", LC_ALL: "C" } },
    );
  } catch (err) {
    const stderr = extractStderr(err);
    if (/no merge to abort/i.test(stderr)) {
      // No merge in progress — nothing to abort. Idempotent success.
      return;
    }
    throw new WorktreeManagerError(
      "merge-abort-failed",
      `git merge --abort failed in ${input.integrationWorktreePath}: ${stderr}`,
    );
  }
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
