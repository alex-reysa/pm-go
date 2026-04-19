import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { createDb } from "@pm-go/db";
import {
  createClaudeImplementerRunner,
  createClaudePlannerRunner,
  createStubImplementerRunner,
  type ImplementerRunner,
  type PlannerRunner,
} from "@pm-go/executor-claude";

import { createPlannerActivities } from "./activities/planner.js";
import { createPlanPersistenceActivities } from "./activities/plan-persistence.js";
import { createRepoIntelligenceActivities } from "./activities/repo-intelligence.js";
import { createSpecIntakeActivities } from "./activities/spec-intake.js";
import { createTaskExecutionActivities } from "./activities/task-execution.js";
import { createWorktreeActivities } from "./activities/worktree.js";
import { createFixtureSubstitutingStubRunner } from "./lib/fixture-stub-runner.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "pm-go-worker";
  const plannerMode = process.env.PLANNER_EXECUTOR_MODE ?? "stub";
  const implementerMode = process.env.IMPLEMENTER_EXECUTOR_MODE ?? "stub";
  // Resolve PLAN_ARTIFACT_DIR relative to the repo root, not the worker's
  // cwd. `pnpm --filter @pm-go/worker start` spawns the child with
  // cwd=apps/worker/, so a relative "./artifacts/plans" would otherwise
  // land under apps/worker/ rather than the user's expected location.
  const artifactDir = resolveArtifactDir(
    process.env.PLAN_ARTIFACT_DIR ?? "./artifacts/plans",
  );
  const repoRoot = resolveFromRepoRoot(
    process.env.REPO_ROOT ?? ".",
  );
  const worktreeRoot = resolveFromRepoRoot(
    process.env.WORKTREE_ROOT ?? ".worktrees",
  );

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);

  const plannerRunner: PlannerRunner =
    plannerMode === "live"
      ? createClaudePlannerRunner()
      : createFixtureSubstitutingStubRunner(resolveFixturePath());

  const implementerRunner: ImplementerRunner =
    implementerMode === "live"
      ? createClaudeImplementerRunner()
      : createStubImplementerRunner({
          writeFile: {
            relativePath: "NOTES.md",
            contents: "stub implementer output\n",
          },
        });

  const connection = await NativeConnection.connect({ address: temporalAddress });

  const planPersistence = createPlanPersistenceActivities({ db });
  const repoIntel = createRepoIntelligenceActivities({ db });
  const specIntake = createSpecIntakeActivities({ db });
  const planner = createPlannerActivities({
    db,
    plannerRunner,
    artifactDir,
  });
  const worktree = createWorktreeActivities({ db });
  const taskExecution = createTaskExecutionActivities({
    db,
    implementerRunner,
    repoRoot,
    worktreeRoot,
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
    ...worktree,
    ...taskExecution,
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

  console.log(
    `worker starting (planner=${plannerMode} implementer=${implementerMode})`,
  );
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

/**
 * Resolve a user-provided artifact directory path. Absolute paths are
 * used verbatim; relative paths resolve against the repo root (two
 * levels above the worker package), not the worker process cwd.
 */
function resolveArtifactDir(input: string): string {
  if (path.isAbsolute(input)) return input;
  return resolveFromRepoRoot(input);
}

/**
 * Resolve any user-provided path against the repo root. The repo root
 * is computed from `import.meta.url` so it is stable whether the worker
 * runs under `tsx` (src/) or compiled (dist/).
 */
function resolveFromRepoRoot(input: string): string {
  if (path.isAbsolute(input)) return input;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return path.resolve(repoRoot, input);
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
