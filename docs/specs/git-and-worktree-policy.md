# Git And Worktree Policy

Git policy is part of orchestration, not an agent preference.

## Branch Policy

- one task equals one branch
- one write-capable agent equals one worktree
- the orchestrator creates branches and worktrees
- reviewers are read-only
- branch naming is deterministic

Recommended format:

`agent/<plan-id>/<task-id>-<slug>`

## Worktree Policy

- task worktrees must start clean
- worktrees are leased and tracked durably
- default maximum worktree lifetime is 24 hours
- unrelated modifications in a task worktree cause escalation
- agents may not clean unknown changes

## Commit Policy

Do not commit on every edit.

Default checkpoints:

1. initial scaffold complete
2. main implementation complete
3. review fixes complete

Rules:

- soft max of 3 commits per task
- target 1 to 2 commits per task
- trivial tasks should prefer 1 commit
- no amend by default

Recommended commit message format:

- `feat(task-23): add promoter confidence scorer`
- `fix(task-23): address review findings on threshold gating`

## Validation Gates

Every commit checkpoint should pass:

- formatting if configured
- targeted tests for the task
- task-specific validation checks

## Push Policy

Do not push on every commit.

Push checkpoints:

- `ready_for_review`
- `ready_to_merge`

## Merge Policy

- implementers do not merge their own work
- reviewers do not merge
- only the integrator or orchestrator merges into integration
- merge order follows dependency graph, not completion time
- run targeted validation after each merge

## Rebase Policy

- no free-form rebases during active task execution
- rebase only when integration requires it
- rebase should be performed by orchestrator or integrator logic

## Squash Policy

- preserve intermediate task commits during execution
- optional squash is an integration-time decision only

## Audit Trail

Store for each task:

- branch name
- worktree path
- commits created
- test runs per commit checkpoint
- review reports attached to commit range
- final merged commit SHA

