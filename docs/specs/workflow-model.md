# Workflow Model

Temporal is the durable workflow runtime for V1.

## Workflow Set

### `SpecToPlanWorkflow`

Input:

- `SpecDocument`
- `RepoSnapshot`
- request metadata

Output:

- `Plan`
- optional rendered plan artifact

Responsibilities:

- validate the incoming spec payload
- call repo intelligence activities
- generate a structured plan
- persist the plan before rendering any markdown
- emit only the phase list plus phase 1's task partition; later phases'
  tasks are produced by `PhasePartitionWorkflow` after their predecessor
  merges

### `PlanAuditWorkflow`

Input:

- `planId`

Output:

- approved or revision requested

Responsibilities:

- validate task size bounds
- validate dependency graph
- validate ownership conflicts
- validate risk flags and required approvals

Rules:

- allow at most one automatic plan revision
- escalate to human after that

### `PhasePartitionWorkflow`

Input:

- `planId`
- `phaseId`

Output:

- partitioned task set for the phase

Responsibilities:

- runs after the previous phase merges (or at plan start for phase 1)
- reads the post-merge repo snapshot so sizing reflects current state
- enforce file ownership within the phase
- minimize merge conflicts within the phase
- derive deterministic merge order within the phase
- separate the foundational lane (tasks that publish shared contracts) from
  parallel feature lanes

### `TaskExecutionWorkflow`

Input:

- `taskId`

Output:

- task execution result
- branch and worktree assignment
- ready-for-review state

Responsibilities:

- create or attach a worktree lease
- launch implementer
- collect execution metadata
- enforce time and budget limits

### `TaskReviewWorkflow`

Input:

- `taskId`

Output:

- `ReviewReport`

Responsibilities:

- launch independent reviewer
- persist findings
- decide whether fix loop is permitted

### `TaskFixWorkflow`

Input:

- `taskId`
- `reviewReportId`

Output:

- whether the task is ready for another review or blocked

Rules:

- maximum two fix cycles per task

### `PhaseIntegrationWorkflow`

Input:

- `planId`
- `phaseId`

Output:

- `MergeRun` for the phase

Responsibilities:

- merge foundational-lane branches first, then parallel-lane branches in
  dependency order
- run targeted validation after each merge
- rerun downstream checks when shared contracts changed
- publish the phase integration branch to `main` on success

### `PhaseAuditWorkflow`

Input:

- `planId`
- `phaseId`
- request metadata

Output:

- `PhaseAuditReport`
- phase-ready verdict

Responsibilities:

- verify every required task in the phase is merged or explicitly waived
- verify phase-scope acceptance criteria are satisfied
- verify no blocking findings remain open within the phase
- verify the phase integration branch matches the audited head SHA
- gate advancement to phase N+1

Rules:

- independent of implementer claims
- at most one automatic phase re-run before human escalation
- a failed phase audit does not pass remediation to a later phase; the
  current phase is re-entered

### `WorktreeLeaseSweeperWorkflow`

Input:

- none (scheduled)

Output:

- count of leases revoked, count of worktrees cleaned, count of escalations

Responsibilities:

- run on a schedule (default hourly)
- find `WorktreeLease` rows where `expiresAt < now` and `status = 'active'`
- transition them to `expired`, then attempt clean removal of the worktree
- escalate to human when the worktree is dirty or the branch has unpushed work

Rules:

- this workflow never merges, commits, or pushes
- it never touches a worktree whose lease is still active
- it must be idempotent across restarts

### `CompletionAuditWorkflow`

Input:

- `planId`
- `finalPhaseId`
- request metadata

Output:

- `CompletionAuditReport`
- release-readiness verdict

Responsibilities:

- runs once, after the final phase's `PhaseAuditReport` passes
- build a durable source-of-truth view across all phases, all merged
  task state, all review reports, all phase audits, validation artifacts,
  and policy decisions
- verify that required plan-level acceptance criteria are satisfied by
  the cumulative merged result
- verify that no blocking findings or unresolved policy decisions remain
  across any phase
- verify that the generated PR/release summary matches the audited
  merged state

Rules:

- this audit runs plan-wide, after phase audits have already gated each
  phase
- it must be independent of implementer and phase-auditor claims
- it may request follow-up work or mark the plan blocked even after every
  phase has passed its own audit

### `FinalReleaseWorkflow`

Input:

- `planId`
- `completionAuditReportId`

Output:

- final audit state
- PR-ready artifact set

Responsibilities:

- require a passing completion audit before emitting release artifacts
- package the completion source of truth alongside the PR summary
- refuse release finalization when the audit report is stale relative to the
  merged head

## Temporal Determinism

Workflow code is pure orchestration and must be deterministic. The following
are forbidden inside workflow functions:

- LLM calls (always via an activity in `packages/temporal-activities`)
- file system reads or writes
- Postgres reads or writes
- git operations
- network calls of any kind
- `Date.now()`, `Math.random()`, `crypto.randomUUID()` (use workflow-provided equivalents)

Every such call must be an activity. Workflows compose activities, signals,
queries, and timers. The `packages/temporal-workflows` package never imports
from `@anthropic-ai/claude-agent-sdk`, `pg`, `drizzle-orm`, `fs`, or `child_process`.

Violating this produces non-deterministic workflow histories that fail on
replay. Treat the boundary as a durability invariant, not a style preference.

## Idempotency

Every workflow should be resumable and idempotent with respect to durable identifiers:

- spec intake keyed by `specDocument.id`
- plan audit keyed by `planId`
- task execution keyed by `taskId`
- task review keyed by `taskId` plus cycle number
- phase partition keyed by `phaseId`
- phase integration keyed by `phaseId` plus merge attempt number
- phase audit keyed by `phaseId` plus audit attempt number
- completion audit keyed by `planId` plus final phase merged head

## Signals and Queries

Expected control-plane operations:

- request human approval
- cancel task run
- retry blocked task
- extend worktree lease
- query task state
- query merge queue state
- request completion re-audit
- query release readiness state

## Task Lifecycle

Recommended state progression:

1. `pending`
2. `ready`
3. `running`
4. `in_review`
5. `fixing`
6. `ready_to_merge`
7. `merged`

Exceptional states:

- `blocked`
- `failed`

Phase lifecycle runs alongside task lifecycle with states `pending`,
`planning`, `executing`, `integrating`, `auditing`, `completed`, `blocked`,
`failed`. A phase is in `planning` while `PhasePartitionWorkflow` runs,
`executing` while its tasks run and fix loops iterate, `integrating` during
`PhaseIntegrationWorkflow`, `auditing` during `PhaseAuditWorkflow`, and
`completed` only after a passing phase audit.

## Stop Conditions

Execution must stop and escalate when:

- unresolved high-severity findings exceed policy
- task scope violates file ownership
- merge conflicts exceed retry policy
- plan revision count exceeds limit
- dirty worktree conditions appear
- completion audit finds missing acceptance coverage or stale release evidence
- phase re-run count exceeds policy
- foundational lane fails to merge, blocking all parallel lanes in the phase

## Structured Agent Outputs

Planner, plan-auditor, reviewer, and completion-auditor runs must use the
Claude Agent SDK `outputFormat: { type: 'json_schema', schema }` option. The
schema is the JSON-Schema export of the corresponding contract type from
`packages/contracts`:

- planner -> `Plan`
- plan auditor -> `PlanAuditWorkflowResult`
- task reviewer -> `ReviewReport`
- completion auditor -> `CompletionAuditReport`

The adapter rejects any run where the structured-output payload fails
validation against the schema. Free-form text in the assistant message body
is ignored for these roles; the structured payload is the durable record.

Implementer runs are the exception: their primary output is file-system
state in the worktree, not a JSON document, so they do not use
`outputFormat`.

## Completion Source Of Truth

The completion audit should treat these durable records as the source of truth
for "done":

- approved `Plan` and `Task` records
- merged task state and final integration head
- `ReviewReport` records and any still-open findings
- `PhaseAuditReport` records for every completed phase
- validation and test artifacts
- `PolicyDecision` records
- generated release artifacts such as PR summaries

The final verdict should be a structured audit report, not an implicit
interpretation of workflow success alone.
