import type {
  CompletionAuditWorkflowInput,
  CompletionAuditWorkflowResult,
  FinalReleaseWorkflowInput,
  FinalReleaseWorkflowResult,
  PhaseAuditWorkflowInput,
  PhaseAuditWorkflowResult,
  PhaseIntegrationWorkflowInput,
  PhaseIntegrationWorkflowResult,
  PhasePartitionWorkflowInput,
  PhasePartitionWorkflowResult,
  PlanAuditWorkflowInput,
  PlanAuditWorkflowResult,
  RetryPolicyConfig,
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult,
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult,
  TaskFixWorkflowInput,
  TaskFixWorkflowResult,
  TaskReviewWorkflowInput,
  TaskReviewWorkflowResult
} from "@pm-go/contracts";

export interface WorkflowDefinition<Input, Output> {
  name: string;
  description: string;
  inputType?: Input;
  outputType?: Output;
}

export const SPEC_TO_PLAN_WORKFLOW: WorkflowDefinition<
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult
> = {
  name: "SpecToPlanWorkflow",
  description: "Create a structured plan from a spec document plus repo context."
};

export const PLAN_AUDIT_WORKFLOW: WorkflowDefinition<
  PlanAuditWorkflowInput,
  PlanAuditWorkflowResult
> = {
  name: "PlanAuditWorkflow",
  description: "Audit the plan before any write-capable agent work begins."
};

export const PHASE_PARTITION_WORKFLOW: WorkflowDefinition<
  PhasePartitionWorkflowInput,
  PhasePartitionWorkflowResult
> = {
  name: "PhasePartitionWorkflow",
  description:
    "Partition the active phase into bounded, worktree-safe tasks against current merged repo state."
};

export const TASK_EXECUTION_WORKFLOW: WorkflowDefinition<
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult
> = {
  name: "TaskExecutionWorkflow",
  description: "Run a write-capable implementer inside a leased worktree."
};

export const TASK_REVIEW_WORKFLOW: WorkflowDefinition<
  TaskReviewWorkflowInput,
  TaskReviewWorkflowResult
> = {
  name: "TaskReviewWorkflow",
  description: "Run an independent read-only review for a completed task."
};

export const TASK_FIX_WORKFLOW: WorkflowDefinition<
  TaskFixWorkflowInput,
  TaskFixWorkflowResult
> = {
  name: "TaskFixWorkflow",
  description: "Apply bounded fixes in response to reviewer findings."
};

export const PHASE_INTEGRATION_WORKFLOW: WorkflowDefinition<
  PhaseIntegrationWorkflowInput,
  PhaseIntegrationWorkflowResult
> = {
  name: "PhaseIntegrationWorkflow",
  description:
    "Merge completed task branches for a phase in deterministic dependency order."
};

export const PHASE_AUDIT_WORKFLOW: WorkflowDefinition<
  PhaseAuditWorkflowInput,
  PhaseAuditWorkflowResult
> = {
  name: "PhaseAuditWorkflow",
  description:
    "Audit a completed phase against its merge run, findings, and phase-scope acceptance criteria."
};

export const COMPLETION_AUDIT_WORKFLOW: WorkflowDefinition<
  CompletionAuditWorkflowInput,
  CompletionAuditWorkflowResult
> = {
  name: "CompletionAuditWorkflow",
  description:
    "Verify that merged work actually satisfies the approved plan, acceptance criteria, and release gates."
};

export const FINAL_RELEASE_WORKFLOW: WorkflowDefinition<
  FinalReleaseWorkflowInput,
  FinalReleaseWorkflowResult
> = {
  name: "FinalReleaseWorkflow",
  description:
    "Produce PR-ready output from a passing completion audit and its cited evidence."
};

/**
 * Phase 7 — Worker 4. Centralized per-workflow retry policies.
 *
 * Workflows in `apps/worker/src/workflows/*.ts` no longer set ad-hoc
 * retry options on `proxyActivities`. They consume the matching entry
 * from this catalog and translate it into a Temporal `RetryPolicy`
 * via `temporalRetryFromConfig` below.
 *
 * Evolution rules:
 *   - Add a new workflow → add an entry here. The pure-function
 *     evaluator `evaluateRetryDecision` (in `@pm-go/policy-engine`)
 *     accepts this catalog directly.
 *   - Tune retry budgets → edit here. The workflows pick up the change
 *     on next worker rebuild; no per-workflow file churn.
 *   - SDK-neutral by design — this catalog never imports from
 *     `@temporalio/*`. Workers convert at the boundary.
 *
 * Numerical policy:
 *   - `initialDelayMs` 1s for fast-recovery transients (most network
 *     glitches), 2s for the heavier merge / audit paths where a 1s
 *     retry would just thrash on the same conflict.
 *   - `backoffMultiplier` 2 (exponential).
 *   - `maxDelayMs` 30s — caps the longest single sleep at 30s so a
 *     stuck workflow surfaces visibly to the operator.
 *   - `maxAttempts` 3 — one original + two retries. Matches the Phase
 *     5 default; bumped on the audit + completion paths to 4 because
 *     those activities are the most expensive to re-drive.
 *   - `nonRetryableErrorNames` short-circuits validation failures
 *     (audit + plan validation) so Temporal does not burn retry
 *     budget on a deterministically-bad input.
 */
export const PHASE7_RETRY_POLICIES: readonly RetryPolicyConfig[] = [
  {
    workflowName: "SpecToPlanWorkflow",
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["PlanValidationError", "ContentFilterError"]
  },
  {
    workflowName: "PlanAuditWorkflow",
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["PlanValidationError"]
  },
  {
    workflowName: "PhasePartitionWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["PhasePartitionInvariantError"]
  },
  {
    workflowName: "TaskExecutionWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["ContentFilterError"]
  },
  {
    workflowName: "TaskReviewWorkflow",
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["ReviewValidationError", "ContentFilterError"]
  },
  {
    workflowName: "TaskFixWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["ContentFilterError"]
  },
  {
    workflowName: "PhaseIntegrationWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3,
    nonRetryableErrorNames: ["PhasePartitionInvariantError"]
  },
  {
    workflowName: "PhaseAuditWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 4,
    nonRetryableErrorNames: ["PhaseAuditValidationError", "ContentFilterError"]
  },
  {
    workflowName: "CompletionAuditWorkflow",
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 4,
    nonRetryableErrorNames: [
      "CompletionAuditValidationError",
      "PhaseAuditsNotAllPassed",
      "ContentFilterError"
    ]
  },
  {
    workflowName: "FinalReleaseWorkflow",
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    maxAttempts: 3
  }
];

/**
 * Temporal-shaped retry-options view of a `RetryPolicyConfig` entry.
 * Workflows feed the result into `proxyActivities({ retry: ... })` so
 * the SDK-neutral policy values land in the right place at the boundary.
 */
export interface TemporalRetryOptions {
  initialInterval: string;
  maximumInterval: string;
  backoffCoefficient: number;
  maximumAttempts: number;
  nonRetryableErrorTypes?: string[];
}

/**
 * Translate a `RetryPolicyConfig` to Temporal's `RetryPolicy` shape
 * accepted by `proxyActivities({ retry: ... })`. Returns the SDK
 * shape using simple `<n> seconds` / `<n> milliseconds` strings so
 * Temporal's parser handles unit normalisation.
 *
 * `nonRetryableErrorNames` is materialized as a fresh mutable array
 * because Temporal's `RetryPolicy.nonRetryableErrorTypes` is typed as
 * a mutable `string[]` under `exactOptionalPropertyTypes`.
 */
export function temporalRetryFromConfig(
  config: RetryPolicyConfig,
): TemporalRetryOptions {
  return {
    initialInterval: `${config.initialDelayMs} milliseconds`,
    maximumInterval: `${config.maxDelayMs} milliseconds`,
    backoffCoefficient: config.backoffMultiplier,
    maximumAttempts: config.maxAttempts,
    ...(config.nonRetryableErrorNames !== undefined &&
    config.nonRetryableErrorNames.length > 0
      ? { nonRetryableErrorTypes: [...config.nonRetryableErrorNames] }
      : {})
  };
}

/**
 * Convenience: look up a policy by workflow name. Throws when no entry
 * matches so a typo is a runtime stack-line, not a silent
 * "no retries ever" footgun.
 */
export function retryPolicyFor(workflowName: string): RetryPolicyConfig {
  const policy = PHASE7_RETRY_POLICIES.find(
    (p) => p.workflowName === workflowName,
  );
  if (!policy) {
    throw new Error(
      `temporal-workflows: no retry policy configured for workflow '${workflowName}'`,
    );
  }
  return policy;
}
