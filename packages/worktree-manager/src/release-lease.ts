import type { UUID } from "@pm-go/contracts";

export interface ReleaseLeaseInput {
  leaseId: UUID;
}

export function releaseLease(_input: ReleaseLeaseInput): Promise<void> {
  throw new Error("implementation lands in the Worktree Manager lane");
}
