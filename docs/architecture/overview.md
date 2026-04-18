# Architecture Overview

## Goal

Build a Claude-first software delivery system with durable orchestration. The product should turn a spec document plus repo context into a bounded plan, execute that plan through isolated task branches/worktrees, review the results, and integrate them deterministically.

## Core Principles

### Two systems, not one

- The execution layer runs implementers and reviewers.
- The orchestration layer owns state, retries, approvals, budgets, merge order, and stop conditions.

This keeps workflow state out of model context and makes failures resumable.

### Schema-first control plane

- Plans, tasks, dependencies, review reports, and policy decisions must exist as typed objects before they exist as markdown.
- Markdown is a human-facing artifact rendered from structured state.

### Durable completion truth

- Agent claims are not the source of truth for "done."
- Release readiness must be decided from durable evidence: accepted plan scope, merged task state, review reports, validation artifacts, policy decisions, and a final completion audit report.
- A release is not complete until that final audit passes against the merged repository state.

### Bounded autonomy

- No open-ended recursive agent hierarchy in V1.
- No write-capable agent below delegation depth 1.
- If scope expands, the orchestrator re-partitions instead of letting the task drift.

## Runtime Topology

### `apps/web`

Operator-facing Next.js UI for plan inspection, task monitoring, findings, approvals, and merge visibility.

### `apps/api`

Node control-plane API. It receives user commands, persists system state, and translates operator actions into Temporal workflow starts, signals, and queries.

### `apps/worker`

Temporal worker runtime that hosts workflow and activity implementations.

### `packages/contracts`

Shared domain contracts. This is the authoritative source for orchestration data shapes.

### `packages/temporal-workflows`

Workflow names, definitions, and later workflow implementations.

### Supporting packages

- `packages/temporal-activities`
- `packages/orchestrator`
- `packages/executor-claude`
- `packages/worktree-manager`
- `packages/repo-intelligence`
- `packages/review-engine`
- `packages/integration-engine`
- `packages/policy-engine`
- `packages/observability`

## Execution Sequence

1. Ingest spec document and collect repo snapshot.
2. Produce a structured plan.
3. Audit the plan before any coding begins.
4. Partition the plan into bounded tasks with explicit file ownership.
5. Lease a worktree and branch for each approved implementation task.
6. Run implementer.
7. Run independent reviewer.
8. Allow a bounded fix loop.
9. Merge completed branches into an integration branch in dependency order.
10. Run milestone and final validations.
11. Build the completion evidence bundle and source-of-truth view from merged state.
12. Run a final completion audit across code, specs, findings, and acceptance criteria.
13. Produce PR-ready output only if the completion audit passes.

## V1 Non-Goals

- arbitrary runtime-generated agent roles
- autonomous production deploys
- cross-repo orchestration
- unbounded memory systems
- model-driven merge ordering

## Source of Truth

Start implementation with the following files:

- `packages/contracts/src/plan.ts`
- `packages/contracts/src/execution.ts`
- `packages/contracts/src/review.ts`
- `packages/contracts/src/policy.ts`
- `packages/contracts/src/workflow.ts`

At runtime, the source of truth for completion should be the passing
`CompletionAuditReport` plus the durable records and artifacts it cites.
