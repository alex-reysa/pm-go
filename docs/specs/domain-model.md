# Domain Model

This document defines the durable entities that drive planning, execution, review, and integration.

## Authoritative Types

The first implementation source of truth is:

- `packages/contracts/src/plan.ts`
- `packages/contracts/src/execution.ts`
- `packages/contracts/src/review.ts`
- `packages/contracts/src/policy.ts`
- `packages/contracts/src/workflow.ts`

## Core Entities

### `SpecDocument`

Primary user-provided feature or change description.

Required fields:

- `id`
- `title`
- `source`
- `body`
- `createdAt`

### `RepoSnapshot`

Captured repo context used during planning and execution.

Required fields:

- `id`
- `repoRoot`
- `defaultBranch`
- `headSha`
- `languageHints`
- `frameworkHints`
- `buildCommands`
- `testCommands`
- `ciConfigPaths`
- `capturedAt`

### `Plan`

Structured output of spec intake plus repo intelligence.

Required fields:

- `id`
- `specDocumentId`
- `repoSnapshotId`
- `title`
- `summary`
- `status`
- `phases`
- `tasks`
- `risks`
- `createdAt`
- `updatedAt`

Notes:

- `phases` is the authoritative sequence. Dependency edges and merge order are
  owned by each `Phase`, not by the `Plan`.
- `tasks` is the flat projection of all tasks across all phases. It is
  populated lazily as each phase is partitioned and may be empty for phases
  that have not yet started.

### `Phase`

Sequential delivery unit inside a `Plan`. Phases execute one at a time.

Required invariants:

- a phase owns its own dependency graph, merge order, and integration branch
- phase N+1's task partition runs only after phase N merges
- a phase has a foundational lane that publishes shared contracts before any
  parallel feature lane in the same phase starts
- phase advancement is gated by a passing `PhaseAuditReport`
- at most one automatic phase re-run is allowed before human escalation

Required fields:

- `id`
- `planId`
- `index`
- `title`
- `summary`
- `status`
- `integrationBranch`
- `baseSnapshotId`
- `taskIds`
- `dependencyEdges`
- `mergeOrder`
- `phaseAuditReportId`

### `Task`

Unit of work that may be executed independently inside its own branch and worktree.

Required invariants:

- exactly one write-capable task owns a given file set at a time
- task scope must include explicit file boundaries
- task budget and review policy are durable fields, not prompt hints
- branch and worktree assignment are orchestration outputs, not planner guesses

Required fields:

- `id`
- `planId`
- `phaseId`
- `slug`
- `title`
- `summary`
- `kind`
- `status`
- `riskLevel`
- `fileScope`
- `acceptanceCriteria`
- `testCommands`
- `budget`
- `reviewerPolicy`

### `DependencyEdge`

Directed edge between tasks. The dependency graph drives merge order and concurrency.

Rules:

- merge order is derived from this graph
- completion time never overrides dependency order
- cycles are invalid and must fail plan audit

### `ReviewReport`

Independent audit artifact created after implementation.

Rules:

- findings must be structured
- outcome must be explicit
- line references should be attached when available
- the reviewer remains read-only in V1

### `PhaseAuditReport`

Durable audit artifact produced by `PhaseAuditWorkflow` after every phase
integration completes.

Rules:

- it is scoped to a single phase, not the whole plan
- it gates phase advancement to phase N+1
- it must cite evidence artifacts from the phase it audits
- it is distinct from task-level `ReviewReport` and plan-level
  `CompletionAuditReport`

Required fields:

- `id`
- `phaseId`
- `planId`
- `auditorRunId`
- `mergedHeadSha`
- `outcome`
- `checklist`
- `findings`
- `summary`
- `createdAt`

### `CompletionAuditReport`

Final release-readiness audit produced after integration completes.

Rules:

- it is the durable verdict for whether the merged result is actually complete
- it must cite evidence artifacts rather than relying on agent assertions
- it may reopen work by producing structured findings or missing-coverage items

Required fields:

- `id`
- `planId`
- `finalPhaseId`
- `auditorRunId`
- `auditedHeadSha`
- `outcome`
- `checklist`
- `findings`
- `summary`
- `createdAt`

### `PolicyDecision`

Durable record of a gate or stop condition.

Examples:

- human approval required
- budget exceeded
- scope violation
- retry denied

### `AgentRun`

Execution record for planner, implementer, reviewer, integrator, auditor, or
explorer invocation.

Rules:

- depth must be recorded
- executor must be recorded
- prompt version must be recorded
- agent roles are fixed in V1
- every terminated run must record `stopReason` distinct from lifecycle status
- structured-output runs must record `outputFormatSchemaRef` for auditability

Required fields:

- `id`
- `workflowRunId`
- `role`
- `depth`
- `status`
- `executor`
- `model`
- `promptVersion`
- `permissionMode`

Additional durable fields (populated during or at completion of the run):

- `sessionId` (from SDK, required for resume)
- `parentSessionId` (set when this run was forked from another)
- `budgetUsdCap`
- `maxTurnsCap`
- `turns`
- `inputTokens`
- `outputTokens`
- `cacheCreationTokens`
- `cacheReadTokens`
- `costUsd`
- `stopReason`
- `outputFormatSchemaRef`

### `WorktreeLease`

Lease record for a task worktree.

Rules:

- a worktree lease must have an expiration time
- expired leases should trigger cleanup or human review
- reviewers do not receive write-capable leases

### `MergeRun`

Record of integration activity across one or more completed tasks.

### `Artifact`

Durable reference to rendered markdown, logs, reports, test results, or PR summary output.

The release-readiness source of truth should be reconstructable from artifacts
plus the structured records they cite. In practice that means the completion
audit report should point back to the plan, merged task set, validation results,
policy decisions, and release summary it verified.

## Database Projection

Recommended initial tables:

- `spec_documents`
- `repo_snapshots`
- `plans`
- `phases`
- `plan_tasks`
- `task_dependencies`
- `agent_runs`
- `worktree_leases`
- `review_reports`
- `phase_audit_reports`
- `completion_audit_reports`
- `merge_runs`
- `policy_decisions`
- `artifacts`

## Required Invariants

1. Agents do not invent merge order.
2. Implementers do not merge their own work.
3. Reviewers are independent from implementers.
4. If a task exceeds scope, the system re-partitions instead of expanding task bounds.
5. Rendered markdown never replaces the underlying structured object.
6. Workflow success does not equal completion until a completion audit passes.
7. File ownership is enforced by two named checks: `plan_audit.fileScope.disjoint` (pairwise disjointness of `Task.fileScope.includes` across all tasks in a plan, validated during plan audit) and `task_review.fileScope.diff` (worktree diff against base SHA at `ready_for_review`, validated during task review — any changed file outside `fileScope.includes` blocks the task).
8. Agent runs are resumable only when `AgentRun.sessionId` is persisted. A run without a recorded `sessionId` is treated as non-resumable and must be re-executed from scratch.
9. Phases execute sequentially. Phase N+1 does not begin until phase N merges and phase N's `PhaseAuditReport` passes.
10. Inside a phase, the foundational lane (tasks that publish shared contracts for the phase) merges before any parallel feature lane starts. This is a scheduler primitive, not a review-time check.
