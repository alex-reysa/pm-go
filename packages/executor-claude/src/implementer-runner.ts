import type { ImplementerRunner } from "./index.js";

/**
 * Config for the real Claude-backed implementer runner. Mirrors
 * {@link ClaudePlannerRunnerConfig} in `planner-runner.ts`: the Agent SDK
 * API key defaults to `process.env.ANTHROPIC_API_KEY` and the constructor
 * is expected to throw eagerly when no key is configured.
 *
 * The implementation deliberately lands in a later Phase 3 lane so the
 * SDK import stays out of this foundation-scaffold file — every other
 * lane can depend on `@pm-go/executor-claude` without paying the cost of
 * loading the SDK when they only need the stub runner.
 */
export interface ClaudeImplementerRunnerConfig {
  apiKey?: string;
}

export function createClaudeImplementerRunner(
  _config: ClaudeImplementerRunnerConfig = {},
): ImplementerRunner {
  throw new Error(
    "createClaudeImplementerRunner: implementation lands in the Phase 3 Implementer + Prompt lane",
  );
}
