import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { createDb } from "@pm-go/db";
import type {
  AgentRun,
  CompletionAuditOutcome,
  PhaseAuditOutcome,
  ReviewOutcome,
} from "@pm-go/contracts";
import {
  createClaudeCompletionAuditorRunner,
  createClaudeImplementerRunner,
  createClaudePhaseAuditorRunner,
  createClaudePlannerRunner,
  createClaudeReviewerRunner,
  createStubCompletionAuditorRunner,
  createStubImplementerRunner,
  createStubPhaseAuditorRunner,
  createStubReviewerRunner,
  type CompletionAuditorRunner,
  type ImplementerRunner,
  type PhaseAuditorRunner,
  type PlannerRunner,
  type ReviewerRunner,
  type StubCompletionAuditorSequenceEntry,
  type StubPhaseAuditorSequenceEntry,
  type StubReviewerSequenceEntry,
} from "@pm-go/executor-claude";

import { createCompletionAuditActivities } from "./activities/completion-audit.js";
import { createEventActivities } from "./activities/events.js";
import { createIntegrationActivities } from "./activities/integration.js";
import { createPhaseAuditActivities } from "./activities/phase-audit.js";
import { createPlannerActivities } from "./activities/planner.js";
import { createPlanPersistenceActivities } from "./activities/plan-persistence.js";
import { createPolicyActivities } from "./activities/policy.js";
import { createRepoIntelligenceActivities } from "./activities/repo-intelligence.js";
import { createReviewActivities } from "./activities/reviewer.js";
import { createReviewPersistenceActivities } from "./activities/review-persistence.js";
import { createSpanActivities } from "./activities/spans.js";
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
  const reviewerMode = process.env.REVIEWER_EXECUTOR_MODE ?? "stub";
  const phaseAuditorMode = process.env.PHASE_AUDITOR_EXECUTOR_MODE ?? "stub";
  const completionAuditorMode =
    process.env.COMPLETION_AUDITOR_EXECUTOR_MODE ?? "stub";
  const maxLifetimeHours = Number.parseInt(
    process.env.WORKTREE_MAX_LIFETIME_HOURS ?? "24",
    10,
  );
  const plannerMaxTurns = parsePositiveInt(
    "PLANNER_MAX_TURNS",
    process.env.PLANNER_MAX_TURNS,
  );
  const plannerBudgetUsd = parsePositiveFloat(
    "PLANNER_BUDGET_USD",
    process.env.PLANNER_BUDGET_USD,
  );
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
  const integrationRoot = resolveFromRepoRoot(
    process.env.INTEGRATION_WORKTREE_ROOT ?? ".integration-worktrees",
  );

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const db = createDb(databaseUrl);

  const planPersistence = createPlanPersistenceActivities({ db });

  // Shared failure sink for every Claude-backed runner. When the runner
  // catches + classifies an SDK error it synthesizes a
  // `status: "failed"` AgentRun and hands it here so operators get a
  // durable forensic row (with `error_reason` populated from the
  // classified error) even though the runner itself still re-throws so
  // Temporal's retry/non-retry gate fires. Sink exceptions are
  // swallowed by `safeInvokeFailureSink` inside each runner — never
  // bury the real error.
  const onAgentRunFailure = async (run: AgentRun): Promise<void> => {
    await planPersistence.persistAgentRun(run);
  };

  const plannerRunner: PlannerRunner =
    plannerMode === "live"
      ? createClaudePlannerRunner({ onFailure: onAgentRunFailure })
      : createFixtureSubstitutingStubRunner(resolveFixturePath());

  const implementerRunner: ImplementerRunner =
    implementerMode === "live"
      ? createClaudeImplementerRunner({ onFailure: onAgentRunFailure })
      : createStubImplementerRunner(buildStubImplementerOptions());

  const reviewerRunner: ReviewerRunner =
    reviewerMode === "live"
      ? createClaudeReviewerRunner({ onFailure: onAgentRunFailure })
      : createStubReviewerRunner({
          sequence: parseReviewerSmokeSequence(
            process.env.REVIEWER_SMOKE_SEQUENCE,
          ),
        });

  const phaseAuditorRunner: PhaseAuditorRunner =
    phaseAuditorMode === "live"
      ? createClaudePhaseAuditorRunner({ onFailure: onAgentRunFailure })
      : createStubPhaseAuditorRunner({
          sequence: parsePhaseAuditorSmokeSequence(
            process.env.PHASE_AUDITOR_SMOKE_SEQUENCE,
          ),
        });

  const completionAuditorRunner: CompletionAuditorRunner =
    completionAuditorMode === "live"
      ? createClaudeCompletionAuditorRunner({ onFailure: onAgentRunFailure })
      : createStubCompletionAuditorRunner({
          sequence: parseCompletionAuditorSmokeSequence(
            process.env.COMPLETION_AUDITOR_SMOKE_SEQUENCE,
          ),
        });

  const connection = await NativeConnection.connect({ address: temporalAddress });

  const repoIntel = createRepoIntelligenceActivities({ db });
  const specIntake = createSpecIntakeActivities({ db });
  const planner = createPlannerActivities({
    db,
    plannerRunner,
    artifactDir,
    ...(plannerMaxTurns !== undefined ? { plannerMaxTurns } : {}),
    ...(plannerBudgetUsd !== undefined ? { plannerBudgetUsd } : {}),
  });
  const worktree = createWorktreeActivities({ db });
  const taskExecution = createTaskExecutionActivities({
    db,
    implementerRunner,
    repoRoot,
    worktreeRoot,
  });
  const review = createReviewActivities({ reviewerRunner });
  const reviewPersistence = createReviewPersistenceActivities({ db });
  const integration = createIntegrationActivities({
    db,
    repoRoot,
    integrationRoot,
    maxLifetimeHours,
  });
  const phaseAudit = createPhaseAuditActivities({
    db,
    phaseAuditorRunner,
  });
  const completionAudit = createCompletionAuditActivities({
    db,
    completionAuditorRunner,
    artifactDir,
  });
  // Phase 7: policy-engine + observability + events activities. The
  // policy factory loads durable inputs, calls the pure evaluators in
  // `@pm-go/policy-engine`, and persists side-effect rows
  // (`approval_requests`, `budget_reports`). The spans factory exposes
  // `persistSpan` for the disjoint open/close case (the typical path
  // is `withSpan` already inline in each wrapped activity). The events
  // factory was implicit in the activity bag before — registering it
  // explicitly here keeps the surface discoverable.
  const policy = createPolicyActivities({ db });
  const spans = createSpanActivities({ db });
  const events = createEventActivities({ db });

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
    ...review,
    ...reviewPersistence,
    ...integration,
    ...phaseAudit,
    ...completionAudit,
    ...policy,
    ...spans,
    ...events,
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
    `worker starting (planner=${plannerMode} implementer=${implementerMode} reviewer=${reviewerMode} phase-auditor=${phaseAuditorMode} completion-auditor=${completionAuditorMode} integration-root=${integrationRoot})`,
  );
  await worker.run();
}

/**
 * Build options for the stub implementer runner based on env vars.
 *
 * - `IMPLEMENTER_STUB_WRITE_FILE_PATH` — relative path inside the
 *   worktree to write (must match the task's `fileScope.includes` or the
 *   post-commit diff-scope check will block the task). Set to the empty
 *   string to opt out of filesystem writes entirely — the workflow still
 *   succeeds and transitions to `in_review` because `commitAgentWork`
 *   handles an empty worktree gracefully.
 * - `IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG` — comma-separated
 *   `slug=path,slug2=pathB` map. When present, the per-slug path beats
 *   `IMPLEMENTER_STUB_WRITE_FILE_PATH` for any matching task. Required
 *   by the Phase 5 smoke, which runs three tasks with disjoint fileScopes
 *   inside a single worker boot.
 * - `IMPLEMENTER_STUB_WRITE_FILE_CONTENTS` — contents for the written
 *   file. Defaults to "stub implementer output\n".
 * - Default behavior (matching the historical Phase 3 config): write
 *   `NOTES.md` at the worktree root. Callers that need the stub to stay
 *   inside a task's fileScope — like Phase 4 smoke — must override the
 *   path explicitly.
 */
function buildStubImplementerOptions(): {
  writeFile?: { relativePath: string; contents: string };
  writeFileBySlug?: { bySlug: Record<string, string>; contents: string };
} {
  const explicitPath = process.env.IMPLEMENTER_STUB_WRITE_FILE_PATH;
  const explicitContents =
    process.env.IMPLEMENTER_STUB_WRITE_FILE_CONTENTS ?? "stub implementer output\n";
  const perSlugRaw = process.env.IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG;

  const out: {
    writeFile?: { relativePath: string; contents: string };
    writeFileBySlug?: { bySlug: Record<string, string>; contents: string };
  } = {};

  if (perSlugRaw && perSlugRaw.trim().length > 0) {
    const bySlug: Record<string, string> = {};
    for (const entry of perSlugRaw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0 || eq === trimmed.length - 1) {
        console.warn(
          `IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG: ignoring malformed entry '${trimmed}' (expected slug=path)`,
        );
        continue;
      }
      const slug = trimmed.slice(0, eq).trim();
      const pth = trimmed.slice(eq + 1).trim();
      if (slug.length === 0 || pth.length === 0) continue;
      bySlug[slug] = pth;
    }
    if (Object.keys(bySlug).length > 0) {
      out.writeFileBySlug = { bySlug, contents: explicitContents };
    }
  }

  // Empty-string opt-out — no filesystem writes (even if the per-slug
  // map is empty). commitAgentWork handles the empty case.
  if (explicitPath === "") {
    return out;
  }

  // Only install a global fallback when an explicit path was provided
  // OR no per-slug map exists. If both are set, per-slug takes
  // precedence per-call (see resolveStubWriteFile), but we keep the
  // global as the fallback for slugs not in the map.
  const relativePath = explicitPath ?? (out.writeFileBySlug ? undefined : "NOTES.md");
  if (relativePath !== undefined) {
    out.writeFile = { relativePath, contents: explicitContents };
  }
  return out;
}

/**
 * Parse the `REVIEWER_SMOKE_SEQUENCE` env var into a sequence of stub
 * outcomes. Accepts a comma-separated list of literal outcomes ("pass",
 * "changes_requested", "blocked"). Unknown entries are dropped with a
 * warning; an empty / missing var defaults to `["pass"]` so the stub
 * runner is usable without explicit configuration.
 */
function parseReviewerSmokeSequence(
  raw: string | undefined,
): StubReviewerSequenceEntry[] {
  if (!raw || raw.trim().length === 0) {
    return ["pass"];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const valid: ReviewOutcome[] = ["pass", "changes_requested", "blocked"];
  const filtered: StubReviewerSequenceEntry[] = [];
  for (const p of parts) {
    if ((valid as string[]).includes(p)) {
      filtered.push(p as ReviewOutcome);
    } else {
      console.warn(
        `REVIEWER_SMOKE_SEQUENCE: ignoring unknown entry '${p}' (valid: ${valid.join(", ")})`,
      );
    }
  }
  return filtered.length > 0 ? filtered : ["pass"];
}

/**
 * Parse the `PHASE_AUDITOR_SMOKE_SEQUENCE` env var the same way as the
 * reviewer sequence parser. Defaults to `["pass"]` so the stub runner
 * is usable without explicit configuration. Unknown entries are dropped
 * with a warning (same pattern as the reviewer for consistency).
 */
function parsePhaseAuditorSmokeSequence(
  raw: string | undefined,
): StubPhaseAuditorSequenceEntry[] {
  if (!raw || raw.trim().length === 0) {
    return ["pass"];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const valid: PhaseAuditOutcome[] = ["pass", "changes_requested", "blocked"];
  const out: StubPhaseAuditorSequenceEntry[] = [];
  for (const p of parts) {
    if ((valid as string[]).includes(p)) {
      out.push(p as PhaseAuditOutcome);
    } else {
      console.warn(
        `PHASE_AUDITOR_SMOKE_SEQUENCE: ignoring unknown entry '${p}' (valid: ${valid.join(", ")})`,
      );
    }
  }
  return out.length > 0 ? out : ["pass"];
}

function parseCompletionAuditorSmokeSequence(
  raw: string | undefined,
): StubCompletionAuditorSequenceEntry[] {
  if (!raw || raw.trim().length === 0) {
    return ["pass"];
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const valid: CompletionAuditOutcome[] = [
    "pass",
    "changes_requested",
    "blocked",
  ];
  const out: StubCompletionAuditorSequenceEntry[] = [];
  for (const p of parts) {
    if ((valid as string[]).includes(p)) {
      out.push(p as CompletionAuditOutcome);
    } else {
      console.warn(
        `COMPLETION_AUDITOR_SMOKE_SEQUENCE: ignoring unknown entry '${p}' (valid: ${valid.join(", ")})`,
      );
    }
  }
  return out.length > 0 ? out : ["pass"];
}

function resolveFixturePath(): string {
  // `PLANNER_STUB_FIXTURE_PATH` wins when set — the Phase 5 smoke points
  // the stub planner at a dedicated 2-phase fixture with no-op
  // testCommands and disjoint fileScopes. Absolute paths pass through;
  // relative paths resolve against the repo root, matching the other
  // env-var-configurable dirs (PLAN_ARTIFACT_DIR, WORKTREE_ROOT).
  const override = process.env.PLANNER_STUB_FIXTURE_PATH;
  if (override && override.trim().length > 0) {
    return path.isAbsolute(override) ? override : resolveFromRepoRoot(override);
  }
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

/**
 * Parse a positive integer from an env-var string. Returns `undefined`
 * when the var is unset or empty (caller chooses the default); throws
 * when the var is set but does not parse to a finite positive integer.
 * A typo like `PLANNER_MAX_TURNS=abc` would otherwise become `NaN` and
 * flow into the planner run as a nonsense cap.
 */
function parsePositiveInt(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name}: expected a positive integer, got '${raw}'`,
    );
  }
  return n;
}

/** Same shape as parsePositiveInt but for floats (budget caps). */
function parsePositiveFloat(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name}: expected a positive number, got '${raw}'`,
    );
  }
  return n;
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
