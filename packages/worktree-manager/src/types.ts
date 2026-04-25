import type { FileScope, UUID } from "@pm-go/contracts";

/**
 * Input shape consumed by {@link buildBranchName}. Keeping it a dedicated
 * type keeps call sites self-documenting when they assemble the branch
 * name from a persisted task row.
 */
export interface BranchNamingInput {
  planId: UUID;
  taskId: UUID;
  slug: string;
}

/**
 * Result of inspecting a leased worktree for uncommitted state. The
 * dirty-worktree policy escalates rather than auto-cleans, so consumers
 * need a detailed breakdown to include in the escalation payload.
 */
export interface DirtyReport {
  dirty: boolean;
  /** Files that `git` reports as modified relative to HEAD. */
  modifiedFiles: string[];
  /** Untracked files not covered by `.gitignore`. */
  unknownFiles: string[];
}

/**
 * Result of diffing a worktree branch against its lease's `baseSha` and
 * checking the changed files against the task's {@link FileScope}.
 */
export interface DiffScopeResult {
  /** Files touched between `baseSha` and HEAD (relative to repo root). */
  changedFiles: string[];
  /** Changed files that fall outside `fileScope.includes` or hit `excludes`. */
  violations: string[];
  /** The fileScope that was evaluated, for audit trails. */
  fileScope: FileScope;
  /**
   * v0.8.2.1 P2.1: total lines added + removed across all changed files
   * (i.e. `additions + deletions` from `git diff --shortstat`). Feeds
   * the small-task fast path's host guard so a single 500-line file
   * tagged `sizeHint="small"` cannot skip review based on file count
   * alone. Optional for backward-compatibility with diff results that
   * predate this addition; absence is treated as "unknown" and the
   * fast path falls back to the file-count guard only.
   */
  linesChanged?: number;
}
