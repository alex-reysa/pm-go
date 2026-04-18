import {
  validatePlan,
  type AgentRun,
  type Plan,
  type RepoSnapshot,
  type SpecDocument,
} from "@pm-go/contracts";
import type { PlannerRunner } from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

/**
 * Input to {@link runPlanner}.
 */
export interface RunPlannerInput {
  specDocument: SpecDocument;
  repoSnapshot: RepoSnapshot;
  /** User / operator that kicked off the planner run. Recorded alongside the AgentRun metadata by callers. */
  requestedBy: string;
  /** The executor-side runner that actually talks to the Claude Agent SDK (or a stub during tests). */
  runner: PlannerRunner;
  /** Claude model id. Defaults to `"claude-sonnet-4-6"`. */
  model?: string;
  /** Hard USD budget cap for the planner run. Defaults to 0.50. */
  budgetUsdCap?: number;
  /** Hard turn cap for the planner run. Defaults to 30. */
  maxTurnsCap?: number;
}

/**
 * Successful result of {@link runPlanner}.
 */
export interface RunPlannerResult {
  plan: Plan;
  agentRun: AgentRun;
}

/**
 * Thrown when the Plan returned by the runner does not satisfy the
 * TypeBox `PlanSchema`. The message names the offending fields where we
 * can diagnose them structurally without depending on TypeBox internals
 * (the planner package intentionally does not take a direct dependency
 * on `@sinclair/typebox`).
 */
export class PlanValidationError extends Error {
  readonly issues: ReadonlyArray<string>;

  constructor(message: string, issues: ReadonlyArray<string>) {
    super(message);
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

/**
 * Orchestrates a single planner run:
 *
 * 1. Loads the `planner@1` system prompt from disk.
 * 2. Builds a user message containing the spec body and a condensed
 *    `RepoSnapshot` JSON blob.
 * 3. Invokes the injected {@link PlannerRunner} to talk to the model
 *    (stub in tests, Claude Agent SDK in production).
 * 4. Validates the returned `Plan` with `validatePlan` from
 *    `@pm-go/contracts`. On failure, throws {@link PlanValidationError}
 *    with up to 5 TypeBox-reported errors attached.
 *
 * This function is pure with respect to filesystem state — it reads the
 * prompt file and delegates all network I/O to the injected runner.
 */
export async function runPlanner(
  input: RunPlannerInput,
): Promise<RunPlannerResult> {
  const systemPrompt = loadPrompt("planner", 1);

  const model = input.model ?? "claude-sonnet-4-6";
  const budgetUsdCap = input.budgetUsdCap ?? 0.5;
  const maxTurnsCap = input.maxTurnsCap ?? 30;

  const result = await input.runner.run({
    specDocument: input.specDocument,
    repoSnapshot: input.repoSnapshot,
    systemPrompt,
    promptVersion: "planner@1",
    model,
    budgetUsdCap,
    maxTurnsCap,
    cwd: input.repoSnapshot.repoRoot,
  });

  if (!validatePlan(result.plan)) {
    const issues = diagnosePlanShape(result.plan);
    const preview = issues.length > 0 ? `: ${issues.slice(0, 5).join("; ")}` : "";
    throw new PlanValidationError(
      `runPlanner: returned Plan failed PlanSchema validation${preview}`,
      issues,
    );
  }

  return { plan: result.plan, agentRun: result.agentRun };
}

/**
 * Best-effort, dependency-free diagnosis of the shape of an object the
 * runner claimed was a Plan. Produces human-readable strings for
 * missing or wrong-typed top-level fields; callers get the raw
 * `validatePlan` boolean for the authoritative pass/fail answer.
 */
function diagnosePlanShape(candidate: unknown): string[] {
  const issues: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    issues.push(`<root>: expected object, got ${candidate === null ? "null" : typeof candidate}`);
    return issues;
  }
  const obj = candidate as Record<string, unknown>;
  const stringField = (key: string) => {
    if (!(key in obj)) issues.push(`${key}: missing`);
    else if (typeof obj[key] !== "string") issues.push(`${key}: expected string`);
  };
  const arrayField = (key: string) => {
    if (!(key in obj)) issues.push(`${key}: missing`);
    else if (!Array.isArray(obj[key])) issues.push(`${key}: expected array`);
  };
  stringField("id");
  stringField("specDocumentId");
  stringField("repoSnapshotId");
  stringField("title");
  stringField("summary");
  stringField("status");
  stringField("createdAt");
  stringField("updatedAt");
  arrayField("phases");
  arrayField("tasks");
  arrayField("risks");
  return issues;
}
