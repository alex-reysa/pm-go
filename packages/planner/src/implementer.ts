import type { AgentRun, Task } from "@pm-go/contracts";
import type { ImplementerRunner } from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

/**
 * Input to {@link runImplementer}.
 */
export interface RunImplementerInput {
  task: Task;
  worktreePath: string;
  baseSha: string;
  /** User / operator that kicked off the implementer run. Recorded alongside the AgentRun metadata by callers. */
  requestedBy: string;
  /** The executor-side runner that actually talks to the Claude Agent SDK (or a stub during tests). */
  runner: ImplementerRunner;
  /** Claude model id. Defaults to `"claude-sonnet-4-6"`. */
  model?: string;
  /** Hard USD budget cap for the implementer run. Defaults to 2.0. */
  budgetUsdCap?: number;
  /** Hard turn cap for the implementer run. Defaults to 60. */
  maxTurnsCap?: number;
}

/**
 * Successful result of {@link runImplementer}. The `finalCommitSha` is the
 * git HEAD sha observed in the worktree at the end of the run, if any —
 * whether the post-execution commit hook or a live agent step produced it
 * is transparent to this layer.
 */
export interface RunImplementerResult {
  agentRun: AgentRun;
  finalCommitSha?: string;
}

/**
 * Orchestrates a single implementer run:
 *
 * 1. Loads the `implementer@1` system prompt from disk.
 * 2. Delegates to the injected {@link ImplementerRunner}, which is responsible
 *    for composing the user turn from the `Task` + worktree metadata it
 *    already receives here. No user message is constructed at this layer.
 * 3. Returns the runner's `{ agentRun, finalCommitSha }` verbatim.
 *
 * This function is pure with respect to network I/O — it only reads the
 * on-disk prompt file and forwards options to the runner.
 */
export async function runImplementer(
  input: RunImplementerInput,
): Promise<RunImplementerResult> {
  const systemPrompt = loadPrompt("implementer", 1);

  const model = input.model ?? "claude-sonnet-4-6";
  const budgetUsdCap = input.budgetUsdCap ?? 2.0;
  const maxTurnsCap = input.maxTurnsCap ?? 60;

  const result = await input.runner.run({
    task: input.task,
    worktreePath: input.worktreePath,
    baseSha: input.baseSha,
    systemPrompt,
    promptVersion: "implementer@1",
    model,
    budgetUsdCap,
    maxTurnsCap,
  });

  return result.finalCommitSha !== undefined
    ? { agentRun: result.agentRun, finalCommitSha: result.finalCommitSha }
    : { agentRun: result.agentRun };
}
