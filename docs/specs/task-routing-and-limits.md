# Task Routing And Limits

This document defines default risk routing and hard operating limits.

## Risk Bands

### Low Risk

Examples:

- docs
- tests
- isolated refactors
- UI-only work

Policy defaults:

- standard review
- parallel execution allowed
- automatic merge allowed if validations pass

### Medium Risk

Examples:

- backend feature work
- schema changes without destructive migration
- workflow logic

Policy defaults:

- elevated review
- parallel execution allowed when file ownership is disjoint
- merge may require approval depending on affected systems

### High Risk

Examples:

- auth
- security boundaries
- data-moving migrations
- infra and deploy
- code generation across many packages

Policy defaults:

- critical review
- human approval required
- merge requires approval

## Operating Limits

Enforced defaults:

- max delegation depth: 2
- max concurrent implementers per active phase: 4
- max concurrent reviewers per active phase: 2
- max review/fix cycles per task: 2
- max planning revisions: 1 automatic revision
- max automatic phase re-runs: 1 before human escalation
- max merge retry attempts per task: 2
- soft max files per task: 12
- soft max packages per task: 2
- soft max migrations per task: 1
- max worktree lifetime: 24h
- max branch fan-out per active phase: 6
- max unresolved high-severity findings before stop: 1
- default max wall-clock per task run: 45 minutes
- max repo-wide destructive actions: 0 without explicit approval
- phases execute strictly sequentially: at most one phase is active at a time

## Phase Scoping

Concurrency limits apply to the active phase only. A plan with five phases
does not run 5x `maxConcurrentImplementers` in parallel. At any point in time
there is at most one active phase. Foundational-lane tasks inside the active
phase merge before any parallel-lane task in the same phase starts.

## Routing Inputs

Routing should consider:

- risk level
- file scope size
- package scope count
- migration count
- dependency fan-in and fan-out
- required approval policy

## Stop And Escalation Conditions

Escalate to human when:

- task exceeds allowed file scope
- repeated review failures hit the cycle limit
- merge conflicts exceed retry count
- high-risk task lacks approval
- dirty worktree is detected
- plan cannot be revised automatically within one pass
- phase audit fails twice
- foundational lane of the active phase fails to merge, blocking its parallel lanes

