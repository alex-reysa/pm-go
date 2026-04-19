import { randomUUID } from "node:crypto";

import type {
  AgentRun,
  CompletionAuditOutcome,
  CompletionAuditReport,
  CompletionAuditSummary,
  CompletionChecklistItem,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
  PolicyDecision,
  ReviewFinding,
  StoredReviewReport,
} from "@pm-go/contracts";

/**
 * Evidence bundled for the plan-wide completion auditor. Assembled by
 * the workflow layer from durable rows before the runner is invoked.
 */
export interface CompletionAuditEvidence {
  /** Every phase in the plan. */
  phases: Phase[];
  /** Every phase audit report for the plan, one per phase. */
  phaseAuditReports: PhaseAuditReport[];
  /** Every MergeRun across all phases. */
  mergeRuns: MergeRun[];
  /**
   * Every persisted review report across all tasks in the plan. Uses
   * the stored shape so `reviewedBaseSha` / `reviewedHeadSha` reach
   * the completion auditor — same provenance concern as
   * `PhaseAuditEvidence.reviewReports`.
   */
  reviewReports: StoredReviewReport[];
  /** Every PolicyDecision scoped to the plan. */
  policyDecisions: PolicyDecision[];
  /** Plan-level diff summary: `git diff <plan.base_sha>..<final_merge_run.integration_head_sha> --stat --name-only`. */
  diffSummary: string;
}

export interface CompletionAuditorRunnerInput {
  plan: Plan;
  finalPhase: Phase;
  finalMergeRun: MergeRun;
  evidence: CompletionAuditEvidence;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  /** Path to the final phase's integration worktree (runner's `cwd`). */
  worktreePath: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface CompletionAuditorRunnerResult {
  report: CompletionAuditReport;
  agentRun: AgentRun;
}

export interface CompletionAuditorRunner {
  run(
    input: CompletionAuditorRunnerInput,
  ): Promise<CompletionAuditorRunnerResult>;
}

/**
 * Sequenced outcomes for the stub completion auditor.
 */
export type StubCompletionAuditorSequenceEntry =
  | CompletionAuditOutcome
  | {
      outcome: CompletionAuditOutcome;
      findings?: ReviewFinding[];
      checklist?: CompletionChecklistItem[];
      summary?: CompletionAuditSummary;
    };

export interface CreateStubCompletionAuditorRunnerOptions {
  sequence: StubCompletionAuditorSequenceEntry[];
}

/**
 * Stub completion auditor runner for smoke tests and unit flows.
 * Consumes `options.sequence` one entry per call. Never imports the
 * Claude Agent SDK.
 */
export function createStubCompletionAuditorRunner(
  options: CreateStubCompletionAuditorRunnerOptions,
): CompletionAuditorRunner {
  if (options.sequence.length === 0) {
    throw new Error(
      "createStubCompletionAuditorRunner: options.sequence must not be empty",
    );
  }
  let callIndex = 0;

  return {
    async run(
      input: CompletionAuditorRunnerInput,
    ): Promise<CompletionAuditorRunnerResult> {
      const idx = Math.min(callIndex, options.sequence.length - 1);
      callIndex += 1;
      const entry = options.sequence[idx]!;
      const outcome: CompletionAuditOutcome =
        typeof entry === "string" ? entry : entry.outcome;
      const findings: ReviewFinding[] =
        typeof entry === "string"
          ? defaultStubFindings(outcome)
          : (entry.findings ?? defaultStubFindings(outcome));
      const checklist: CompletionChecklistItem[] =
        typeof entry === "string"
          ? defaultStubChecklist(outcome)
          : (entry.checklist ?? defaultStubChecklist(outcome));
      const summary: CompletionAuditSummary =
        typeof entry === "string" || entry.summary === undefined
          ? defaultStubSummary(outcome)
          : entry.summary;

      const nowIso = new Date().toISOString();
      const auditorRunId = randomUUID();

      const report: CompletionAuditReport = {
        id: randomUUID(),
        planId: input.plan.id,
        finalPhaseId: input.finalPhase.id,
        mergeRunId: input.finalMergeRun.id,
        auditorRunId,
        auditedHeadSha:
          input.finalMergeRun.integrationHeadSha ??
          "0000000000000000000000000000000000000000",
        outcome,
        checklist,
        findings,
        summary,
        createdAt: nowIso,
      };

      const agentRun: AgentRun = {
        id: auditorRunId,
        workflowRunId: input.workflowRunId ?? "stub-workflow-run",
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: "medium",
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        sessionId: `stub-completion-auditor-${randomUUID()}`,
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        permissionMode: "default",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: "completed",
        outputFormatSchemaRef: "CompletionAuditReport@1",
        startedAt: nowIso,
        completedAt: nowIso,
      };

      return { report, agentRun };
    },
  };
}

function defaultStubFindings(outcome: CompletionAuditOutcome): ReviewFinding[] {
  if (outcome === "pass") return [];
  return [
    {
      id: `stub-completion-finding-${randomUUID().slice(0, 8)}`,
      severity: "medium",
      title: "Stub completion auditor placeholder finding",
      summary:
        "Emitted by createStubCompletionAuditorRunner for deterministic smoke flows.",
      filePath: "STUB",
      confidence: 0.5,
      suggestedFixDirection:
        "No real finding — stub runner generated this entry.",
    },
  ];
}

function defaultStubChecklist(
  outcome: CompletionAuditOutcome,
): CompletionChecklistItem[] {
  const itemStatus = outcome === "pass" ? "passed" : "failed";
  return [
    {
      id: "check-all-required-tasks-merged",
      title: "Every required task merged, waived, or blocked with reason",
      status: itemStatus,
      evidenceArtifactIds: [],
    },
    {
      id: "check-acceptance-criteria-evidence",
      title: "Every required acceptance criterion mapped to evidence",
      status: itemStatus,
      evidenceArtifactIds: [],
    },
    {
      id: "check-no-open-blocking-findings",
      title: "No blocking review findings remain unresolved",
      status: "passed",
      evidenceArtifactIds: [],
    },
    {
      id: "check-policy-decisions-resolved",
      title: "No unresolved policy decisions for release scope",
      status: "passed",
      evidenceArtifactIds: [],
    },
    {
      id: "check-repo-state-matches-release",
      title: "Final repo state matches artifacts proposed for release",
      status: itemStatus,
      evidenceArtifactIds: [],
    },
    {
      id: "check-audit-against-latest-head",
      title: "Completion audit running against latest merged head",
      status: "passed",
      evidenceArtifactIds: [],
    },
  ];
}

function defaultStubSummary(
  outcome: CompletionAuditOutcome,
): CompletionAuditSummary {
  return {
    acceptanceCriteriaPassed: outcome === "pass" ? ["stub-ac-1"] : [],
    acceptanceCriteriaMissing: outcome === "pass" ? [] : ["stub-ac-1"],
    openFindingIds: [],
    unresolvedPolicyDecisionIds: [],
  };
}

export {
  createClaudeCompletionAuditorRunner,
  type ClaudeCompletionAuditorRunnerConfig,
} from "./claude-completion-auditor-runner.js";
