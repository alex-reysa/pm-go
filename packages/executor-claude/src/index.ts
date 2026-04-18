import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  Plan,
  RepoSnapshot,
  SpecDocument,
} from "@pm-go/contracts";

export interface PlannerRunnerInput {
  specDocument: SpecDocument;
  repoSnapshot: RepoSnapshot;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  cwd: string;
}

export interface PlannerRunnerResult {
  plan: Plan;
  agentRun: AgentRun;
}

export interface PlannerRunner {
  run(input: PlannerRunnerInput): Promise<PlannerRunnerResult>;
}

/**
 * createStubPlannerRunner returns a PlannerRunner that ignores the real
 * Claude Agent SDK and always yields the provided fixture Plan plus a
 * synthesized AgentRun with role='planner', status='completed'. This is the
 * default executor for Phase 2 foundation-lane smoke flows so downstream
 * lanes can be built without an Anthropic API key.
 */
export function createStubPlannerRunner(fixture: Plan): PlannerRunner {
  return {
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const now = new Date().toISOString();
      const agentRun: AgentRun = {
        id: randomUUID(),
        workflowRunId: "stub-workflow-run",
        role: "planner",
        depth: 0,
        status: "completed",
        riskLevel: "low",
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        sessionId: "stub-session",
        permissionMode: "default",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: "completed",
        startedAt: now,
        completedAt: now,
      };
      return { plan: fixture, agentRun };
    },
  };
}

export { createClaudePlannerRunner } from "./planner-runner.js";
