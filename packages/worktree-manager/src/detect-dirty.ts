import type { DirtyReport } from "./types.js";

export interface DetectDirtyInput {
  worktreePath: string;
}

export function detectDirty(_input: DetectDirtyInput): Promise<DirtyReport> {
  throw new Error("implementation lands in the Worktree Manager lane");
}
