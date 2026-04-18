import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { createDb } from "@pm-go/db";
import {
  createClaudePlannerRunner,
  type PlannerRunner,
} from "@pm-go/executor-claude";

import { createPlannerActivities } from "./activities/planner.js";
import { createPlanPersistenceActivities } from "./activities/plan-persistence.js";
import { createRepoIntelligenceActivities } from "./activities/repo-intelligence.js";
import { createSpecIntakeActivities } from "./activities/spec-intake.js";
import { createFixtureSubstitutingStubRunner } from "./lib/fixture-stub-runner.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "pm-go-worker";
  const plannerMode = process.env.PLANNER_EXECUTOR_MODE ?? "stub";
  // Resolve to absolute eagerly so the markdown artifact lands at a
  // predictable location regardless of where the worker is invoked from
  // (pnpm --filter runs the child process in apps/worker/, so a relative
  // "./artifacts/plans" would resolve there, not at repo root).
  const artifactDir = path.resolve(
    process.env.PLAN_ARTIFACT_DIR ?? "./artifacts/plans",
  );

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);

  const plannerRunner: PlannerRunner =
    plannerMode === "live"
      ? createClaudePlannerRunner()
      : createFixtureSubstitutingStubRunner(resolveFixturePath());

  const connection = await NativeConnection.connect({ address: temporalAddress });

  const planPersistence = createPlanPersistenceActivities({ db });
  const repoIntel = createRepoIntelligenceActivities({ db });
  const specIntake = createSpecIntakeActivities({ db });
  const planner = createPlannerActivities({
    db,
    plannerRunner,
    artifactDir,
  });

  // Named-property merge — each factory exposes a disjoint set of names so
  // the spread is side-effect-free and collision-free. If a collision ever
  // lands (e.g. two factories both export `auditPlanActivity`) Temporal's
  // duplicate-activity check at Worker.create time will fail loudly; the
  // comment here tracks that invariant.
  const activities = {
    ...specIntake,
    ...repoIntel,
    ...planPersistence,
    ...planner,
  };

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
    activities,
  });

  process.on("SIGINT", () => worker.shutdown());
  process.on("SIGTERM", () => worker.shutdown());

  console.log(`worker starting (planner mode=${plannerMode})`);
  await worker.run();
}

function resolveFixturePath(): string {
  // `import.meta.url` resolves to the compiled `dist/index.js` in prod and
  // to `src/index.ts` when run under tsx. Both live at apps/worker/{dist|src}
  // so the fixture lives 4 levels up from the compiled file:
  //   apps/worker/dist/index.js  ->  ../../../packages/contracts/...
  //   apps/worker/src/index.ts   ->  ../../../packages/contracts/...
  return fileURLToPath(
    new URL(
      "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
      import.meta.url,
    ),
  );
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
