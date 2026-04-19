import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Input required to release an agent worktree.
 *
 * `force` maps directly to `git worktree remove --force`, which is
 * needed when the worktree has local changes a reviewer explicitly
 * opted to discard. Default is `false` so accidental data loss is
 * opt-in rather than opt-out.
 */
export interface ReleaseLeaseInput {
  worktreePath: string;
  repoRoot: string;
  branchName: string;
  force?: boolean;
}

/**
 * Remove the worktree from disk and, if the branch has no commits ahead
 * of `HEAD`, delete the branch as well. Leave branches with unmerged
 * work in place so the reviewer/integrator can decide their fate.
 *
 * Idempotent: calling `releaseLease` on an already-released lease is a
 * no-op — both "not a working tree" and "branch not found" errors are
 * swallowed so retries from a Temporal workflow stay safe.
 */
export async function releaseLease(input: ReleaseLeaseInput): Promise<void> {
  const removeArgs = [
    "-C",
    input.repoRoot,
    "worktree",
    "remove",
    input.worktreePath,
  ];
  if (input.force === true) {
    removeArgs.push("--force");
  }

  try {
    await execFileAsync("git", removeArgs);
  } catch (err) {
    if (!isMissingWorktreeError(err)) {
      throw err;
    }
    // Swallow: worktree is already gone.
  }

  // Only delete the branch if it has no commits ahead of HEAD — unmerged
  // implementer work is left intact so the integrator can salvage it.
  let commitsAhead: number;
  try {
    commitsAhead = await countCommitsAhead(
      input.repoRoot,
      input.branchName,
    );
  } catch (err) {
    if (isMissingBranchError(err)) return;
    throw err;
  }

  if (commitsAhead > 0) return;

  try {
    await execFileAsync("git", [
      "-C",
      input.repoRoot,
      "branch",
      "-d",
      input.branchName,
    ]);
  } catch (err) {
    if (isMissingBranchError(err)) return;
    throw err;
  }
}

/**
 * Count commits reachable from `branchName` but not from `HEAD`. Used to
 * decide whether the branch still carries implementer work that the
 * reviewer should see before it vanishes.
 */
async function countCommitsAhead(
  repoRoot: string,
  branchName: string,
): Promise<number> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    repoRoot,
    "rev-list",
    "--count",
    `HEAD..${branchName}`,
  ]);
  const trimmed = stdout.trim();
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMissingWorktreeError(err: unknown): boolean {
  const message = extractStderr(err).toLowerCase();
  return (
    message.includes("is not a working tree") ||
    message.includes("not a working tree")
  );
}

function isMissingBranchError(err: unknown): boolean {
  const message = extractStderr(err).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("unknown revision") ||
    message.includes("no such branch") ||
    message.includes("bad revision")
  );
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object") {
    const maybeStderr = (err as { stderr?: unknown }).stderr;
    if (typeof maybeStderr === "string") return maybeStderr;
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return String(err);
}
