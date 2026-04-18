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

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);
  const temporal = await createTemporalClient({
    address: temporalAddress,
    namespace,
  });

  const app = createApp({
    temporal,
    taskQueue,
    db,
    artifactDir,
  });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("api failed:", err);
  process.exit(1);
});
