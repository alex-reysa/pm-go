export { PROMPT_VERSIONS, loadPrompt } from "./prompts.js";
export type { PromptName } from "./prompts.js";

/**
 * Foundation-lane placeholders. The real runPlanner / auditPlan /
 * renderPlanMarkdown implementations land in the Planner lane worktree
 * and will consume the PlannerRunner interface from @pm-go/executor-claude.
 */
export function runPlanner(): never {
  throw new Error("runPlanner implementation lands in the Planner lane");
}

export function auditPlan(): never {
  throw new Error("auditPlan implementation lands in the Planner lane");
}

export function renderPlanMarkdown(): never {
  throw new Error(
    "renderPlanMarkdown implementation lands in the Planner lane",
  );
}
