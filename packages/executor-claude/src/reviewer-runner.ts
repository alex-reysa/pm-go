import { randomUUID } from "node:crypto";

import type {
  AgentRun,
  ReviewFinding,
  ReviewOutcome,
  ReviewReport,
  ReviewStrictness,
  Task,
} from "@pm-go/contracts";

export interface ReviewerRunnerInput {
  task: Task;
  worktreePath: string;
  baseSha: string;
  /** Git SHA of the implementer's final commit (HEAD of the task branch). */
  headSha: string;
  strictness: ReviewStrictness;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  /** 1 for the first review, 2 for the second, etc. */
  cycleNumber: number;
  /** Findings from the previous cycle's review, if any — surfaced to the reviewer so it can verify fixes. */
  previousFindings?: ReviewFinding[];
  workflowRunId?: string;
  parentSessionId?: string;
}

export interface ReviewerRunnerResult {
  report: ReviewReport;
  agentRun: AgentRun;
}

export interface ReviewerRunner {
  run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult>;
}

/**
 * Sequenced outcomes for the stub runner. Each entry is either a bare
 * `ReviewOutcome` literal (in which case findings are synthesized by the
 * stub) or a full `ReviewReport` override for test scenarios that need
 * specific findings. Entries are consumed in order across calls; when the
 * sequence is exhausted the last entry is reused.
 */
export type StubReviewerSequenceEntry =
  | ReviewOutcome
  | {
      outcome: ReviewOutcome;
      findings?: ReviewFinding[];
    };

export interface CreateStubReviewerRunnerOptions {
  sequence: StubReviewerSequenceEntry[];
}

/**
 * Stub reviewer runner for smoke tests and foundation flows. It consumes
 * `options.sequence` one entry per call; each entry can be a bare outcome
 * literal (stub synthesizes an empty/plausible findings list) or an object
 * that overrides the findings. The stub never imports
 * `@anthropic-ai/claude-agent-sdk`.
 */
export function createStubReviewerRunner(
  options: CreateStubReviewerRunnerOptions,
): ReviewerRunner {
  if (options.sequence.length === 0) {
    throw new Error(
      "createStubReviewerRunner: options.sequence must not be empty",
    );
  }
  let callIndex = 0;

  return {
    async run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult> {
      const idx = Math.min(callIndex, options.sequence.length - 1);
      callIndex += 1;
      const entry = options.sequence[idx]!;
      const outcome: ReviewOutcome =
        typeof entry === "string" ? entry : entry.outcome;
      const findings: ReviewFinding[] =
        typeof entry === "string"
          ? defaultStubFindings(outcome)
          : (entry.findings ?? defaultStubFindings(outcome));

      const nowIso = new Date().toISOString();
      const reviewerRunId = randomUUID();

      const report: ReviewReport = {
        id: randomUUID(),
        taskId: input.task.id,
        reviewerRunId,
        outcome,
        findings,
        createdAt: nowIso,
      };

      const agentRun: AgentRun = {
        id: reviewerRunId,
        taskId: input.task.id,
        workflowRunId: input.workflowRunId ?? "stub-workflow-run",
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: input.task.riskLevel,
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        sessionId: `stub-reviewer-${randomUUID()}`,
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
        startedAt: nowIso,
        completedAt: nowIso,
      };

      return { report, agentRun };
    },
  };
}

function defaultStubFindings(outcome: ReviewOutcome): ReviewFinding[] {
  if (outcome === "pass") return [];
  // For changes_requested / blocked, synthesize a single medium-severity
  // placeholder so downstream persistence + UI paths see a non-empty array.
  return [
    {
      id: `stub-finding-${randomUUID().slice(0, 8)}`,
      severity: "medium",
      title: "Stub reviewer placeholder finding",
      summary:
        "Emitted by createStubReviewerRunner for deterministic smoke flows. Replace with real review output in live mode.",
      filePath: "STUB",
      confidence: 0.5,
      suggestedFixDirection:
        "No real finding — stub runner generated this entry.",
    },
  ];
}

export {
  createClaudeReviewerRunner,
  type ClaudeReviewerRunnerConfig,
} from "./claude-reviewer-runner.js";
