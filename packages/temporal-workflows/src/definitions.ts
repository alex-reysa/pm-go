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
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult,
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult,
  TaskFixWorkflowInput,
  TaskFixWorkflowResult,
  TaskReviewWorkflowInput,
  TaskReviewWorkflowResult
} from "../../contracts/src/index.js";

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
