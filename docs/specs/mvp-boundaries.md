# MVP Boundaries

## In Scope

V1 supports:

- local repo execution only
- a single primary spec document input
- TypeScript repos only (Python deferred to V1.1)
- structured plan generation
- plan audit before coding
- bounded task partitioning
- worktree-based implementation
- independent reviewer loop
- deterministic integration branch flow
- final completion audit and release-readiness verdict
- PR-ready output artifacts

## Language Scope

V1 targets TypeScript repos. Python support is deferred to V1.1 because repo
intelligence, test-runner parsing, and framework heuristics need language-
specific implementations that were not sized into any V1 phase.

When V1.1 adds Python, the affected surfaces are:

- `packages/repo-intelligence` (detect `pyproject.toml`, `setup.cfg`, `uv.lock`)
- test-runner parsing for `pytest` output
- framework hints for common Python stacks
- `buildCommands` and `testCommands` defaults on `RepoSnapshot`

No contract change is expected; `RepoSnapshot.languageHints` already supports
it.

## Explicitly Out Of Scope

Do not add these to V1:

- open-ended recursive agent systems
- arbitrary role generation at runtime
- autonomous production deploys
- cross-repo execution graphs
- unbounded long-term memory
- markdown-only planning
- model-owned merge order

## MVP Acceptance Criteria

The product is ready for initial internal use when it can:

1. ingest a spec and local repo path
2. capture a durable repo snapshot
3. create an auditable structured plan
4. partition that plan into bounded tasks with explicit file ownership
5. execute at least one implementer task in a worktree
6. execute an independent reviewer
7. merge approved work through an integration branch
8. run a final completion audit against the merged result
9. produce audit artifacts, a source-of-truth evidence bundle, and a PR summary

## Quality Gates

- every workflow is resumable
- every major state transition is persisted
- every task has a budget and review policy
- every merge is reproducible from stored metadata
- release readiness is decided from a completion audit, not from agent completion claims
