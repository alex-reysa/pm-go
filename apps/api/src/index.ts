import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { createDb } from "@pm-go/db";
import { createApp } from "./app.js";
import { createTemporalClient } from "./lib/temporal.js";

async function main() {
  const port = Number(process.env.API_PORT ?? "3001");
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "pm-go-worker";
  const databaseUrl = process.env.DATABASE_URL;
  const artifactDir = process.env.PLAN_ARTIFACT_DIR ?? "./artifacts/plans";

  // Derive repo root from `import.meta.url` (three levels up from the
  // compiled/tsx-run `index.js|ts`) so the API does not have to be
  // launched from the repo root. Env overrides still win.
  const defaultRepoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const repoRoot = process.env.REPO_ROOT ?? defaultRepoRoot;
  const worktreeRoot =
    process.env.WORKTREE_ROOT ?? path.resolve(repoRoot, ".worktrees");
  const maxLifetimeHours = Number(
    process.env.MAX_WORKTREE_LIFETIME_HOURS ?? 24,
  );
  const instanceName = process.env.API_INSTANCE_NAME ?? "default";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);
  const temporal = await createTemporalClient({
    address: temporalAddress,
    namespace,
  });

  // The `/health` route reports the *live* bound port — the value
  // `serve(...)` reports back, not a re-read of `process.env.API_PORT`.
  // The route closure runs after registration but before `serve`
  // resolves the bind, so we hand `createApp` a getter that closes
  // over a mutable holder. The `serve(...)` callback fills the holder
  // once binding completes; until then the getter returns 0.
  let boundPort = 0;

  const app = createApp({
    temporal,
    taskQueue,
    db,
    artifactDir,
    repoRoot,
    worktreeRoot,
    maxLifetimeHours,
    instanceName,
    getBoundPort: () => boundPort,
  });

  serve({ fetch: app.fetch, port }, (info) => {
    boundPort = info.port;
    console.log(`api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("api failed:", err);
  process.exit(1);
});
