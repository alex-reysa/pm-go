/**
 * Tag union for all failure modes produced by the worktree manager.
 * Matching on `code` keeps orchestrator-side error handling exhaustive
 * and independent of platform-specific git error strings.
 */
export type WorktreeManagerErrorCode =
  | "not-a-git-repo"
  | "dirty-worktree"
  | "lease-not-found"
  | "worktree-add-failed"
  | "worktree-already-exists"
  | "git-command-failed";

export class WorktreeManagerError extends Error {
  readonly code: WorktreeManagerErrorCode;

  constructor(code: WorktreeManagerErrorCode, message: string) {
    super(message);
    this.name = "WorktreeManagerError";
    this.code = code;
  }
}
