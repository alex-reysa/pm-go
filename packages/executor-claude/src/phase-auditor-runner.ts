import { randomUUID } from "node:crypto";

import type {
  AgentRun,
  CompletionChecklistItem,
  MergeRun,
  Phase,
  PhaseAuditOutcome,
  PhaseAuditReport,
  Plan,
  PolicyDecision,
  ReviewFinding,
  StoredReviewReport,
  Task,
} from "@pm-go/contracts";

/**
 * Evidence bundled for the phase auditor. Assembled by the workflow
 * layer from durable rows before the runner is invoked; the runner
 * renders this into the user turn.
 */
export interface PhaseAuditEvidence {
  /** Every task in the phase being audited, by id. */
  tasks: Task[];
  /**
   * Every persisted review report for the phase's tasks. Uses the
   * stored shape so `reviewedBaseSha` / `reviewedHeadSha` (added in
   * Phase 4 hardening) reach the auditor — otherwise the commit
   * provenance that justifies the audit verdict is dropped.
   */
  reviewReports: StoredReviewReport[];
  /** Every PolicyDecision scoped to a task or review in the phase. */
  policyDecisions: PolicyDecision[];
  /** `git diff <mergeRun.integration_head_sha>~<n> HEAD --stat --name-only` inside the integration worktree. */
  diffSummary: string;
}

export interface PhaseAuditorRunnerInput {
  plan: Plan;
  phase: Phase;
  mergeRun: MergeRun;
  evidence: PhaseAuditEvidence;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  /** Path to the integration worktree (the runner's `cwd`). Never the developer's `repoRoot`. */
  worktreePath: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface PhaseAuditorRunnerResult {
  report: PhaseAuditReport;
  agentRun: AgentRun;
}

export interface PhaseAuditorRunner {
  run(input: PhaseAuditorRunnerInput): Promise<PhaseAuditorRunnerResult>;
}

/**
 * Sequenced outcomes for the stub phase auditor. Each entry is either a
 * bare `PhaseAuditOutcome` literal (stub synthesizes a plausible
 * checklist/findings) or an override shape for tests that need specific
 * contents. Consumed one entry per call; last entry reused when
 * exhausted.
 */
export type StubPhaseAuditorSequenceEntry =
  | PhaseAuditOutcome
  | {
      outcome: PhaseAuditOutcome;
      findings?: ReviewFinding[];
      checklist?: CompletionChecklistItem[];
      summary?: string;
    };

export interface CreateStubPhaseAuditorRunnerOptions {
  sequence: StubPhaseAuditorSequenceEntry[];
}

/**
 * Stub phase auditor runner for smoke tests and unit flows. Consumes
 * `options.sequence` one entry per call. Never imports the Claude Agent
 * SDK.
 */
export function createStubPhaseAuditorRunner(
  options: CreateStubPhaseAuditorRunnerOptions,
): PhaseAuditorRunner {
  if (options.sequence.length === 0) {
    throw new Error(
      "createStubPhaseAuditorRunner: options.sequence must not be empty",
    );
  }
  let callIndex = 0;

  return {
    async run(input: PhaseAuditorRunnerInput): Promise<PhaseAuditorRunnerResult> {
      const idx = Math.min(callIndex, options.sequence.length - 1);
      callIndex += 1;
      const entry = options.sequence[idx]!;
      const outcome: PhaseAuditOutcome =
        typeof entry === "string" ? entry : entry.outcome;
      const findings: ReviewFinding[] =
        typeof entry === "string"
          ? defaultStubFindings(outcome)
          : (entry.findings ?? defaultStubFindings(outcome));
      const checklist: CompletionChecklistItem[] =
        typeof entry === "string"
          ? defaultStubChecklist(outcome)
          : (entry.checklist ?? defaultStubChecklist(outcome));
      const summary: string =
        typeof entry === "string" || entry.summary === undefined
          ? `Stub phase auditor: outcome=${outcome}, cycle phase=${input.phase.id}`
          : entry.summary;

      const nowIso = new Date().toISOString();
      const auditorRunId = randomUUID();

      const report: PhaseAuditReport = {
        id: randomUUID(),
        phaseId: input.phase.id,
        planId: input.plan.id,
        mergeRunId: input.mergeRun.id,
        auditorRunId,
        mergedHeadSha:
          input.mergeRun.integrationHeadSha ??
          // Stub path: if the mergeRun hasn't been completed yet (odd for
          // the happy path but defensive), synthesize a 40-char hex.
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
        sessionId: `stub-phase-auditor-${randomUUID()}`,
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
        outputFormatSchemaRef: "PhaseAuditReport@1",
        startedAt: nowIso,
        completedAt: nowIso,
      };

      return { report, agentRun };
    },
  };
}

function defaultStubFindings(outcome: PhaseAuditOutcome): ReviewFinding[] {
  if (outcome === "pass") return [];
  return [
    {
      id: `stub-phase-finding-${randomUUID().slice(0, 8)}`,
      severity: "medium",
      title: "Stub phase auditor placeholder finding",
      summary:
        "Emitted by createStubPhaseAuditorRunner for deterministic smoke flows.",
      filePath: "STUB",
      confidence: 0.5,
      suggestedFixDirection:
        "No real finding — stub runner generated this entry.",
    },
  ];
}

function defaultStubChecklist(
  outcome: PhaseAuditOutcome,
): CompletionChecklistItem[] {
  const itemStatus = outcome === "pass" ? "passed" : "failed";
  return [
    {
      id: "check-phase-tasks-merged",
      title: "Every required phase task is merged, waived, or blocked",
      status: itemStatus,
      evidenceArtifactIds: [],
    },
    {
      id: "check-phase-merge-run-cited",
      title: "Report cites the exact MergeRun that produced the audited head",
      status: "passed",
      evidenceArtifactIds: [],
    },
  ];
}

export {
  createClaudePhaseAuditorRunner,
  PhaseAuditValidationError,
  type ClaudePhaseAuditorRunnerConfig,
} from "./claude-phase-auditor-runner.js";
