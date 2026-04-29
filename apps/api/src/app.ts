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
import { createApprovalsRoute } from "./routes/approvals.js";
import { createBudgetReportsRoute } from "./routes/budget-reports.js";
import { apiVersion } from "./lib/version.js";

export interface AppDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
  artifactDir: string;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
  /**
   * Logical instance label surfaced by `GET /health` (e.g. `"default"`
   * for the single-tenant deployment). Stable per-process; the route
   * captures it by closure.
   *
   * Optional — together with {@link getBoundPort} it gates the
   * identity body. When BOTH are supplied, `/health` returns the full
   * `{ status, service, version, instance, port }` shape. When either
   * is omitted, `/health` collapses to the legacy `{ status: "ok" }`
   * shape so older `createApp({...})` call sites (e.g. pre-existing
   * tests) keep working without breakage.
   */
  instanceName?: string;
  /**
   * Getter for the live bound port surfaced by `GET /health`. Modeled
   * as a getter rather than a `number` because the route closure is
   * registered before `serve(...)` resolves the bind: `index.ts`
   * stores the live port in a holder inside the `serve(...)` callback,
   * and the route reads it through this getter at request time.
   *
   * Optional — see {@link instanceName} for the gating rule. When
   * either field is missing, `/health` returns `{ status: "ok" }`
   * (legacy shape) and this getter is never invoked, so legacy
   * callers cannot trip a `undefined()` 500.
   */
  getBoundPort?: () => number;
  /** Optional override for unit tests that want to stub the repo-intel call. */
  collectRepoSnapshot?: SpecDocumentsRouteDeps["collectRepoSnapshot"];
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  // `/health` returns the identity body when the caller wires the
  // identity deps (`instanceName` + `getBoundPort`). When the caller
  // doesn't — e.g. older `createApp({...})` call sites in
  // `apps/api/test/*.ts` that pre-date this route — the response
  // collapses to the legacy `{ status: "ok" }` shape, so those callers
  // remain non-throwing and their existing assertions keep passing.
  // `status: "ok"` is preserved verbatim across both modes (ac-health-
  // identity-1 / bb2, asserted in `test/health.test.ts`).
  const identityWired =
    deps.instanceName !== undefined && deps.getBoundPort !== undefined;
  app.get("/health", (c) => {
    if (!identityWired) {
      return c.json({ status: "ok" });
    }
    return c.json({
      status: "ok",
      service: "pm-go-api",
      version: apiVersion,
      // Non-null assertions are safe here: `identityWired` proves both
      // are defined, and `getBoundPort` is the getter pattern (called
      // per request so the live `serve(...)` port is observed).
      instance: deps.instanceName!,
      port: deps.getBoundPort!(),
    });
  });
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
  // Phase 7 — additive routes for the approval ledger + budget snapshots.
  // Mounted under `/approvals` and `/plans` (the latter shares the
  // existing prefix; the budget-report sub-route is `/plans/:id/budget-report`).
  app.route("/approvals", createApprovalsRoute({ db: deps.db }));
  app.route("/plans", createBudgetReportsRoute({ db: deps.db }));
  return app;
}
