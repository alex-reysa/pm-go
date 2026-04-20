import { Hono } from "hono";
import type { Client as TemporalClient } from "@temporalio/client";
import type { PmGoDb } from "@pm-go/db";
import {
  createSpecDocumentsRoute,
  type SpecDocumentsRouteDeps,
} from "./routes/spec-documents.js";
import {
  createCompletionAuditReportsRoute,
  createPlansRoute,
} from "./routes/plans.js";
import { createAgentRunsRoute } from "./routes/agent-runs.js";
import { createArtifactsRoute } from "./routes/artifacts.js";
import { createEventsRoute } from "./routes/events.js";
import {
  createMergeRunsRoute,
  createPhaseAuditReportsRoute,
  createPhasesRoute,
} from "./routes/phases.js";
import { createTasksRoute } from "./routes/tasks.js";

export interface AppDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
  artifactDir: string;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
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
  app.route(
    "/tasks",
    createTasksRoute({
      temporal: deps.temporal,
      taskQueue: deps.taskQueue,
      db: deps.db,
      repoRoot: deps.repoRoot,
      worktreeRoot: deps.worktreeRoot,
      maxLifetimeHours: deps.maxLifetimeHours,
    }),
  );
  app.route(
    "/phases",
    createPhasesRoute({
      temporal: deps.temporal,
      taskQueue: deps.taskQueue,
      db: deps.db,
    }),
  );
  app.route("/merge-runs", createMergeRunsRoute({ db: deps.db }));
  app.route(
    "/phase-audit-reports",
    createPhaseAuditReportsRoute({ db: deps.db }),
  );
  app.route(
    "/completion-audit-reports",
    createCompletionAuditReportsRoute({ db: deps.db }),
  );
  app.route("/events", createEventsRoute({ db: deps.db }));
  app.route("/agent-runs", createAgentRunsRoute({ db: deps.db }));
  app.route(
    "/artifacts",
    createArtifactsRoute({ db: deps.db, artifactDir: deps.artifactDir }),
  );
  return app;
}
