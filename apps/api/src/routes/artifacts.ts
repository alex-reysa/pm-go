import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import type { UUID } from "@pm-go/contracts";
import { artifacts, type PmGoDb } from "@pm-go/db";

/**
 * Phase 6 artifact streaming endpoint.
 *
 * The artifact row carries a `file://` URI produced by
 * `renderAndPersistPrSummary` / `persistCompletionEvidenceBundle`.
 * This route loads the row, materializes the absolute path, runs a
 * `realpath`-based containment check against `PLAN_ARTIFACT_DIR`,
 * and streams bytes back with a kind-aware content-type.
 *
 * Why realpath and not just `startsWith`:
 *   - a file:// URI can point at a symlink the attacker controls
 *   - `path.resolve` + `startsWith` can be defeated by `/abs/path/..`
 *     style segments
 *   - `fs.realpath` resolves all symlinks and normalizes the path;
 *     only then is the containment check meaningful
 *
 * Failure modes:
 *   - 400 if the id isn't a UUID
 *   - 404 if no row, the URI is non-file, or the target doesn't exist
 *   - 403 if the resolved path escapes `PLAN_ARTIFACT_DIR`
 *   - 500 on any other filesystem error
 */

export interface ArtifactsRouteDeps {
  db: PmGoDb;
  artifactDir: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Decide a content-type from the artifact kind. Callers can
 * override via a `.md`/`.json` suffix in the stored URI when
 * kind-to-extension mapping ever drifts, but the current persistence
 * layer always emits the canonical pair.
 */
function contentTypeForKind(kind: string): string {
  switch (kind) {
    case "pr_summary":
    case "plan_markdown":
      return "text/markdown; charset=utf-8";
    case "completion_evidence_bundle":
    case "completion_audit_report":
    case "review_report":
    case "event_log":
    case "test_report":
      return "application/json; charset=utf-8";
    case "patch_bundle":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

/**
 * Resolve the configured `artifactDir` to a canonical absolute path
 * once per request. Realpath-resolving ensures the base directory
 * is anchor-normalized the same way as the artifact path — `startsWith`
 * checks depend on both operands being normalized.
 */
async function canonicalArtifactDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  try {
    return await realpath(abs);
  } catch {
    // If the configured dir doesn't exist yet (e.g. the worker never
    // ran and no artifacts have been written), fall back to the
    // resolved absolute path. No file can be INSIDE a non-existent
    // directory, so any containment check below will still fail
    // correctly — this just avoids the realpath ENOENT throw.
    return abs;
  }
}

export function createArtifactsRoute(deps: ArtifactsRouteDeps) {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    const [row] = await deps.db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        uri: artifacts.uri,
      })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    if (!row) {
      return c.json({ error: `artifact ${id} not found` }, 404);
    }

    // Only file:// URIs are streamable today; anything else means
    // the persistence layer wrote a pointer (future HTTP/GCS uris)
    // that a browser should fetch directly.
    let absPath: string;
    try {
      const url = new URL(row.uri);
      if (url.protocol !== "file:") {
        return c.json(
          {
            error: `artifact ${id} has non-file URI (${url.protocol}); streaming is only supported for file://`,
            uri: row.uri,
          },
          404,
        );
      }
      absPath = fileURLToPath(url);
    } catch {
      return c.json(
        { error: `artifact ${id} has an unparseable URI: ${row.uri}` },
        404,
      );
    }

    // Realpath both operands, then assert the artifact lives under
    // the configured dir. Anything outside — symlink escape, URI
    // pointing at /etc/passwd, stray test fixture — is 403.
    const canonicalDir = await canonicalArtifactDir(deps.artifactDir);
    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(absPath);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        return c.json(
          { error: `artifact ${id} file not found on disk` },
          404,
        );
      }
      return c.json(
        {
          error: `artifact ${id} resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }

    // Containment: resolved target must equal the dir OR live under
    // it (with a trailing separator to avoid `/foo/bardir` passing
    // when the configured dir is `/foo/bar`).
    const dirWithSep = canonicalDir.endsWith(path.sep)
      ? canonicalDir
      : canonicalDir + path.sep;
    if (
      resolvedTarget !== canonicalDir &&
      !resolvedTarget.startsWith(dirWithSep)
    ) {
      return c.json(
        {
          error: `artifact ${id} resolves outside the configured artifact directory`,
          resolvedTarget,
          artifactDir: canonicalDir,
        },
        403,
      );
    }

    // Stat for size + reject non-file targets (a directory symlink
    // that resolved inside the dir is still not something we want
    // to stream).
    const info = await stat(resolvedTarget);
    if (!info.isFile()) {
      return c.json(
        { error: `artifact ${id} resolves to a non-file target` },
        403,
      );
    }

    const stream = createReadStream(resolvedTarget);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": contentTypeForKind(row.kind),
        "content-length": String(info.size),
        "cache-control": "private, max-age=60",
      },
    });
  });

  return app;
}
