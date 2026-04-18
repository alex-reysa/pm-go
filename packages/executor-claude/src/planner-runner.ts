import type { PlannerRunner } from "./index.js";

/**
 * createClaudePlannerRunner will instantiate a PlannerRunner backed by the
 * real @anthropic-ai/claude-agent-sdk. Foundation lane ships only the stub
 * runner plus this placeholder so downstream code can import by name; the
 * real implementation lands in the Planner lane worktree.
 */
export function createClaudePlannerRunner(): PlannerRunner {
  throw new Error(
    "createClaudePlannerRunner implementation lands in the Planner lane",
  );
}
