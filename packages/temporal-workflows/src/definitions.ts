import type {
  FinalReleaseWorkflowInput,
  FinalReleaseWorkflowResult,
  IntegrationWorkflowInput,
  IntegrationWorkflowResult,
  CompletionAuditWorkflowInput,
  CompletionAuditWorkflowResult,
  PlanAuditWorkflowInput,
  PlanAuditWorkflowResult,
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult,
  TaskExecutionWorkflowInput,
  TaskExecutionWorkflowResult,
  TaskFixWorkflowInput,
  TaskFixWorkflowResult,
  TaskPartitionWorkflowInput,
  TaskPartitionWorkflowResult,
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

export const TASK_PARTITION_WORKFLOW: WorkflowDefinition<
  TaskPartitionWorkflowInput,
  TaskPartitionWorkflowResult
> = {
  name: "TaskPartitionWorkflow",
  description: "Split an approved plan into bounded, worktree-safe tasks."
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

export const INTEGRATION_WORKFLOW: WorkflowDefinition<
  IntegrationWorkflowInput,
  IntegrationWorkflowResult
> = {
  name: "IntegrationWorkflow",
  description: "Merge completed task branches in deterministic dependency order."
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
