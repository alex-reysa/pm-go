import { describe, expect, it, vi } from "vitest";

import type { RepoSnapshot } from "@pm-go/contracts";
import { createRepoIntelligenceActivities } from "../src/activities/repo-intelligence.js";

const snapshot: RepoSnapshot = {
  id: "11111111-2222-4333-8444-555555555555",
  repoRoot: "/tmp/fake-repo",
  repoUrl: "https://github.com/example/fake",
  defaultBranch: "main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  languageHints: ["TypeScript"],
  frameworkHints: ["Hono"],
  buildCommands: ["pnpm build"],
  testCommands: ["pnpm test"],
  ciConfigPaths: [".github/workflows/ci.yml"],
  capturedAt: "2025-01-01T00:00:00.000Z",
};

describe("persistRepoSnapshot", () => {
  it("inserts a repo snapshot and returns its id", async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: snapshot.id }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { insert } as any;

    const activities = createRepoIntelligenceActivities({ db });
    const id = await activities.persistRepoSnapshot(snapshot);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: snapshot.id,
        repoRoot: snapshot.repoRoot,
        repoUrl: snapshot.repoUrl,
        defaultBranch: snapshot.defaultBranch,
        headSha: snapshot.headSha,
        languageHints: snapshot.languageHints,
        frameworkHints: snapshot.frameworkHints,
        buildCommands: snapshot.buildCommands,
        testCommands: snapshot.testCommands,
        ciConfigPaths: snapshot.ciConfigPaths,
        capturedAt: snapshot.capturedAt,
      }),
    );
    expect(returning).toHaveBeenCalledTimes(1);
    expect(id).toBe(snapshot.id);
  });

  it("passes null for an absent repoUrl", async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: snapshot.id }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { insert } as any;

    const { repoUrl: _omit, ...withoutUrl } = snapshot;
    void _omit;
    const activities = createRepoIntelligenceActivities({ db });
    await activities.persistRepoSnapshot(withoutUrl as RepoSnapshot);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: null }),
    );
  });

  it("throws when insert returns no row", async () => {
    const returning = vi.fn().mockResolvedValueOnce([]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { insert } as any;

    const activities = createRepoIntelligenceActivities({ db });
    await expect(
      activities.persistRepoSnapshot(snapshot),
    ).rejects.toThrow(/persistRepoSnapshot: insert returned no row/);
  });
});
