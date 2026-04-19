import type { FileScope } from "@pm-go/contracts";

import type { DiffScopeResult } from "./types.js";

export interface DiffScopeInput {
  worktreePath: string;
  baseSha: string;
  fileScope: FileScope;
}

export function diffScope(_input: DiffScopeInput): Promise<DiffScopeResult> {
  throw new Error("implementation lands in the Worktree Manager lane");
}
