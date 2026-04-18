import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { validateSpecDocument } from "@pm-go/contracts";
import type { RepoSnapshot, SpecDocument } from "@pm-go/contracts";
import {
  repoSnapshots,
  specDocuments,
  type PmGoDb,
} from "@pm-go/db";
import {
  collectRepoSnapshot as defaultCollectRepoSnapshot,
  RepoIntelligenceError,
} from "@pm-go/repo-intelligence";

/**
 * Dependencies injected into the spec-documents route. The route used to
 * own a Temporal client; in Phase 2 starting the planner workflow moves to
 * `POST /plans`, so this route only needs the DB client and a
 * repo-intelligence collector (overridable for unit tests).
 */
export interface SpecDocumentsRouteDeps {
  db: PmGoDb;
  collectRepoSnapshot?: (input: {
    repoRoot: string;
  }) => Promise<RepoSnapshot>;
}

interface CreateSpecDocumentBody {
  title?: unknown;
  body?: unknown;
  repoRoot?: unknown;
  repoUrl?: unknown;
  source?: unknown;
}

export function createSpecDocumentsRoute(deps: SpecDocumentsRouteDeps) {
  const app = new Hono();
  const collect = deps.collectRepoSnapshot ?? defaultCollectRepoSnapshot;

  app.post("/", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as CreateSpecDocumentBody | null;
    if (!raw || typeof raw !== "object") {
      return c.json({ error: "missing JSON body" }, 400);
    }

    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const bodyText = typeof raw.body === "string" ? raw.body : "";
    const repoRoot = typeof raw.repoRoot === "string" ? raw.repoRoot.trim() : "";
    const source: "manual" | "imported" =
      raw.source === "imported" ? "imported" : "manual";

    if (!title) {
      return c.json({ error: "title is required" }, 400);
    }
    if (!bodyText) {
      return c.json({ error: "body is required" }, 400);
    }
    if (!repoRoot) {
      return c.json({ error: "repoRoot is required" }, 400);
    }

    const specDocument: SpecDocument = {
      id: randomUUID(),
      title,
      source,
      body: bodyText,
      createdAt: new Date().toISOString(),
    };
    if (!validateSpecDocument(specDocument)) {
      return c.json({ error: "invalid SpecDocument payload" }, 400);
    }

    let snapshot: RepoSnapshot;
    try {
      snapshot = await collect({ repoRoot });
    } catch (err) {
      if (err instanceof RepoIntelligenceError) {
        return c.json(
          { error: `repo-intelligence failed: ${err.message}`, code: err.code },
          400,
        );
      }
      throw err;
    }

    await deps.db.insert(specDocuments).values({
      id: specDocument.id,
      title: specDocument.title,
      source: specDocument.source,
      body: specDocument.body,
      createdAt: specDocument.createdAt,
    });

    await deps.db.insert(repoSnapshots).values({
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
    });

    return c.json(
      {
        specDocumentId: specDocument.id,
        repoSnapshotId: snapshot.id,
      },
      201,
    );
  });

  return app;
}
