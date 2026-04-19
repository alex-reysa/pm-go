import type { PhaseAuditorRunner } from "./phase-auditor-runner.js";

export interface ClaudePhaseAuditorRunnerConfig {
  /** Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
}

/**
 * Placeholder factory for the Claude-backed phase auditor. The real
 * implementation — SDK `query` wiring, `canUseTool` enforcement,
 * `outputFormat: json_schema` with `PhaseAuditReportSchema`, host-side
 * id rewriting, validation failure translated to
 * `PhaseAuditValidationError` — lands in the Phase 5 Auditor-runners
 * lane (Worker 3).
 *
 * Keeping the factory exported here (even as a stub) lets Worker 4
 * wire the interface through `apps/worker` without waiting on the full
 * implementation.
 */
export function createClaudePhaseAuditorRunner(
  _config?: ClaudePhaseAuditorRunnerConfig,
): PhaseAuditorRunner {
  return {
    async run() {
      throw new Error(
        "createClaudePhaseAuditorRunner: not yet implemented. The Phase 5 Auditor-runners lane owns this runner — use createStubPhaseAuditorRunner in the meantime.",
      );
    },
  };
}
