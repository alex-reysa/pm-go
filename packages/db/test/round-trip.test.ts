import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";

// Import validators from the contracts source directly rather than via the
// `@pm-go/contracts` package entry, which points at `dist/index.js` that
// isn't produced by `pnpm test` alone. Types still come from the package.
import { validateSpecDocument } from "../../contracts/src/validators/core/spec-document.js";
import { validateRepoSnapshot } from "../../contracts/src/validators/core/repo-snapshot.js";
import type { SpecDocument, RepoSnapshot } from "@pm-go/contracts";
import {
  createDb,
  closeDb,
  specDocuments,
  repoSnapshots,
  type PmGoDb,
} from "../src/index.js";

// Fixtures live in the contracts package; the top-level index.ts does not
// re-export subpath helpers, so resolve JSON files directly from disk.
const specDocumentFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/core/spec-document.json",
    import.meta.url,
  ),
);
const repoSnapshotFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/core/repo-snapshot.json",
    import.meta.url,
  ),
);

const databaseUrl = process.env["DATABASE_URL_TEST"];

// Skip the entire integration suite cleanly when no test DB is configured.
describe.skipIf(!databaseUrl)("@pm-go/db round-trip", () => {
  it("persists and re-reads a SpecDocument and RepoSnapshot fixture", async () => {
    const db: PmGoDb = createDb(databaseUrl as string);
    try {
      // Fresh tables per run; tests own their schema lifecycle.
      await db.execute(sql`DROP TABLE IF EXISTS "spec_documents" CASCADE`);
      await db.execute(sql`DROP TABLE IF EXISTS "repo_snapshots" CASCADE`);

      await db.execute(sql`
        CREATE TABLE "spec_documents" (
          "id" uuid PRIMARY KEY NOT NULL,
          "title" text NOT NULL,
          "source" text NOT NULL,
          "body" text NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        )
      `);
      await db.execute(sql`
        CREATE TABLE "repo_snapshots" (
          "id" uuid PRIMARY KEY NOT NULL,
          "repo_root" text NOT NULL,
          "repo_url" text,
          "default_branch" text NOT NULL,
          "head_sha" text NOT NULL,
          "language_hints" text[] NOT NULL,
          "framework_hints" text[] NOT NULL,
          "build_commands" text[] NOT NULL,
          "test_commands" text[] NOT NULL,
          "ci_config_paths" text[] NOT NULL,
          "captured_at" timestamp with time zone DEFAULT now() NOT NULL
        )
      `);

      const specFixture = JSON.parse(
        readFileSync(specDocumentFixturePath, "utf8"),
      ) as SpecDocument;
      const repoFixture = JSON.parse(
        readFileSync(repoSnapshotFixturePath, "utf8"),
      ) as RepoSnapshot;

      await db.insert(specDocuments).values({
        id: specFixture.id,
        title: specFixture.title,
        source: specFixture.source,
        body: specFixture.body,
        createdAt: specFixture.createdAt,
      });

      await db.insert(repoSnapshots).values({
        id: repoFixture.id,
        repoRoot: repoFixture.repoRoot,
        repoUrl: repoFixture.repoUrl ?? null,
        defaultBranch: repoFixture.defaultBranch,
        headSha: repoFixture.headSha,
        languageHints: repoFixture.languageHints,
        frameworkHints: repoFixture.frameworkHints,
        buildCommands: repoFixture.buildCommands,
        testCommands: repoFixture.testCommands,
        ciConfigPaths: repoFixture.ciConfigPaths,
        capturedAt: repoFixture.capturedAt,
      });

      const specRows = await db.select().from(specDocuments);
      const repoRows = await db.select().from(repoSnapshots);

      expect(specRows).toHaveLength(1);
      expect(repoRows).toHaveLength(1);

      const specRow = specRows[0]!;
      const repoRow = repoRows[0]!;

      const specCandidate: SpecDocument = {
        id: specRow.id,
        title: specRow.title,
        source: specRow.source,
        body: specRow.body,
        createdAt: specRow.createdAt,
      };
      expect(validateSpecDocument(specCandidate)).toBe(true);

      const repoCandidate: RepoSnapshot = {
        id: repoRow.id,
        repoRoot: repoRow.repoRoot,
        ...(repoRow.repoUrl !== null ? { repoUrl: repoRow.repoUrl } : {}),
        defaultBranch: repoRow.defaultBranch,
        headSha: repoRow.headSha,
        languageHints: repoRow.languageHints,
        frameworkHints: repoRow.frameworkHints,
        buildCommands: repoRow.buildCommands,
        testCommands: repoRow.testCommands,
        ciConfigPaths: repoRow.ciConfigPaths,
        capturedAt: repoRow.capturedAt,
      };
      expect(validateRepoSnapshot(repoCandidate)).toBe(true);
    } finally {
      await db
        .execute(sql`DROP TABLE IF EXISTS "spec_documents" CASCADE`)
        .catch(() => undefined);
      await db
        .execute(sql`DROP TABLE IF EXISTS "repo_snapshots" CASCADE`)
        .catch(() => undefined);
      await closeDb(db);
    }
  });
});
