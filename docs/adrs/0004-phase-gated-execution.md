# ADR 0004: Phase-Gated Execution Model

## Status

Proposed. Supersedes the flat-DAG implication in ADR 0001.

## Context

The original design committed to a full task partition at plan-approval time and integrated everything through one final merge. Sizing tasks for the whole plan up front against pre-execution repo state is speculative; early tasks change the shape of the codebase in ways that invalidate later sizing. A single end-of-plan integration concentrates all merge-conflict and audit risk at one point, making failures expensive to diagnose and roll back. Schema-first discipline also wants shared contracts to merge before work that depends on them; a flat DAG can express this through `DependencyEdge` but does not enforce it as a scheduler primitive. The V1 use case is human-in-the-loop delivery where incremental demoability matters more than raw parallelism.

## Decision

Adopt phase-gated execution. Concretely:

- A `Plan` is decomposed into a sequential list of `Phase` entities.
- Each `Phase` owns its own `Task[]`, `DependencyEdge[]`, `mergeOrder`, and integration branch.
- Inside a phase, execution proceeds `foundational lane` (tasks that publish shared contracts for this phase) first, then `parallel feature lanes` merging in dependency order.
- Each phase has its own integration and its own audit (`PhaseAuditReport`). Advancement to phase N+1 is gated on a passing phase N audit.
- Phase N+1's task partition is produced by `PhasePartitionWorkflow` only after phase N merges, so it sees post-merge repo state.
- A single plan-scoped `CompletionAuditWorkflow` runs after the last phase completes; it audits the cumulative merged result across all phases.
- Phase branches merge to `main` on success, chosen over a stacked integration branch for V1 simplicity.
- Phase-level retry is bounded: at most one automatic phase re-run before human escalation.

Workflow surface changes:

- `TaskPartitionWorkflow` is renamed to `PhasePartitionWorkflow` and runs per phase.
- `IntegrationWorkflow` is renamed to `PhaseIntegrationWorkflow` and runs per phase.
- `PhaseAuditWorkflow` is added.
- `CompletionAuditWorkflow` remains plan-scoped and runs once, at the end of the last phase.
- `FinalReleaseWorkflow` remains plan-scoped.

## Consequences

Positive:

- phase N+1 planning sees real post-merge repo state, which eliminates a large class of plan-rot failures
- foundational lane is a scheduler primitive: shared contracts land before their consumers
- blast radius of a failed integration is one phase, not the whole plan
- each phase is independently demoable, which matches human review cadence
- phase audit reports are durable rollback points distinct from task-level review reports and the final completion audit
- the existing pm-go development plan (`docs/roadmap/action-plan.md`) is itself phase-structured, so the product and its own delivery share a model

Tradeoffs:

- strictly sequential phases reduce theoretical parallelism; phases do not overlap even when they touch disjoint file sets
- more workflow kinds to implement (`PhasePartitionWorkflow`, `PhaseIntegrationWorkflow`, `PhaseAuditWorkflow`)
- the `Plan` contract becomes lazier: only phase 1 tasks exist at plan-approval time, which complicates initial plan rendering
- phase-level retry bounds add another policy knob to document and enforce

## Follow-On Decisions

- define `Phase`, `PhaseAuditReport`, and phase-level dependency edges in `packages/contracts` (planned)
- revise `docs/specs/workflow-model.md` to list the phase-scoped workflows (planned)
- revise `docs/specs/task-routing-and-limits.md` so concurrency caps are expressed per phase rather than per plan (planned)
- decide whether `Plan.dependencyEdges` retains inter-phase edges or moves entirely into `Phase` (recommended: move entirely into `Phase`, since phases are strictly sequential and inter-phase dependencies are implicit in phase ordering)
- decide whether failed phase audits block plan finalization or allow a downstream phase to carry the remediation (recommended: block and remediate within the same phase)
