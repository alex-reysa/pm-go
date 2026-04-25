# pm-go Docs

This directory is organized by what you are trying to do.

## Run pm-go

- [Getting started](getting-started.md): install, start the local stack, submit
  a feature spec, and drive it to release.
- [Runtimes](runtimes.md): choose `stub`, `sdk`, `claude`, or `auto` for each
  agent role.
- [TUI guide](../apps/tui/README.md): keyboard-driven operator workflow.
- [API app](../apps/api/README.md): run and inspect the HTTP control plane.
- [Worker app](../apps/worker/README.md): run and inspect the Temporal worker.

## Understand the system

- [Architecture overview](architecture/overview.md): the product model and
  execution sequence.
- [Domain model](specs/domain-model.md): durable objects and invariants.
- [Workflow model](specs/workflow-model.md): Temporal workflow responsibilities
  and state transitions.
- [Control-plane API](specs/control-plane-api.md): current HTTP surface.
- [Git and worktree policy](specs/git-and-worktree-policy.md): branch, worktree,
  merge, and lease rules.
- [Task routing and limits](specs/task-routing-and-limits.md): task sizing,
  risk, review, and budget boundaries.
- [Completion audit](specs/completion-audit.md): release-readiness evidence.

## Operate and recover

- [Blocked tasks](runbooks/blocked-tasks.md)
- [Stale worktrees](runbooks/stale-worktrees.md)
- [Failed completion audit](runbooks/failed-completion-audit.md)

## See examples

- [Spec input template](../examples/spec-input-template.md)
- [Golden path feature spec](../examples/golden-path/spec.md)
- [Golden path walkthrough](../examples/golden-path/README.md)

## Project history

- [Milestones](roadmap/milestones.md)
- [Action plan](roadmap/action-plan.md)
- [Dogfood observations](reports/2026-04-24-dogfood-observations.md)
- [v0.8.2 dogfood dev plan](roadmap/2026-04-25-dogfood-dev-plan.md)
