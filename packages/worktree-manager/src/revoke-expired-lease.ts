import { detectDirty } from "./detect-dirty.js";
import { releaseLease } from "./release-lease.js";

/**
 * Input required to revoke a lease that has exceeded `expiresAt`.
 *
 * Mirrors the `ReleaseLeaseInput` shape deliberately — callers already
 * have these fields on the persisted lease row, so the activity
 * wrapper can pass them straight through.
 */
export interface RevokeExpiredLeaseInput {
  worktreePath: string;
  repoRoot: string;
  branchName: string;
}

/**
 * Result of attempting to revoke an expired lease.
 *
 * When the worktree is dirty, nothing on disk is touched: the caller
 * must escalate to a human because arbitrary clean-up risks destroying
 * committed or uncommitted implementer work.
 */
export interface RevokeExpiredLeaseResult {
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  dirty: boolean;
}

/**
 * Revoke an expired lease only when the worktree is clean. Dirty
 * worktrees return `{ dirty: true, ... }` WITHOUT running any
 * destructive git command so the orchestrator can park the lease
 * (status='expired') and notify a human reviewer.
 */
export async function revokeExpiredLease(
  input: RevokeExpiredLeaseInput,
): Promise<RevokeExpiredLeaseResult> {
  const report = await detectDirty({ worktreePath: input.worktreePath });
  if (report.dirty) {
    return { worktreeRemoved: false, branchRemoved: false, dirty: true };
  }

  // Clean worktree: defer to `releaseLease`. It already handles both
  // the worktree removal and the branch deletion idempotently.
  await releaseLease({
    worktreePath: input.worktreePath,
    repoRoot: input.repoRoot,
    branchName: input.branchName,
  });
  return { worktreeRemoved: true, branchRemoved: true, dirty: false };
}
