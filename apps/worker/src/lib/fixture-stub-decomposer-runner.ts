import { readFileSync } from "node:fs";

import type { MilestoneManifest } from "@pm-go/contracts";
import {
  createStubDecomposerRunner,
  type DecomposerRunner,
  type DecomposerRunnerInput,
  type DecomposerRunnerResult,
} from "@pm-go/executor-claude";

/**
 * Stub decomposer runner backed by an on-disk `MilestoneManifest`
 * fixture. Substitutes the live `specDocumentId` / `repoSnapshotId`
 * from the incoming run input on every call so the manifest passes
 * `runDecomposer`'s cross-id assertion against the spec + snapshot the
 * caller actually persisted.
 *
 * Mirrors `createFixtureSubstitutingStubRunner` for the planner —
 * mutation is confined to a structural-clone, the on-disk fixture is
 * untouched, and `AgentRun` synthesis is delegated to the executor's
 * canonical stub so the contract stays in one place.
 */
export function createFixtureSubstitutingStubDecomposerRunner(
  fixturePath: string,
): DecomposerRunner {
  const raw = readFileSync(fixturePath, "utf8");
  const fixture: MilestoneManifest = JSON.parse(raw) as MilestoneManifest;

  return {
    async run(
      input: DecomposerRunnerInput,
    ): Promise<DecomposerRunnerResult> {
      const rebased: MilestoneManifest = {
        ...JSON.parse(JSON.stringify(fixture)),
        specDocumentId: input.specDocument.id,
        repoSnapshotId: input.repoSnapshot.id,
      };
      const inner = createStubDecomposerRunner(rebased);
      return inner.run(input);
    },
  };
}
