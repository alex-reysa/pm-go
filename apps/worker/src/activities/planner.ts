import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentRun, Artifact, Plan } from "@pm-go/contracts";
import type { PmGoDb } from "@pm-go/db";
import type { PlannerRunner } from "@pm-go/executor-claude";
import { auditPlan, renderPlanMarkdown, runPlanner } from "@pm-go/planner";

import { createPlanPersistenceActivities } from "./plan-persistence.js";

export interface PlannerActivityDeps {
  db: PmGoDb;
  plannerRunner: PlannerRunner;
  artifactDir: string;
  plannerMaxTurns?: number;
  plannerBudgetUsd?: number;
}

export interface PlannerActivities {
  generatePlan(input: {
    specDocumentId: string;
    repoSnapshotId: string;
    requestedBy: string;
  }): Promise<{ plan: Plan; agentRun: AgentRun }>;
  auditPlanActivity(plan: Plan): Promise<ReturnType<typeof auditPlan>>;
  renderPlanMarkdownActivity(input: {
    planId: string;
    plan: Plan;
  }): Promise<{ artifact: Artifact }>;
}

/**
 * Build the activities that drive `SpecToPlanWorkflow`'s planner leg.
 *
 * - `generatePlan` loads the persisted spec + repo-snapshot and runs the
 *   pure `@pm-go/planner.runPlanner` via an injected `PlannerRunner`
 *   (stub or Claude-backed).
 * - `auditPlanActivity` is a thin wrapper over `auditPlan` — kept as a
 *   named activity so the workflow can await it with Temporal retries.
 * - `renderPlanMarkdownActivity` persists the deterministic Markdown to
 *   `artifactDir/<planId>.md` and returns the `Artifact` descriptor the
 *   workflow will then hand to `persistArtifact`.
 */
export function createPlannerActivities(
  deps: PlannerActivityDeps,
): PlannerActivities {
  // Reuse the plan-persistence loaders so there is exactly one implementation
  // of "fetch a SpecDocument/RepoSnapshot by id" across the worker.
  const persistence = createPlanPersistenceActivities({ db: deps.db });

  return {
    async generatePlan(input) {
      const specDocument = await persistence.loadSpecDocument(
        input.specDocumentId,
      );
      const repoSnapshot = await persistence.loadRepoSnapshot(
        input.repoSnapshotId,
      );
      const { plan, agentRun } = await runPlanner({
        specDocument,
        repoSnapshot,
        requestedBy: input.requestedBy,
        runner: deps.plannerRunner,
        ...(deps.plannerMaxTurns !== undefined ? { maxTurnsCap: deps.plannerMaxTurns } : {}),
        ...(deps.plannerBudgetUsd !== undefined ? { budgetUsdCap: deps.plannerBudgetUsd } : {}),
      });
      return { plan, agentRun };
    },

    async auditPlanActivity(plan) {
      return auditPlan(plan);
    },

    async renderPlanMarkdownActivity(input) {
      const md = renderPlanMarkdown(input.plan);
      await fs.mkdir(deps.artifactDir, { recursive: true });
      const filePath = path.join(deps.artifactDir, `${input.planId}.md`);
      await fs.writeFile(filePath, md, "utf8");
      // `pathToFileURL` percent-encodes spaces and special characters
      // so the URI is parseable by consumers via `new URL(uri)`. The raw
      // `'file://' + path.resolve(...)` form breaks on paths containing
      // whitespace (e.g. "/Users/alex/My Project/...").
      const artifact: Artifact = {
        id: randomUUID(),
        planId: input.planId,
        kind: "plan_markdown",
        uri: pathToFileURL(path.resolve(filePath)).href,
        createdAt: new Date().toISOString(),
      };
      return { artifact };
    },
  };
}
