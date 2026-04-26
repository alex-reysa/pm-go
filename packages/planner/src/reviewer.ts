import type {
  AgentRun,
  ReviewFinding,
  ReviewReport,
  ReviewStrictness,
  Task,
} from "@pm-go/contracts";
import type { ReviewerRunner } from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

/**
 * Input to {@link runReviewer}. The reviewer never writes to the worktree,
 * but it does need to read it, so `worktreePath` + `baseSha` + `headSha`
 * are required. `previousFindings` is populated only on cycles >= 2.
 */
export interface RunReviewerInput {
  task: Task;
  worktreePath: string;
  baseSha: string;
  headSha: string;
  strictness: ReviewStrictness;
  /** 1-indexed cycle number; matches `review_reports.cycle_number`. */
  cycleNumber: number;
  previousFindings?: ReviewFinding[];
  /** Operator / workflow id that initiated the review. Recorded in AgentRun metadata by callers. */
  requestedBy: string;
  /** The executor-side runner that actually talks to the Claude Agent SDK (or a stub during tests). */
  runner: ReviewerRunner;
  /** Claude model id. Defaults to `"claude-sonnet-4-6"`. */
  model?: string;
  /** Hard USD budget cap for the reviewer run. Defaults to 1.0. */
  budgetUsdCap?: number;
  /** Hard turn cap for the reviewer run. Defaults to 40. */
  maxTurnsCap?: number;
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface RunReviewerResult {
  report: ReviewReport;
  agentRun: AgentRun;
}

/**
 * Orchestrates a single reviewer run:
 *
 * 1. Loads the `reviewer@1` system prompt from disk.
 * 2. Delegates to the injected {@link ReviewerRunner}, which composes the
 *    user turn, invokes the SDK with read-only tooling, validates the
 *    structured `ReviewReport`, and synthesizes the `AgentRun`.
 * 3. Returns `{ report, agentRun }` verbatim.
 *
 * This function is pure with respect to network I/O — it only reads the
 * on-disk prompt file and forwards options to the runner.
 */
export async function runReviewer(
  input: RunReviewerInput,
): Promise<RunReviewerResult> {
  const systemPrompt = loadPrompt("reviewer", 1);

  const model = input.model ?? "claude-opus-4-7";
  const budgetUsdCap = input.budgetUsdCap ?? 1.0;
  const maxTurnsCap = input.maxTurnsCap ?? 40;

  return input.runner.run({
    task: input.task,
    worktreePath: input.worktreePath,
    baseSha: input.baseSha,
    headSha: input.headSha,
    strictness: input.strictness,
    systemPrompt,
    promptVersion: "reviewer@1",
    model,
    budgetUsdCap,
    maxTurnsCap,
    cycleNumber: input.cycleNumber,
    ...(input.previousFindings ? { previousFindings: input.previousFindings } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
}
