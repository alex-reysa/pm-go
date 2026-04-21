import { describe, expect, it } from "vitest";

import type { RetryPolicyConfig } from "@pm-go/contracts";

import { evaluateRetryDecision } from "../src/retry.js";

const STANDARD_POLICY: RetryPolicyConfig = {
  workflowName: "TaskExecutionWorkflow",
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
  maxAttempts: 4,
  nonRetryableErrorNames: ["ScopeViolationError", "PolicyDeniedError"],
};

const POLICIES: RetryPolicyConfig[] = [
  STANDARD_POLICY,
  {
    workflowName: "PhaseIntegrationWorkflow",
    initialDelayMs: 500,
    maxDelayMs: 2_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
  },
];

describe("evaluateRetryDecision", () => {
  it("returns retry:false when no policy matches the workflow", () => {
    const result = evaluateRetryDecision(
      "UnknownWorkflow",
      1,
      { name: "Error", message: "oops" },
      POLICIES,
    );
    expect(result).toEqual({
      retry: false,
      reason: "no_policy_for_workflow",
    });
  });

  it("returns retry:false for non-integer or zero/negative attempt", () => {
    expect(
      evaluateRetryDecision(
        "TaskExecutionWorkflow",
        0,
        { name: "Error" },
        POLICIES,
      ),
    ).toEqual({ retry: false, reason: "invalid_attempt_number" });
    expect(
      evaluateRetryDecision(
        "TaskExecutionWorkflow",
        1.5,
        { name: "Error" },
        POLICIES,
      ),
    ).toEqual({ retry: false, reason: "invalid_attempt_number" });
  });

  it("returns retry:true with initialDelayMs on attempt 1", () => {
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      1,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    expect(result).toEqual({ retry: true, delayMs: 1_000 });
  });

  it("applies exponential backoff on subsequent attempts", () => {
    const a2 = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      2,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    const a3 = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      3,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    expect(a2).toEqual({ retry: true, delayMs: 2_000 });
    expect(a3).toEqual({ retry: true, delayMs: 4_000 });
  });

  it("clamps delay to maxDelayMs", () => {
    const policy: RetryPolicyConfig = {
      workflowName: "TaskExecutionWorkflow",
      initialDelayMs: 10_000,
      maxDelayMs: 15_000,
      backoffMultiplier: 3,
      maxAttempts: 10,
    };
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      5,
      undefined,
      [policy],
    );
    // 10_000 * 3^4 = 810_000 → clamped to 15_000
    expect(result).toEqual({ retry: true, delayMs: 15_000 });
  });

  it("returns retry:false once attempt has reached maxAttempts", () => {
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      4,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    expect(result).toEqual({
      retry: false,
      reason: "max_attempts_exhausted",
    });
  });

  it("returns retry:false on non-retryable error name", () => {
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      1,
      { name: "ScopeViolationError" },
      POLICIES,
    );
    expect(result).toEqual({
      retry: false,
      reason: "non_retryable_error:ScopeViolationError",
    });
  });

  it("does not short-circuit when non-retryable list is undefined", () => {
    const policy: RetryPolicyConfig = {
      workflowName: "TaskExecutionWorkflow",
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      backoffMultiplier: 2,
      maxAttempts: 3,
    };
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      1,
      { name: "ScopeViolationError" },
      [policy],
    );
    expect(result).toEqual({ retry: true, delayMs: 1_000 });
  });

  it("handles undefined lastError as retryable", () => {
    const result = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      2,
      undefined,
      POLICIES,
    );
    expect(result).toEqual({ retry: true, delayMs: 2_000 });
  });

  it("picks the correct per-workflow policy when several are passed", () => {
    const result = evaluateRetryDecision(
      "PhaseIntegrationWorkflow",
      2,
      undefined,
      POLICIES,
    );
    expect(result).toEqual({ retry: true, delayMs: 1_000 });
  });

  it("is stable (pure) across calls with the same input", () => {
    const a = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      2,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    const b = evaluateRetryDecision(
      "TaskExecutionWorkflow",
      2,
      { name: "TransientNetworkError" },
      POLICIES,
    );
    expect(a).toEqual(b);
  });
});
