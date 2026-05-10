# Workflow Builder Domain

## Purpose

The Workflow Builder is the desktop product surface for understanding and, over
time, safely shaping pm-go delivery workflows.

In the near term it is a graph projection of durable pm-go state: spec intake,
decomposition, plans, phases, tasks, reviews, fix loops, integration, audits,
approvals, budgets, and release evidence. It helps an operator see what exists,
what is running, what is blocked, and what evidence supports each verdict.

In later maturity levels it becomes an authoring surface for approved workflow
templates and, eventually, custom executable workflows. That progression must
not blur the core boundary: the desktop app does not become the orchestrator.
The control plane, database, policy engine, git/worktree layer, and Temporal
workflows remain the source of truth for execution.

## Maturity Levels

### Level 1: Visualize Current Runs

Level 1 is the first Workflow Builder capability, not a required Desktop MVP
capability. The MVP can ship without it. If a Workflow Builder preview appears
during MVP development, it must stay optional, read-only, and secondary to the
run cockpit.

The builder renders the current run as a read-oriented graph backed by durable
pm-go objects. Nodes and edges are derived from existing records and workflow
queries, not from an editable client-side model.

For an MVP preview, graph interactions are navigation and explanation only:
select a node, inspect durable references, and deep-link to the existing
API-backed run sections where actions already live. The graph must not expose
its own Save, override, retry, cancel, lease-extension, run-ready-work,
re-audit, integrate, or release controls. Those controls belong in the cockpit
and focused run sections unless a separate API/product slice adds them.

This level answers:

- What spec, decomposition, plan, phase, task, review, merge, audit, or release
  object am I looking at?
- Which dependency or gate is preventing progress?
- Which Temporal workflow or agent run is responsible for the current activity?
- Which artifacts, policy decisions, findings, SHAs, and approvals support the
  current state?

The graph is a lens over pm-go's run state. It is not a workflow authoring tool
and not the path required to operate the MVP.

### Level 2: Edit Approved Templates

Level 2 introduces editing for approved workflow templates. A template is a
versioned, curated graph pattern that maps to pm-go-recognized orchestration
steps and policy gates. Examples might include a default spec-to-release flow, a
review-heavy high-risk flow, or a documentation-only flow.

Template editing is constrained:

- Templates expose only approved node families and policy knobs.
- Changes are saved as versioned template definitions with provenance.
- A template must validate before it can be used to start or influence a run.
- Template use must still produce normal durable pm-go objects: plans, phases,
  tasks, review reports, merge runs, audit reports, artifacts, and policy
  decisions.

This level is about controlled configuration, not arbitrary orchestration.

### Level 3: Execute Custom Workflows

Level 3 is future work. It allows an operator to author a custom workflow graph
that pm-go can execute after validation, approval, and compilation into
control-plane and Temporal operations.

Custom workflows must preserve all pm-go durability and safety invariants:

- Workflow execution is resumable and idempotent.
- Temporal workflow code remains deterministic.
- LLM, git, filesystem, database, and network effects run through activities or
  control-plane services, not desktop code or Temporal workflow functions.
- Budgets, approvals, leases, file scopes, review policies, phase audits,
  completion audits, and release gates cannot be bypassed by graph design.
- The emitted run still has durable evidence sufficient for review, recovery,
  and release.

This level should be treated as a product and platform capability, not a thin
visual wrapper over arbitrary code execution.

## Core Concepts

### Run Graph

A run graph is a projection of a live or historical pm-go run. It is assembled
from durable records such as `SpecDocument`, `SpecDecomposition`,
`MilestoneManifest`, `Plan`, `Phase`, `Task`, `AgentRun`, `WorktreeLease`,
`ReviewReport`, `MergeRun`, `PhaseAuditReport`, `CompletionAuditReport`,
`PolicyDecision`, and `Artifact`.

The run graph is read-model data. If the graph and the durable records disagree,
the durable records win.

### Template Graph

A template graph is a reusable pattern for a pm-go workflow. It can describe
which steps, gates, and policy options are available before a run begins, but it
does not replace the planner, partitioner, policy engine, or audit workflows.

Templates influence how work is requested and governed. They do not directly
declare that a task is complete, a finding is waived, a merge is safe, or a
release is ready.

### Executable Graph

An executable graph is a future validated workflow definition that can be turned
into control-plane requests, Temporal workflow starts, signals, queries, timers,
and activity-backed operations.

Executable graphs need their own versioning, validation, permissions, and audit
trail. A saved graph is not executable merely because it is drawable.

### Node

A node represents a durable pm-go concept or an approved orchestration step.
Level 1 nodes are derived from existing objects. Later levels may introduce
template nodes and custom workflow nodes, but those node types are intentionally
out of scope for this document.

Node-specific contracts belong in `docs/desktop/07-node-and-workflow-types.md`.

### Edge

An edge represents a relationship that affects ordering, provenance, blocking,
or evidence. Examples include milestone dependencies, task dependency edges,
phase sequence, workflow input/output relationships, review-to-fix loops,
merge-run provenance, audit gates, and artifact citations.

Edges must not invent execution order that pm-go does not honor. For example,
task merge order is derived from the phase dependency graph and merge order, not
from where a user drags a line in the desktop app.

### Gate

A gate is a decision point that can stop or advance work. Gates include plan
audit approval, human approval, budget decisions, review outcomes, phase audit
verdicts, completion audit verdicts, stale audit checks, and final release
eligibility.

Gates are backed by durable reports, policy decisions, or workflow state. They
are not merely visual warnings.

### Evidence

Evidence is the material pm-go uses to decide whether work is done:
review reports, findings, test reports, merge runs, audited SHAs, artifacts,
policy decisions, acceptance criteria, and source-of-truth completion bundles.

The builder should make evidence easy to inspect without changing the rule that
release readiness is determined by the passing `CompletionAuditReport` and the
durable records it cites.

## Mapping Graph Nodes to pm-go Objects

Level 1 nodes should map directly to durable objects or well-known workflow
operations:

| Graph concept | Durable pm-go object or workflow |
| --- | --- |
| Spec intake | `SpecDocument`, `RepoSnapshot`, `SpecToPlanWorkflow` |
| Decomposition | `SpecDecompositionWorkflow`, `SpecDecomposition`, `MilestoneManifest`, `Milestone` |
| Milestone-scoped plan | `Plan` with `decompositionId` and `milestoneId` provenance |
| Plan audit | `PlanAuditWorkflow`, plan status, policy decisions |
| Phase partition | `PhasePartitionWorkflow`, `Phase`, `Task`, `DependencyEdge` |
| Task execution | `TaskExecutionWorkflow`, `Task`, `AgentRun`, `WorktreeLease` |
| Task review | `TaskReviewWorkflow`, `ReviewReport`, stored review commit range |
| Fix loop | `TaskFixWorkflow`, task status, review cycle history |
| Phase integration | `PhaseIntegrationWorkflow`, `MergeRun`, integration worktree lease |
| Phase audit | `PhaseAuditWorkflow`, `PhaseAuditReport` |
| Completion audit | `CompletionAuditWorkflow`, `CompletionAuditReport` |
| Final release | `FinalReleaseWorkflow`, release artifacts, PR-ready output |
| Policy or approval gate | `PolicyDecision`, approval signal, budget/stop-condition state |
| Evidence artifact | `Artifact` and referenced report or bundle |

This mapping should stay conservative. When a graph element cannot be traced to
a durable object, workflow query, signal, or approved template definition, it
should be treated as an annotation rather than executable workflow state.

## Domain Invariants

- Durable state is authoritative. The graph can summarize, filter, and explain
  state, but it cannot be the only record of execution truth.
- Desktop actions go through the control-plane API. The app must not write
  orchestration rows directly or call Temporal as a side channel.
- Temporal remains the durable workflow runtime. Desktop graph changes cannot
  introduce nondeterministic workflow code or move side effects into workflow
  functions.
- Phase order is sequential. Phase N+1 starts only after phase N is integrated
  and passes its phase audit.
- A phase owns its task dependency graph, merge order, integration branch, and
  audit gate.
- Task partitioning owns file scope. Exactly one write-capable task may own a
  file set at a time, and reviewers remain read-only in V1.
- Merge order follows dependency order, not task completion time or visual
  layout.
- Fix loops are bounded by policy, including the current maximum of two fix
  cycles per task.
- High-risk work, budget overages, scope violations, stale audit state, and
  blocked reviews must surface as gates, not disappear into graph styling.
- Release readiness requires a passing completion audit against the merged state.
  A custom or templated workflow cannot skip this requirement.
- Graph versions and template versions need provenance. Operators must be able
  to tell which definition influenced a run.
- Idempotency keys remain durable identifiers such as `specDocument.id`,
  `planId`, `phaseId`, `taskId`, `mergeRunId`, and audited head SHA.

## Relationship to Temporal and the Control Plane

The desktop app talks to pm-go through the control-plane API and event streams.
The API persists state and translates operator intent into Temporal starts,
signals, and queries. Temporal workflows coordinate durable orchestration and
activities perform side effects.

For Level 1, the builder should consume:

- HTTP resources for specs, decompositions, plans, phases, tasks, reviews,
  approvals, budget reports, artifacts, completion state, and release state.
- SSE or event-log updates for live run progress.
- Workflow query results exposed by the API when live orchestration state is not
  fully represented by a persisted row.

For Levels 2 and 3, the builder should submit validated template or workflow
definitions to the control plane. The control plane should own validation,
versioning, permission checks, and compilation into Temporal operations.

The desktop app should never be required to stay open for a workflow to finish.
Closing the desktop app must not cancel durable orchestration. If a future
control-plane cancel endpoint exists, cancellation must be an explicit operator
action through that endpoint.

## Boundaries and Non-Goals

- This document does not define screen layout, component behavior, canvas
  controls, or node-specific schemas.
- The near-term builder is not an arbitrary no-code automation platform.
- The builder is not a replacement for Temporal, the policy engine, the planner,
  the partitioner, the review engine, the integration engine, or audits.
- The builder does not grant direct database mutation, direct git access, or
  direct worktree manipulation.
- The builder does not create unbounded agent hierarchies or runtime-generated
  write-capable roles.
- The builder does not make model-driven merge ordering authoritative.
- The builder does not expand pm-go beyond the current single-repo orchestration
  boundary.
- The builder does not decide release readiness from visual completion alone.
- The builder should avoid exposing every low-level Temporal event as a primary
  product concept; it should show durable pm-go concepts first and drill into
  workflow mechanics only when useful.

## Progressive Disclosure

The domain model supports a clean, focused desktop experience by separating:

- Current state from historical evidence.
- Durable object identity from rendered labels.
- Blocking gates from informational relationships.
- Template intent from run evidence.
- Operator commands from low-level workflow mechanics.

The builder should default to the smallest graph that explains the current
state, then let operators drill into phases, task lanes, reports, agent runs,
tool calls, artifacts, and policy records as needed.

## Open Questions

- What is the first persisted shape for template graphs, and does it live in the
  existing contracts package or a desktop/control-plane-specific package?
- Which Level 1 operator actions are already covered by current APIs, and which
  need new endpoints or workflow signals before desktop can expose them?
- How should graph snapshots be versioned for historical runs when the durable
  object model evolves?
- Should template approval be global, repo-scoped, or organization-scoped?
- What permissions are required to edit a template, start a templated run,
  approve a blocked gate, or execute a future custom workflow?
- How should custom workflow validation report errors: as compile-time template
  diagnostics, policy decisions, or both?
- Which Temporal query results should be promoted into durable rows so the
  desktop app can render historical graphs without depending on live workflow
  histories?
- How much of Layer-A decomposition should be visible in the primary builder
  graph versus behind milestone-level drilldown?
