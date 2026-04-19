import type { Task, WorktreeLease } from "@pm-go/contracts";

/**
 * Input required to provision a new worktree lease for a task. The real
 * implementation lands in the Worktree Manager lane; this foundation
 * file only pins the signature so other lanes can wire call sites
 * against it.
 */
export interface CreateLeaseInput {
  task: Task;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
}

export function createLease(_input: CreateLeaseInput): Promise<WorktreeLease> {
  throw new Error("implementation lands in the Worktree Manager lane");
}
