# Node and Workflow Types

## Purpose

This document defines product and domain type shapes for the future desktop
Workflow Builder. The shapes are TypeScript-like sketches for documentation,
not implementation code. They describe an optional Level 1 preview and future
builder work; they are not required for the Desktop MVP operator loop.

The authoritative durable contracts remain the existing pm-go types in
`packages/contracts/src/*` and the workflow rules in `docs/specs/*`. The
builder may project those records into graph nodes and edges, but the graph
does not replace `SpecDocument`, `RepoSnapshot`, `SpecDecomposition`, `Plan`,
`Phase`, `Task`, `ReviewReport`, `MergeRun`, `PhaseAuditReport`,
`CompletionAuditReport`, `PolicyDecision`, `ApprovalRequest`, `BudgetReport`,
`AgentRun`, `WorktreeLease`, or `Artifact`.

## Type Lifecycle

| Shape | Status | Persistence |
| --- | --- | --- |
| `WorkflowRunGraph` | Optional Level 1 read-model projection | Derived from durable pm-go records, workflow queries, and event streams. It may be cached, but it is not authoritative. |
| `WorkflowNode`, `WorkflowEdge`, `NodeInput`, `NodeOutput`, `NodeStatus`, `NodeEvent`, `Gate`, `EvidenceRef` | Optional Level 1 read-model projection | Derived in Level 1. The same vocabulary can be reused by template definitions later, but runtime truth still comes from durable records. |
| Canonical node type definitions | Projection vocabulary | The node type names are stable product concepts. In Level 1 they describe existing state; they do not create new execution semantics. |
| `WorkflowTemplate` | Future persisted template type | Level 2. Curated, approved workflow pattern. Not required for the Desktop MVP or optional Level 1 preview. |
| `WorkflowTemplateVersion` | Future persisted template/custom-workflow type | Level 2 for approved templates; Level 3 for validated executable custom workflow definitions. |

In Level 1, "executable" means the node may identify an existing
control-plane action and deep-link to the run section that owns it. The desktop
graph itself is never the executor. An MVP preview must not expose graph-owned
Save, override, retry, cancel, lease-extension, run-ready-work, re-audit,
integrate, or release controls.

## Shared Type Sketches

```ts
type UUID = string;
type ISODateTime = string;

type WorkflowGraphKind =
  | "run_projection"       // MVP Level 1
  | "template_definition"  // future Level 2
  | "executable_definition"; // future Level 3

type WorkflowTemplateStatus =
  | "draft"
  | "approved"
  | "deprecated"
  | "archived";

type WorkflowTemplateVersionStatus =
  | "draft"
  | "validating"
  | "approved"
  | "rejected"
  | "retired";

type WorkflowNodeType =
  | "Spec"
  | "RepoSnapshot"
  | "SpecDecomposition"
  | "PlanCreation"
  | "PlanReviewGate"
  | "PhasePartition"
  | "TaskGroup"
  | "ImplementTask"
  | "ReviewTask"
  | "FixLoop"
  | "PhaseIntegration"
  | "PhaseAudit"
  | "CompletionAudit"
  | "Release"
  | "HumanApprovalGate"
  | "BudgetGate"
  | "Artifact";

type Level1NodeMode =
  | "visual_only"
  | "deep_link_to_api_action";

type NodeStatus =
  | "unknown"
  | "not_started"
  | "waiting"
  | "ready"
  | "running"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "failed"
  | "completed"
  | "skipped"
  | "stale";

type WorkflowEdgeKind =
  | "phase_sequence"
  | "task_dependency"
  | "merge_order"
  | "input"
  | "output"
  | "provenance"
  | "gate"
  | "fix_loop"
  | "evidence"
  | "policy_block";

type NodePortValueKind =
  | "durable_ref"
  | "artifact_ref"
  | "policy_ref"
  | "workflow_result"
  | "scalar"
  | "collection";

type GateKind =
  | "plan_review"
  | "human_approval"
  | "budget"
  | "task_review"
  | "phase_audit"
  | "completion_audit"
  | "release_freshness"
  | "scope"
  | "retry_policy";

type GateStatus =
  | "not_applicable"
  | "pending"
  | "passed"
  | "failed"
  | "blocked"
  | "waived"
  | "stale";

type DurableRefKind =
  | "SpecDocument"
  | "RepoSnapshot"
  | "SpecDecomposition"
  | "MilestoneManifest"
  | "Milestone"
  | "Plan"
  | "Phase"
  | "Task"
  | "DependencyEdge"
  | "AgentRun"
  | "WorktreeLease"
  | "ReviewReport"
  | "StoredReviewReport"
  | "MergeRun"
  | "PhaseAuditReport"
  | "CompletionAuditReport"
  | "PolicyDecision"
  | "ApprovalRequest"
  | "BudgetReport"
  | "Artifact"
  | "WorkflowQuery"
  | "EventLog";
```

### Future Persisted Template Types

`WorkflowTemplate` is a future Level 2 catalog entry. It names a curated
workflow pattern and points at approved versions. It does not hold runtime
state.

```ts
interface WorkflowTemplate {
  id: UUID;
  name: string;
  summary: string;
  status: WorkflowTemplateStatus;
  currentVersionId?: UUID;
  owner: "system" | "organization" | "repo";
  tags: string[];
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

`WorkflowTemplateVersion` is a future persisted definition. In Level 2 it
contains approved template intent. In Level 3 it may contain a custom workflow
definition only after validation, approval, and compilation by the control
plane. It must not contain live run status.

```ts
interface WorkflowTemplateVersion {
  id: UUID;
  templateId: UUID;
  version: number;
  status: WorkflowTemplateVersionStatus;
  graphKind: "template_definition" | "executable_definition";
  graph: WorkflowTemplateGraph;
  policyKnobs: Record<string, unknown>;
  validationErrors: WorkflowTemplateDiagnostic[];
  approvedBy?: string;
  approvedAt?: ISODateTime;
  createdBy: string;
  createdAt: ISODateTime;
}

interface WorkflowTemplateGraph {
  nodes: WorkflowTemplateNode[];
  edges: WorkflowTemplateEdge[];
  gates: WorkflowTemplateGate[];
}

interface WorkflowTemplateNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  summary?: string;
  requiredInputs: NodeInput[];
  expectedOutputs: NodeOutput[];
  policyKnobs: Record<string, unknown>;
  inspectorFields: string[];
}

interface WorkflowTemplateEdge {
  id: string;
  kind: WorkflowEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  required: boolean;
  reason: string;
  order?: number;
}

interface WorkflowTemplateGate {
  id: string;
  kind: GateKind;
  subjectNodeId: string;
  required: boolean;
  blocksNodeIds: string[];
  reason: string;
  policyKnobs: Record<string, unknown>;
}

interface WorkflowTemplateDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  gateId?: string;
  severity: "error" | "warning";
}
```

### Optional Level 1 Run Projection Types

`WorkflowRunGraph` is the Level 1 graph returned to the desktop app if the
optional preview is implemented. It is a snapshot of current or historical run
state. If any field conflicts with a durable record, the durable record wins.

```ts
interface WorkflowRunGraph {
  id: UUID;
  graphKind: "run_projection";
  readModelVersion: string;

  specDocumentId?: UUID;
  repoSnapshotId?: UUID;
  decompositionId?: UUID;
  planId?: UUID;
  milestoneId?: string;
  templateVersionId?: UUID; // populated only for future templated runs

  status: NodeStatus;
  generatedAt: ISODateTime;
  sourceUpdatedAt?: ISODateTime;

  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  gates: Gate[];
  evidence: EvidenceRef[];
  events: NodeEvent[];
  diagnostics: WorkflowRunGraphDiagnostic[];
}

interface WorkflowRunGraphDiagnostic {
  code: string;
  message: string;
  durableRef?: EvidenceRef;
  severity: "info" | "warning" | "error";
}
```

`WorkflowNode` is a graph projection of either a durable object, an existing
workflow operation, or a future approved template step.

```ts
interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  summary?: string;
  status: NodeStatus;
  level1Mode: Level1NodeMode;

  primaryRef?: EvidenceRef;
  durableRefs: EvidenceRef[];
  inputs: NodeInput[];
  outputs: NodeOutput[];
  gates: Gate[];
  evidenceRefs: EvidenceRef[];
  events: NodeEvent[];

  phaseId?: UUID;
  taskId?: UUID;
  planId?: UUID;
  order?: number;

  /**
   * Domain fields worth inspecting for this node. This is not a UI layout
   * contract; it is a stable list of source fields the product should expose.
   */
  inspector: Record<string, unknown>;
}
```

`WorkflowEdge` connects nodes for ordering, dependency, provenance, gate, and
evidence relationships. Level 1 edges must be derived from durable records or
workflow state, not hand-drawn client intent.

```ts
interface WorkflowEdge {
  id: string;
  kind: WorkflowEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  required: boolean;
  reason: string;
  order?: number;
  durableRef?: EvidenceRef;
  evidenceRefs: EvidenceRef[];
}
```

`NodeInput` and `NodeOutput` describe conceptual domain dependencies. They are
not runtime data channels in Level 1.

```ts
interface NodeInput {
  id: string;
  name: string;
  valueKind: NodePortValueKind;
  typeRef: string;
  required: boolean;
  sourceNodeId?: string;
  sourceOutputId?: string;
  durableRef?: EvidenceRef;
  evidenceRefs: EvidenceRef[];
}

interface NodeOutput {
  id: string;
  name: string;
  valueKind: NodePortValueKind;
  typeRef: string;
  durableRefs: EvidenceRef[];
  evidenceRefs: EvidenceRef[];
}
```

`Gate` represents a real decision point that can block progress. In Level 1 it
must be backed by a durable report, policy decision, approval request, budget
report, or workflow state.

```ts
interface Gate {
  id: string;
  kind: GateKind;
  subjectNodeId: string;
  status: GateStatus;
  required: boolean;
  blocksNodeIds: string[];
  reason: string;

  policyDecisionId?: UUID;
  approvalRequestId?: UUID;
  reportId?: UUID;
  artifactId?: UUID;

  openedAt?: ISODateTime;
  decidedAt?: ISODateTime;
  decidedBy?: "system" | "human";
  evidenceRefs: EvidenceRef[];
}
```

`EvidenceRef` is a pointer, not embedded evidence. The desktop app can use it
to fetch the authoritative record or artifact through the control-plane API.

```ts
interface EvidenceRef {
  id: string;
  kind: DurableRefKind;
  durableId?: UUID;
  artifactId?: UUID;
  uri?: string;
  title: string;
  createdAt?: ISODateTime;
  sha?: string;
  subjectType?: "spec" | "repo" | "plan" | "phase" | "task" | "merge" | "review" | "release";
  subjectId?: UUID;
}
```

`NodeEvent` is a read-model event for graph timelines and status changes. It is
derived from persisted event logs, workflow queries, durable row updates, or
artifact creation. It is not the source of truth for status.

```ts
interface NodeEvent {
  id: string;
  nodeId: string;
  kind:
    | "created"
    | "status_changed"
    | "workflow_started"
    | "workflow_completed"
    | "gate_opened"
    | "gate_decided"
    | "artifact_created"
    | "evidence_added"
    | "policy_blocked"
    | "retry_requested"
    | "approval_received"
    | "release_emitted";
  occurredAt: ISODateTime;
  status?: NodeStatus;
  actor: "system" | "human" | "agent" | "workflow";
  message: string;
  durableRef?: EvidenceRef;
  evidenceRefs: EvidenceRef[];
}
```

## Canonical Node Types

The following node types are the canonical vocabulary for the builder. Level 1
nodes are projections over existing records and workflow operations. Future
templates may reuse the same node types, but template validity still depends on
control-plane validation.

### `Spec`

- Purpose: Represents the user-provided change request.
- Inputs: None inside the graph. The source is manual or imported intake.
- Outputs: `SpecDocument` evidence and source-section references for later decomposition.
- Maps to: `SpecDocument`; input to `SpecDecompositionWorkflow` and `SpecToPlanWorkflow`.
- Level 1 mode: Visual-only. Spec creation/import is an API workflow outside the graph node.
- Key inspector fields: `id`, `title`, `source`, `createdAt`, body summary or hash, linked decomposition ids, linked plan ids.
- Failure modes: Missing or deleted spec, invalid or empty body, downstream ambiguity, decomposition or planning row references a different `specDocumentId`.

### `RepoSnapshot`

- Purpose: Captures repository state and planning/execution hints bound to a run.
- Inputs: Repository root, default branch, head SHA, manifests, command discovery.
- Outputs: `RepoSnapshot` evidence with language hints, framework hints, build commands, test commands, manifest paths, and capture time.
- Maps to: `RepoSnapshot`.
- Level 1 mode: Visual-only.
- Key inspector fields: `repoRoot`, `repoUrl`, `defaultBranch`, `headSha`, `languageHints`, `frameworkHints`, `manifestPaths`, `buildCommands`, `testCommands`, `ciConfigPaths`, `capturedAt`.
- Failure modes: Missing snapshot, stale snapshot relative to current repository head, inaccessible repository, missing build/test command discovery, plan or decomposition references the wrong snapshot.

### `SpecDecomposition`

- Purpose: Turns a spec into an ordered Layer-A `MilestoneManifest`.
- Inputs: `SpecDocument`, `RepoSnapshot`, `requestedBy`, API-supplied `decompositionId`.
- Outputs: `SpecDecomposition`, `MilestoneManifest`, ordered milestones, deferred scope.
- Maps to: `SpecDecompositionWorkflow`, `SpecDecomposition`, `MilestoneManifest`, `Milestone`.
- Level 1 mode: Deep-link to an API-backed run section when the API allows create/retry; otherwise observed workflow state. Retry controls are future unless the current API exposes them.
- Key inspector fields: `status`, `decompositionId`, `manifest.milestones`, `deferredScope`, `planFirstStartedAt`, `errorReason`, `createdAt`, `updatedAt`.
- Failure modes: Decomposer failure, invalid structured output, milestone dependency cycle, milestone dependency points forward, unhandled spec scope, manifest locked after `planFirstStartedAt`, workflow result not persisted.

### `PlanCreation`

- Purpose: Produces a structured `Plan` for a full spec or one milestone.
- Inputs: `SpecDocument`, `RepoSnapshot`, optional `MilestoneContext`, `requestedBy`, API-supplied `planId`.
- Outputs: `Plan` and optional `plan_markdown` artifact.
- Maps to: `SpecToPlanWorkflow`, `Plan`, `Artifact(kind: "plan_markdown")`.
- Level 1 mode: Deep-link to API-backed plan creation when permitted. Retry controls are future unless the current API exposes them.
- Key inspector fields: `planId`, `status`, `title`, `summary`, `decompositionId`, `milestoneId`, `predecessorPlanId`, `autoApproveLowRisk`, phase count, phase 1 task count.
- Failure modes: Planner structured-output validation failure, planner timeout or budget failure, missing phase list, missing phase 1 partition, provenance mismatch, rendered artifact failure, plan row never reaches durable storage.

### `PlanReviewGate`

- Purpose: Validates the plan before execution and records required revisions or approvals.
- Inputs: `Plan`, phase structure, phase 1 task partition, risks, file scopes, dependency graph, operating limits.
- Outputs: `PlanAuditWorkflowResult`, plan status changes, policy decisions, approval requests when required.
- Maps to: `PlanAuditWorkflow`, `Plan.status`, `PolicyDecision`, `ApprovalRequest`.
- Level 1 mode: Deep-link to API-backed audit or human approval where the API supports it. Retry controls are future unless the current API exposes them.
- Key inspector fields: plan status, audit verdict, revision count, phase 1 dependency graph validity, file-scope conflicts, high-risk items, `requiresHumanApproval`, policy decision ids, approval request ids.
- Failure modes: Plan revision limit exceeded, phase dependency invalid, task dependency cycle, file ownership conflict, high-risk work lacks approval, human approval rejected, audit workflow failed or did not persist verdict.

### `PhasePartition`

- Purpose: Materializes the task set, dependency graph, and merge order for one phase.
- Inputs: `Plan`, `Phase`, previous phase audited head or initial repo snapshot, current phase boundaries.
- Outputs: `Task[]`, `DependencyEdge[]`, `Phase.taskIds`, `Phase.mergeOrder`, task file scopes.
- Maps to: `PhasePartitionWorkflow`, `Phase`, `Task`, `DependencyEdge`.
- Level 1 mode: Observed workflow state unless a future API exposes partitioning controls.
- Key inspector fields: `phaseId`, `index`, `status`, `baseSnapshotId`, task count, foundational-lane tasks, dependency edges, merge order, file-scope disjointness, branch fan-out.
- Failure modes: Previous phase has not passed audit, partitioner structured-output failure, dependency cycle, overlapping file scopes, oversized task, branch fan-out exceeds policy, stale base snapshot.

### `TaskGroup`

- Purpose: Groups task nodes for a phase or lane so operators can reason about concurrency, blockers, and merge order.
- Inputs: `Phase.taskIds`, `Phase.dependencyEdges`, `Phase.mergeOrder`, task statuses.
- Outputs: No durable object. It summarizes child `Task` nodes and dependency edges.
- Maps to: `Phase`, `Task[]`, `DependencyEdge[]`.
- Level 1 mode: Visual-only.
- Key inspector fields: `phaseId`, phase index, task counts by status and risk, blocked dependency edges, foundational-lane tasks, merge order, current ready-to-run set.
- Failure modes: Missing task rows, dependency edge references an unknown task, task belongs to a different phase, merge order omits required tasks, group status conflicts with durable task status.

### `ImplementTask`

- Purpose: Runs the implementer for a single task in an isolated branch and worktree.
- Inputs: `Task`, repo roots, worktree root, max lifetime, requested user, budget, file scope.
- Outputs: `AgentRun`, `WorktreeLease`, branch/worktree assignment, changed files, task status, test or patch artifacts.
- Maps to: `TaskExecutionWorkflow`, `Task`, `AgentRun`, `WorktreeLease`, `Artifact`, `PolicyDecision`.
- Level 1 mode: Deep-link to the task run action where the current API supports it. Retry, cancel, and lease extension are future actions unless explicit API endpoints are added.
- Key inspector fields: `taskId`, `kind`, `status`, `riskLevel`, `sizeHint`, `fileScope`, `acceptanceCriteria`, `testCommands`, `budget`, `reviewerPolicy`, branch name, lease id/status, agent run id/status, changed files, file-scope violations, stop reason.
- Failure modes: Budget exceeded, file-scope violation, ignored artifact committed, implementer timeout, agent failure, canceled run, dirty or expired lease, missing session id for resume, test failure, task blocked by upstream dependency.

### `ReviewTask`

- Purpose: Performs independent read-only review of implemented task changes.
- Inputs: `Task`, implementation commit range, reviewer policy, current branch/head, previous review cycle if any.
- Outputs: `StoredReviewReport`, findings, outcome, review artifact, task status change.
- Maps to: `TaskReviewWorkflow`, `ReviewReport`, `StoredReviewReport`, reviewer `AgentRun`, `Artifact(kind: "review_report")`.
- Level 1 mode: Deep-link to the task review action where the current API supports it. Retry is future unless an explicit API endpoint is added.
- Key inspector fields: review outcome, finding count by severity, `cycleNumber`, `reviewedBaseSha`, `reviewedHeadSha`, reviewer run id/status, `strictness`, skipped-review policy decision id when applicable.
- Failure modes: Changes requested, blocked review, high-severity findings exceed policy, reviewer structured-output failure, reviewer timeout, stale commit range, review skipped without durable policy decision.

### `FixLoop`

- Purpose: Represents bounded repair cycles after a review requests changes.
- Inputs: `Task`, triggering `ReviewReport`, current cycle number, `maxReviewFixCycles`, retry policy.
- Outputs: Updated branch state, new review request, `TaskFixWorkflowResult`, retry policy decision.
- Maps to: `TaskFixWorkflow`, `Task.status`, review history, implementer `AgentRun`, `PolicyDecision(decision: "retry_allowed" | "retry_denied")`.
- Level 1 mode: Deep-link to the task fix action where the current API supports it. Retry is future unless an explicit API endpoint is added.
- Key inspector fields: current cycle, maximum cycles, triggering report id, open findings, retry verdict, last implementer run, next review requirement.
- Failure modes: Maximum fix cycles exceeded, retry denied, fix run fails, new scope violation, review still requests changes, task becomes blocked, stale review report used as fix input.

### `PhaseIntegration`

- Purpose: Merges ready tasks for a phase into the phase integration branch in dependency order.
- Inputs: `Plan`, `Phase`, ready-to-merge tasks, `Phase.mergeOrder`, integration worktree lease.
- Outputs: `MergeRun`, `integrationHeadSha`, merged task statuses, validation artifacts.
- Maps to: `PhaseIntegrationWorkflow`, `MergeRun`, `WorktreeLease(kind: "integration")`, `Artifact`.
- Level 1 mode: Deep-link to phase integration where the current API supports it.
- Key inspector fields: `mergeRunId`, `baseSha`, `integrationBranch`, `mergedTaskIds`, `failedTaskId`, `integrationHeadSha`, merge order, validation artifact ids, integration lease id/status.
- Failure modes: Required task not ready, merge conflict, foundational-lane failure, validation failure, ignored artifact committed, task merged out of order, integration lease expired, merge run missing final head.

### `PhaseAudit`

- Purpose: Audits one integrated phase and gates advancement to the next phase.
- Inputs: `Plan`, `Phase`, `MergeRun`, merged task evidence, review reports, validation artifacts.
- Outputs: `PhaseAuditReport`, phase-ready verdict, phase status update.
- Maps to: `PhaseAuditWorkflow`, `PhaseAuditReport`, `Phase.phaseAuditReportId`.
- Level 1 mode: Deep-link to phase audit where the current API supports it. Re-audit aliases are future unless explicit API endpoints are added.
- Key inspector fields: report id, outcome, `mergedHeadSha`, checklist status, findings, summary, auditor run id, audited merge run id, automatic phase re-run count.
- Failure modes: Missing required merged task, missing waiver evidence, stale merge run or head SHA, blocking finding, phase acceptance criteria not satisfied, automatic phase re-run exhausted, auditor structured-output failure.

### `CompletionAudit`

- Purpose: Performs plan-wide release-readiness audit after the final phase passes.
- Inputs: `Plan`, final `Phase`, final `MergeRun`, all phase audits, review reports, validation artifacts, policy decisions, release summary evidence.
- Outputs: `CompletionAuditReport`, ready-for-release verdict, completion evidence bundle.
- Maps to: `CompletionAuditWorkflow`, `CompletionAuditReport`, `Artifact(kind: "completion_evidence_bundle")`, `Artifact(kind: "completion_audit_report")`.
- Level 1 mode: Deep-link to completion audit where the current API supports it. Re-audit aliases are future unless explicit API endpoints are added.
- Key inspector fields: report id, outcome, `auditedHeadSha`, checklist, acceptance criteria passed/missing, open finding ids, unresolved policy decision ids, auditor run id, evidence artifact ids.
- Failure modes: Missing acceptance coverage, open blocking findings, unresolved policy decisions, stale audit relative to final integration head, final phase audit not passing, evidence bundle missing, auditor structured-output failure.

### `Release`

- Purpose: Produces final release or PR-ready artifacts after a passing completion audit.
- Inputs: `Plan`, passing `CompletionAuditReport`, current audited head, completion source-of-truth artifact.
- Outputs: `sourceOfTruthArtifactId`, output artifact ids, optional pull request URL.
- Maps to: `FinalReleaseWorkflow`, `FinalReleaseWorkflowResult`, `Artifact(kind: "completion_evidence_bundle")`, `Artifact(kind: "pr_summary")`.
- Level 1 mode: Deep-link to release where the current API supports it.
- Key inspector fields: `completionAuditReportId`, audited head SHA, source-of-truth artifact id, output artifact ids, PR summary artifact id, pull request URL, release freshness gate.
- Failure modes: Completion audit absent or not passing, audit stale relative to merged head, unresolved policy decision, missing release artifact, PR creation failure, permission failure.

### `HumanApprovalGate`

- Purpose: Blocks high-risk or policy-sensitive plan/task work until a human decision is recorded.
- Inputs: `Plan` or `Task`, risk information, approval policy, existing approval request if present.
- Outputs: `ApprovalRequest` status, `PolicyDecision`, `approve` signal to waiting workflow when approved.
- Maps to: `ApprovalRequest`, `ApprovalDecision`, `PolicyDecision`, `approveSignal`.
- Level 1 mode: Deep-link to approve where the current API supports it. Reject is future unless an explicit API endpoint is added.
- Key inspector fields: subject type/id, risk band, status, requested by, approved by, requested at, decided at, reason, related policy decision id.
- Failure modes: Pending approval blocks execution, rejected approval blocks execution, unauthorized operator, stale approval request, wrong subject id, workflow signal not delivered or not observed.

### `BudgetGate`

- Purpose: Stops task or plan progress when spend exceeds durable task or operating limits.
- Inputs: `Task.budget`, `AgentRun` spend, `BudgetReport`, operating limits.
- Outputs: `BudgetDecision`, `BudgetReport`, `PolicyDecision(decision: "budget_exceeded")`.
- Maps to: `evaluateBudgetGate`, `BudgetReport`, `PolicyDecision`, `TaskBudget`, `AgentRun`.
- Level 1 mode: Visual-only enforcement indicator unless a future explicit override command exists. The control plane enforces the gate.
- Key inspector fields: task budget caps, accrued USD, tokens, wall-clock minutes, overrun dimensions, budget report id, generated at, blocking policy decision id.
- Failure modes: Budget exceeded, spend report missing or stale, agent run usage not recorded, retry denied, task blocked without a visible policy decision.

### `Artifact`

- Purpose: References durable evidence such as rendered plans, reports, logs, tests, patch bundles, diagnostics, release summaries, and completion bundles.
- Inputs: Workflow outputs, agent outputs, validation results, audit reports.
- Outputs: Durable `Artifact` reference.
- Maps to: `Artifact`.
- Level 1 mode: Visual-only.
- Key inspector fields: `id`, `kind`, `uri`, `planId`, `taskId`, `createdAt`, linked report id, linked node ids, linked evidence refs.
- Failure modes: Missing artifact row, inaccessible URI, unsupported artifact kind, artifact lacks the structured durable record it claims to summarize, stale artifact relative to audited head.

## Validation Rules and Invariants

### Source of Truth

- Durable records win over graph state. `WorkflowRunGraph` is invalid if it
  contradicts persisted pm-go rows or workflow query state.
- Rendered markdown, graph labels, and node events never replace structured
  records.
- Level 1 graph edits cannot mutate orchestration state. Operator actions must
  call the control-plane API, which owns persistence, policy checks, and
  Temporal starts/signals/queries.

### Phase and Task Order

- Phase order is sequential. Phase N+1 cannot partition or execute until phase
  N has integrated and its `PhaseAuditReport` passes.
- A phase owns its task dependency graph, merge order, integration branch, and
  audit gate.
- Task dependency edges must be acyclic and scoped to the owning phase unless a
  future contract explicitly introduces cross-phase task dependencies.
- The foundational lane merges before parallel feature lanes in the same phase.
- Merge order follows `Phase.mergeOrder` and dependency order. Completion time,
  visual layout, drag order, or model preference cannot override it.

### Gates and Policy

- The graph cannot bypass policy. Required gates must be present and blocking
  when their durable state is pending, failed, stale, or rejected.
- Human approvals must be represented by `ApprovalRequest` and/or
  `PolicyDecision` rows. A visual approval marker is not enough.
- Budget gates must cite budget inputs: task budget caps, agent-run spend,
  budget reports, or a blocking `PolicyDecision`.
- Scope violations, review-cycle exhaustion, high-severity findings, stale
  audits, retry denials, and budget overages surface as gates or diagnostics,
  not as hidden styling.
- Fix loops are bounded by policy, including the current maximum of two fix
  cycles per task.

### Evidence

- Every gate verdict should cite durable evidence: report ids, policy decision
  ids, approval request ids, artifact ids, or audited SHAs.
- Review nodes must preserve reviewed commit range when available through the
  stored review shape: `cycleNumber`, `reviewedBaseSha`, and
  `reviewedHeadSha`.
- Phase audits must cite the `MergeRun` they audited and the resulting
  `mergedHeadSha`.
- Completion audits must cite the final phase, final merge run, audited head
  SHA, checklist, findings, unresolved policy decisions, and evidence bundle.

### Release

- Release requires a passing `CompletionAuditReport`.
- The completion audit freshness relative to the merged head should be shown
  when the data is available. Until the server/API enforces freshness as a
  release precondition, Desktop must not create a client-only release blocker
  beyond the current API contract: latest stamped completion audit outcome
  `pass`.
- Release artifacts summarize the source-of-truth evidence; they do not create
  the release verdict.

### Template and Custom Workflow Validation

- `WorkflowTemplate` and `WorkflowTemplateVersion` are future persisted types.
  They must not be treated as MVP requirements.
- A template can expose only approved node families and policy knobs.
- A template version must validate before it can start or influence a run.
- Future executable definitions must compile into control-plane and Temporal
  operations. Desktop code must not perform LLM calls, git operations,
  database writes, filesystem writes, network effects, or direct Temporal
  side-channel execution.
- A custom workflow cannot remove required pm-go gates: plan review, task
  review or durable review-skip policy, human approvals, budget gates, phase
  audits, completion audit, and release freshness checks.
- Template and executable graph versions need provenance: creator, approver,
  version number, validation diagnostics, and the version id attached to any
  run they influence.

### Idempotency and Identity

- Node ids in `WorkflowRunGraph` may be graph-local, but every durable node
  must carry a stable `EvidenceRef` to the authoritative row.
- Idempotency remains keyed by durable ids such as `specDocument.id`,
  `decompositionId`, `planId`, `phaseId`, `taskId`, `mergeRunId`,
  `reviewReportId`, `completionAuditReportId`, and audited head SHA.
- Cached run graphs must include `readModelVersion` and generation timestamps
  so stale projections can be detected and rebuilt.
