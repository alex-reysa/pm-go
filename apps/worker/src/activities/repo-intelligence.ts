import type { RepoSnapshot } from "@pm-go/contracts";
import { repoSnapshots, type PmGoDb } from "@pm-go/db";
import { collectRepoSnapshot as doCollect } from "@pm-go/repo-intelligence";

export interface RepoIntelligenceDeps {
  db: PmGoDb;
}

export function createRepoIntelligenceActivities(deps: RepoIntelligenceDeps) {
  return {
    async collectRepoSnapshot(input: {
      repoRoot: string;
    }): Promise<RepoSnapshot> {
      return doCollect({ repoRoot: input.repoRoot });
    },
    async persistRepoSnapshot(snapshot: RepoSnapshot): Promise<string> {
      const [row] = await deps.db
        .insert(repoSnapshots)
        .values({
          id: snapshot.id,
          repoRoot: snapshot.repoRoot,
          repoUrl: snapshot.repoUrl ?? null,
          defaultBranch: snapshot.defaultBranch,
          headSha: snapshot.headSha,
          languageHints: snapshot.languageHints,
          frameworkHints: snapshot.frameworkHints,
          buildCommands: snapshot.buildCommands,
          testCommands: snapshot.testCommands,
          ciConfigPaths: snapshot.ciConfigPaths,
          capturedAt: snapshot.capturedAt,
        })
        .returning({ id: repoSnapshots.id });
      if (!row) {
        throw new Error("persistRepoSnapshot: insert returned no row");
      }
      return row.id;
    },
  };
}
