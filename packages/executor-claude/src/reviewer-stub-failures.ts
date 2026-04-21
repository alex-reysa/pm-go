/**
 * Phase 7 chaos harness — reviewer stub failure modes.
 *
 * Mirror of `implementer-stub-failures.ts` for the reviewer-side
 * failure path. Activated exclusively by
 * `REVIEWER_STUB_FAILURE=review_rejection`.
 *
 * Mode semantics:
 *   - review_rejection : every review cycle returns
 *     `outcome='changes_requested'` plus one `high`-severity finding,
 *     no matter how many fix cycles have run. The chaos harness caps
 *     fix cycles (via `REVIEWER_STUB_FAILURE_CYCLE_CAP`, default 2) and
 *     asserts the task flips to `blocked` once the cap is exceeded.
 *
 * This file is stub-only: it does not import the real Claude reviewer
 * runner, and `reviewer-runner.ts` is untouched. The wrapper is
 * transparent when no env var is set.
 */
import { randomUUID } from "node:crypto";

import type {
  AgentRun,
  ReviewFinding,
  ReviewReport,
} from "@pm-go/contracts";

import type {
  ReviewerRunner,
  ReviewerRunnerInput,
  ReviewerRunnerResult,
} from "./reviewer-runner.js";

export type ReviewerStubFailureMode = "review_rejection";

export function resolveReviewerStubFailureMode(
  explicit?: string,
): ReviewerStubFailureMode | undefined {
  const raw = explicit ?? process.env.REVIEWER_STUB_FAILURE;
  if (!raw) return undefined;
  if (raw === "review_rejection") return raw;
  return undefined;
}

export interface ReviewerStubFailureOptions {
  /** Optional override of the failure mode; defaults to env-var lookup. */
  mode?: string;
}

/**
 * Wrap an existing `ReviewerRunner` so that, when
 * `REVIEWER_STUB_FAILURE=review_rejection` is set, every call returns a
 * non-passing review with a high-severity finding. When no mode is
 * active the wrapper is a transparent pass-through.
 */
export function wrapReviewerRunnerWithFailureMode(
  inner: ReviewerRunner,
  options: ReviewerStubFailureOptions = {},
): ReviewerRunner {
  const mode = resolveReviewerStubFailureMode(options.mode);
  if (!mode) return inner;

  return {
    async run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult> {
      // Build a deterministic rejection report. We intentionally don't
      // delegate to the inner runner — in `review_rejection` mode the
      // inner's sequence is irrelevant; what matters is that every
      // cycle fails the same way so the harness can observe the cap
      // being hit.
      const nowIso = new Date().toISOString();
      const reviewerRunId = randomUUID();

      const findings: ReviewFinding[] = [
        {
          id: `stub-reject-${randomUUID().slice(0, 8)}`,
          severity: "high",
          title: "Phase 7 chaos harness: forced review_rejection",
          summary:
            "REVIEWER_STUB_FAILURE=review_rejection is active; this finding is synthesized by wrapReviewerRunnerWithFailureMode to force fix-mode loops.",
          filePath: "STUB",
          confidence: 1,
          suggestedFixDirection:
            "Unset REVIEWER_STUB_FAILURE to let the inner reviewer stub run unmodified.",
        },
      ];

      const report: ReviewReport = {
        id: randomUUID(),
        taskId: input.task.id,
        reviewerRunId,
        outcome: "changes_requested",
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
        sessionId: `stub-reviewer-failure-${randomUUID()}`,
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
