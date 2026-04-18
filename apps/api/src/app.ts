import { Hono } from "hono";
import type { Client as TemporalClient } from "@temporalio/client";
import type { PmGoDb } from "@pm-go/db";
import {
  createSpecDocumentsRoute,
  type SpecDocumentsRouteDeps,
} from "./routes/spec-documents.js";
import { createPlansRoute } from "./routes/plans.js";

export interface AppDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
  artifactDir: string;
  /** Optional override for unit tests that want to stub the repo-intel call. */
  collectRepoSnapshot?: SpecDocumentsRouteDeps["collectRepoSnapshot"];
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route(
    "/spec-documents",
    createSpecDocumentsRoute({
      db: deps.db,
      ...(deps.collectRepoSnapshot !== undefined
        ? { collectRepoSnapshot: deps.collectRepoSnapshot }
        : {}),
    }),
  );
  app.route(
    "/plans",
    createPlansRoute({
      temporal: deps.temporal,
      taskQueue: deps.taskQueue,
      db: deps.db,
      artifactDir: deps.artifactDir,
    }),
  );
  return app;
}
