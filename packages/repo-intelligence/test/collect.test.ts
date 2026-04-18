import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectRepoSnapshot } from "../src/collect.js";
import { RepoIntelligenceError } from "../src/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

describe("collectRepoSnapshot", () => {
  it("returns a RepoSnapshot for the pm-go repo with expected hints", async () => {
    const snapshot = await collectRepoSnapshot({ repoRoot });

    // 1. Resolves to an object with the required fields.
    expect(snapshot).toBeDefined();
    expect(typeof snapshot.id).toBe("string");
    expect(snapshot.repoRoot).toBe(repoRoot);

    // 2. languageHints includes TypeScript.
    expect(snapshot.languageHints).toContain("TypeScript");

    // 3. frameworkHints includes Hono and Drizzle.
    expect(snapshot.frameworkHints).toContain("Hono");
    expect(snapshot.frameworkHints).toContain("Drizzle");

    // 4. buildCommands starts with a pnpm-prefixed command.
    expect(snapshot.buildCommands.length).toBeGreaterThan(0);
    expect(snapshot.buildCommands[0]).toMatch(/^pnpm\s/);

    // 5. testCommands starts with a pnpm-prefixed command.
    expect(snapshot.testCommands.length).toBeGreaterThan(0);
    expect(snapshot.testCommands[0]).toMatch(/^pnpm\s/);

    // 6. headSha is a 40-char lowercase hex string.
    expect(snapshot.headSha).toMatch(/^[0-9a-f]{40}$/);

    // 7. defaultBranch is truthy.
    expect(snapshot.defaultBranch).toBeTruthy();

    // 8. capturedAt parses as a valid Date.
    const capturedDate = new Date(snapshot.capturedAt);
    expect(Number.isNaN(capturedDate.getTime())).toBe(false);

    // 9. id is a UUID (36 chars, 4 dashes) when not provided.
    expect(snapshot.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("echoes the provided id verbatim", async () => {
    const fixedId = "11111111-2222-4333-8444-555555555555";
    const snapshot = await collectRepoSnapshot({ repoRoot, id: fixedId });
    expect(snapshot.id).toBe(fixedId);
  });

  it("throws RepoIntelligenceError with code 'not-a-directory' for missing paths", async () => {
    const missing = join(repoRoot, "definitely-does-not-exist-xyzzy");
    await expect(collectRepoSnapshot({ repoRoot: missing })).rejects.toThrow(
      RepoIntelligenceError,
    );
    try {
      await collectRepoSnapshot({ repoRoot: missing });
    } catch (err) {
      expect(err).toBeInstanceOf(RepoIntelligenceError);
      expect((err as RepoIntelligenceError).code).toBe("not-a-directory");
    }
  });

  describe("against a non-git directory", () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "pm-go-repo-intel-"));
    });

    afterAll(async () => {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    });

    it("throws RepoIntelligenceError with code 'not-a-git-repo'", async () => {
      await expect(
        collectRepoSnapshot({ repoRoot: tmpDir }),
      ).rejects.toThrow(RepoIntelligenceError);
      try {
        await collectRepoSnapshot({ repoRoot: tmpDir });
      } catch (err) {
        expect(err).toBeInstanceOf(RepoIntelligenceError);
        expect((err as RepoIntelligenceError).code).toBe("not-a-git-repo");
      }
    });
  });
});
