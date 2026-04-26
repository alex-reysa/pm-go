import type {
  AgentRun,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
} from "@pm-go/contracts";
import type {
  PhaseAuditEvidence,
  PhaseAuditorRunner,
} from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

/**
 * Input to {@link runPhaseAuditor}. Mirrors `RunReviewerInput` in shape —
 * the activity layer assembles evidence + resolves `baseSha` from the
 * phase's base_snapshot_id; this wrapper just loads the prompt and
 * forwards to the runner.
 */
export interface RunPhaseAuditorInput {
  plan: Plan;
  phase: Phase;
  mergeRun: MergeRun;
  /** Base commit the phase forked from (HEAD of phase.baseSnapshotId at merge time). */
  baseSha: string;
  evidence: PhaseAuditEvidence;
  /** Integration worktree path — the runner's cwd. */
  worktreePath: string;
  requestedBy: string;
  runner: PhaseAuditorRunner;
  /** Claude model id. Defaults to `"claude-sonnet-4-6"`. */
  model?: string;
  /** Hard USD budget cap. Defaults to 1.0 (matches reviewer). */
  budgetUsdCap?: number;
  /** Hard turn cap. Defaults to 40. */
  maxTurnsCap?: number;
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface RunPhaseAuditorResult {
  report: PhaseAuditReport;
  agentRun: AgentRun;
}

/**
 * Orchestrates a single phase auditor run:
 *   1. Loads the `phase-auditor@1` system prompt from disk.
 *   2. Delegates to the injected {@link PhaseAuditorRunner}, which
 *      composes the user turn, invokes the SDK with read-only tooling,
 *      validates the structured `PhaseAuditReport`, and synthesizes an
 *      `AgentRun` with `role='auditor'`, `depth=2`.
 *   3. Returns `{ report, agentRun }` verbatim — host-side id rewriting
 *      happens inside the runner.
 *
 * Pure with respect to network I/O — only reads the on-disk prompt.
 */
export async function runPhaseAuditor(
  input: RunPhaseAuditorInput,
): Promise<RunPhaseAuditorResult> {
  const systemPrompt = loadPrompt("phase-auditor", 1);

  const model = input.model ?? "claude-opus-4-7";
  const budgetUsdCap = input.budgetUsdCap ?? 1.0;
  const maxTurnsCap = input.maxTurnsCap ?? 40;

  return input.runner.run({
    plan: input.plan,
    phase: input.phase,
    mergeRun: input.mergeRun,
    baseSha: input.baseSha,
    evidence: input.evidence,
    systemPrompt,
    promptVersion: "phase-auditor@1",
    model,
    worktreePath: input.worktreePath,
    budgetUsdCap,
    maxTurnsCap,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
  });
}
