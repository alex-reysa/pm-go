import type {
  AgentRun,
  CompletionAuditReport,
  MergeRun,
  Phase,
  Plan,
} from "@pm-go/contracts";
import type {
  CompletionAuditEvidence,
  CompletionAuditorRunner,
} from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

/**
 * Input to {@link runCompletionAuditor}. Mirrors the phase-auditor
 * wrapper but scoped to the plan — `baseSha` is the plan's start HEAD
 * (from plan.repoSnapshotId's RepoSnapshot).
 */
export interface RunCompletionAuditorInput {
  plan: Plan;
  finalPhase: Phase;
  finalMergeRun: MergeRun;
  /** Plan-level base commit — HEAD of plan.repoSnapshotId at plan-start. */
  baseSha: string;
  evidence: CompletionAuditEvidence;
  /** Final phase's integration worktree path — the runner's cwd. */
  worktreePath: string;
  requestedBy: string;
  runner: CompletionAuditorRunner;
  /** Claude model id. Defaults to `"claude-sonnet-4-6"`. */
  model?: string;
  /** Hard USD budget cap. Defaults to 2.0 (release-gate audit is pricier). */
  budgetUsdCap?: number;
  /** Hard turn cap. Defaults to 60. */
  maxTurnsCap?: number;
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface RunCompletionAuditorResult {
  report: CompletionAuditReport;
  agentRun: AgentRun;
}

/**
 * Orchestrates a single completion auditor run. Loads
 * `completion-auditor@1`, forwards to runner. Runner performs
 * schema validation + host-side id rewriting.
 */
export async function runCompletionAuditor(
  input: RunCompletionAuditorInput,
): Promise<RunCompletionAuditorResult> {
  const systemPrompt = loadPrompt("completion-auditor", 1);

  const model = input.model ?? "claude-opus-4-7";
  const budgetUsdCap = input.budgetUsdCap ?? 2.0;
  const maxTurnsCap = input.maxTurnsCap ?? 60;

  return input.runner.run({
    plan: input.plan,
    finalPhase: input.finalPhase,
    finalMergeRun: input.finalMergeRun,
    baseSha: input.baseSha,
    evidence: input.evidence,
    systemPrompt,
    promptVersion: "completion-auditor@1",
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
