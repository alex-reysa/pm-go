# MVP Milestones

Use [action-plan.md](./action-plan.md) as the execution document. This file remains the higher-level milestone view.

## Status snapshot

- Milestones 0–4 **complete**. The execution half of the MVP is done and
  end-to-end-verified by `pnpm smoke:phase5` (2-phase plan → integration
  → audit → completion → release in ~20s on stub mode).
- Milestone 5 (Operator UI) is the active next milestone — it maps to
  Phase 6 in `action-plan.md`.
- Milestone 6 (Policy engine hardening) follows Milestone 5.

## Milestone 0: Repository Bootstrap

Status: **complete**.

Deliverables:

- monorepo layout
- shared contract package
- core architecture and policy docs

Exit criteria:

- repo structure is stable enough to start implementation without re-laying foundations

## Milestone 1: Planner And Contracts

Status: **complete** (Phases 1a, 1b, 2 in action-plan.md).

Deliverables:

- completed domain schema package
- repo snapshot collector
- plan generator
- plan markdown renderer
- plan audit checks

Exit criteria:

- a spec plus repo snapshot can produce a persisted plan and pass audit

## Milestone 2: Durable Workflow Runtime

Status: **complete** (Phase 1b in action-plan.md).

Deliverables:

- Temporal worker bootstrap
- workflow implementations for plan, audit, partition, and task run lifecycles
- Postgres persistence for major entities

Exit criteria:

- workflow state survives worker restarts and can be resumed

## Milestone 3: Claude Execution And Worktrees

Status: **complete** (Phase 3 in action-plan.md).

Deliverables:

- Claude Agent SDK adapter
- worktree lease manager
- task execution workflow with budget and time enforcement

Exit criteria:

- a bounded task can run inside its own worktree with recorded audit metadata

## Milestone 4: Reviewer Loop And Integration

Status: **complete** (Phases 4 + 5 in action-plan.md). `pnpm smoke:phase5`
exits 0 on a clean stack in ~20s and verifies all 12 durable-state
invariants (two merge runs with post-merge snapshot linkage, two phase
audits passing, one completion audit passing, main advanced twice via
`git update-ref`, developer HEAD unchanged).

Deliverables:

- reviewer workflow
- bounded fix loop
- deterministic integration branch manager
- targeted validation after merge
- completion audit workflow and evidence bundle generation

Exit criteria:

- a completed task can move through review, merge, and final audit without
  manual git handling

## Milestone 5: Operator UI And Policy Controls

Status: **active next** (Phase 6 hyper-prompt at
`docs/roadmap/phase6-hyper-prompt.md`).

Deliverables:

- task and plan dashboard
- approval actions
- findings display
- merge queue display
- release readiness and completion audit display
- event stream visibility

Exit criteria:

- an operator can follow and control the full workflow without reading raw logs

## Milestone 6: Policy Engine Hardening

Deliverables:

- explicit budget enforcement
- human approval rules
- retry policy
- stop condition enforcement

Exit criteria:

- risky tasks stop predictably and produce auditable policy decisions
