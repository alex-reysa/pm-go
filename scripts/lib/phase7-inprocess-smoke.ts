/**
 * Phase 7 matrix harness — in-process smoke driver.
 *
 * Drives the stub planner, implementer, and reviewer end-to-end against a
 * prepared fixture repo. Deliberately does NOT touch Postgres, Temporal,
 * or the real apps/worker & apps/api processes: the point is to verify
 * that the four sample-repo *shapes* survive the phase5-ish happy path
 * when executed by stubs. The full-stack assertion is Worker 4's
 * `phase7-smoke.sh`.
 *
 * Invoked via scripts/lib/phase7-harness.sh → phase7_run_inprocess_smoke.
 * Required env:
 *   PHASE7_FIXTURE_NAME - the fixture identifier (for log clarity)
 *   PHASE7_FIXTURE_REPO - absolute path to the prepared fixture worktree
 *
 * Relative imports: this file lives in scripts/lib/, outside the
 * pnpm-workspace package graph, so it cannot resolve "@pm-go/*" as a
 * bare specifier. Using src-relative imports keeps tsx happy and avoids
 * spinning up a throwaway package just for the harness.
 */
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { Plan, Task } from "../../packages/contracts/src/index.js";
import {
  createStubImplementerRunner,
  createStubPlannerRunner,
  createStubReviewerRunner,
} from "../../packages/executor-claude/src/index.js";

const execFile = promisify(execFileCb);

const FIXTURE_NAME = process.env.PHASE7_FIXTURE_NAME ?? "unknown";
const FIXTURE_REPO = process.env.PHASE7_FIXTURE_REPO;
if (!FIXTURE_REPO) {
  console.error("[phase7-matrix] PHASE7_FIXTURE_REPO not set");
  process.exit(2);
}

// Minimal plan synthesised per-fixture. We use the same UUIDs as the
// orchestration-review fixture because stub contracts are UUID-validated
// and the shape is already well-known across the codebase.
const PLAN_ID = "c1a2b3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const PHASE_ID = "11111111-2222-4333-8444-555555555555";
const TASK_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function buildFixturePlan(): Plan {
  const task: Task = {
    id: TASK_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    slug: `phase7-matrix-${FIXTURE_NAME}`,
    title: `Matrix smoke task (${FIXTURE_NAME})`,
    summary: `Stub implementer writes a marker file inside the ${FIXTURE_NAME} fixture repo.`,
    kind: "foundation",
    status: "pending",
    riskLevel: "low",
    fileScope: { includes: [`phase7-matrix/${FIXTURE_NAME}.txt`] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 10 },
    reviewerPolicy: {
      required: false,
      strictness: "standard",
      maxCycles: 1,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 1,
  };

  return {
    id: PLAN_ID,
    specDocumentId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    repoSnapshotId: "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00",
    title: `Phase 7 matrix fixture: ${FIXTURE_NAME}`,
    summary:
      "Synthesised by scripts/lib/phase7-inprocess-smoke.ts. Single-phase single-task plan used purely to exercise the stub runner chain against the fixture.",
    status: "approved",
    phases: [
      {
        id: PHASE_ID,
        planId: PLAN_ID,
        index: 0,
        title: "Matrix phase",
        summary: "One task, stub pass-through.",
        status: "executing",
        integrationBranch: `integration/phase7-matrix/${FIXTURE_NAME}`,
        baseSnapshotId: "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00",
        taskIds: [TASK_ID],
        dependencyEdges: [],
        mergeOrder: [TASK_ID],
      },
    ],
    tasks: [task],
  };
}

async function main(): Promise<void> {
  const plan = buildFixturePlan();

  // -- Planner stub --------------------------------------------------------
  const plannerRunner = createStubPlannerRunner(plan);
  const plannerResult = await plannerRunner.run({
    specDocument: {
      id: plan.specDocumentId,
      title: "fixture spec",
      source: "manual",
      body: "stub body",
      createdAt: new Date().toISOString(),
    },
    repoSnapshot: {
      id: plan.repoSnapshotId,
      repoRoot: FIXTURE_REPO!,
      defaultBranch: "main",
      headSha: "0000000000000000000000000000000000000000",
      languageHints: ["typescript"],
      frameworkHints: [],
      buildCommands: [],
      testCommands: [],
      ciConfigPaths: [],
      capturedAt: new Date().toISOString(),
    },
    systemPrompt: "sp",
    promptVersion: "phase7-matrix-1",
    model: "claude-sonnet-4-6",
    cwd: FIXTURE_REPO!,
  });
  if (plannerResult.plan.id !== PLAN_ID) {
    throw new Error(
      `planner stub returned unexpected plan id: ${plannerResult.plan.id}`,
    );
  }

  // -- Implementer stub ----------------------------------------------------
  // Write a marker file inside the fixture repo so we know the full round
  // trip (worktree containment + commit + HEAD capture) ran.
  const implementerRunner = createStubImplementerRunner({
    writeFile: {
      relativePath: `phase7-matrix/${FIXTURE_NAME}.txt`,
      contents: `phase7 matrix smoke marker for fixture=${FIXTURE_NAME}\n`,
    },
  });
  const task = plan.tasks[0]!;
  const implResult = await implementerRunner.run({
    task,
    worktreePath: FIXTURE_REPO!,
    baseSha: "0000000000000000000000000000000000000000",
    systemPrompt: "sp",
    promptVersion: "phase7-matrix-1",
    model: "claude-sonnet-4-6",
  });
  if (!implResult.finalCommitSha) {
    throw new Error("implementer stub did not produce a finalCommitSha");
  }

  // Confirm the commit is actually on HEAD.
  const { stdout: headSha } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: FIXTURE_REPO!,
  });
  if (headSha.trim() !== implResult.finalCommitSha) {
    throw new Error(
      `HEAD (${headSha.trim()}) does not match implementer finalCommitSha (${implResult.finalCommitSha})`,
    );
  }

  // -- Reviewer stub -------------------------------------------------------
  const reviewerRunner = createStubReviewerRunner({ sequence: ["pass"] });
  const reviewResult = await reviewerRunner.run({
    task,
    worktreePath: FIXTURE_REPO!,
    baseSha: "0000000000000000000000000000000000000000",
    headSha: implResult.finalCommitSha,
    strictness: "standard",
    systemPrompt: "sp",
    promptVersion: "phase7-matrix-1",
    model: "claude-sonnet-4-6",
    cycleNumber: 1,
    workflowRunId: `phase7-matrix-${randomUUID()}`,
  });
  if (reviewResult.report.outcome !== "pass") {
    throw new Error(
      `reviewer stub returned non-pass outcome: ${reviewResult.report.outcome}`,
    );
  }

  console.log(
    `[phase7-matrix] ${FIXTURE_NAME}: plan=${plannerResult.plan.id} commit=${implResult.finalCommitSha.slice(0, 10)} review=pass`,
  );
}

main().catch((err: unknown) => {
  console.error(`[phase7-matrix] FAILED fixture=${FIXTURE_NAME}`);
  console.error(err);
  process.exit(1);
});
