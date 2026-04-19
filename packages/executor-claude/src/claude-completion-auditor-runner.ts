import type { CompletionAuditorRunner } from "./completion-auditor-runner.js";

export interface ClaudeCompletionAuditorRunnerConfig {
  /** Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
}

/**
 * Placeholder factory for the Claude-backed completion auditor. The
 * real implementation lands in the Phase 5 Auditor-runners lane
 * (Worker 3) — mirrors `createClaudeReviewerRunner` with `outputFormat:
 * json_schema` pinned to `CompletionAuditReportSchema`, read-only tool
 * set, host-side id rewriting, and validation failure translated to
 * `CompletionAuditValidationError`.
 */
export function createClaudeCompletionAuditorRunner(
  _config?: ClaudeCompletionAuditorRunnerConfig,
): CompletionAuditorRunner {
  return {
    async run() {
      throw new Error(
        "createClaudeCompletionAuditorRunner: not yet implemented. The Phase 5 Auditor-runners lane owns this runner — use createStubCompletionAuditorRunner in the meantime.",
      );
    },
  };
}
