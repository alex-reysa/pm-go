# `@pm-go/worker`

Temporal worker runtime for pm-go.

The worker hosts workflow implementations and activity implementations. It is
where plans become tasks, tasks become worktree changes, review reports become
policy decisions, and phase/completion audits become release gates.

## Run Locally

From the repo root:

```bash
set -a; source .env; set +a
pnpm dev:worker
```

The worker connects to Temporal at `TEMPORAL_ADDRESS` and registers workflows on
`TEMPORAL_TASK_QUEUE`.

## Required Services

- Postgres from `pnpm docker:up`
- Temporal from `pnpm docker:up`
- migrated database from `pnpm db:migrate`

The API is not required for the worker to boot, but the normal product loop runs
both API and worker together.

## Runtime Selection

Each agent role can run through one of four runtime modes:

| Mode | Use it for |
|---|---|
| `stub` | CI and deterministic local control-plane tests. |
| `sdk` | Live Claude Agent SDK execution. |
| `claude` | Claude CLI process runtime. |
| `auto` | Prefer SDK, then Claude CLI, then stub. |

Canonical env vars:

```bash
export PLANNER_RUNTIME=sdk
export IMPLEMENTER_RUNTIME=sdk
export REVIEWER_RUNTIME=sdk
export PHASE_AUDITOR_RUNTIME=sdk
export COMPLETION_AUDITOR_RUNTIME=sdk
```

Legacy `*_EXECUTOR_MODE` variables are still accepted for smoke scripts, but
`*_RUNTIME` wins when both are set.

Run diagnostics before live work:

```bash
pnpm --filter @pm-go/cli build
pnpm pm-go doctor
```

See [../../docs/runtimes.md](../../docs/runtimes.md) for the full runtime model.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend address. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `TEMPORAL_TASK_QUEUE` | `pm-go-worker` | Queue the API starts workflows on. |
| `PLAN_ARTIFACT_DIR` | `./artifacts/plans` | Rendered plan artifact directory. |
| `RUNNER_DIAGNOSTIC_DIR` | `./artifacts` | Parent directory for `runner-diagnostics/<id>.json` files written when a Claude reviewer / phase-auditor / completion-auditor structured-output payload fails runtime schema validation. |
| `REPO_ROOT` | `.` | Main repository root. |
| `WORKTREE_ROOT` | `.worktrees` | Task implementation worktrees. |
| `INTEGRATION_WORKTREE_ROOT` | `.integration-worktrees` | Phase integration worktrees. |
| `WORKTREE_MAX_LIFETIME_HOURS` | `24` | Task lease lifetime. |
| `ANTHROPIC_API_KEY` | unset | Required for SDK live mode unless another supported auth path is available. |

Relative paths in `WORKTREE_ROOT`, `INTEGRATION_WORKTREE_ROOT`,
`PLAN_ARTIFACT_DIR`, and `RUNNER_DIAGNOSTIC_DIR` resolve against the repo
root, not the worker process cwd. Launching the worker from a subdirectory
is therefore safe.

## What The Worker Runs

- `SpecToPlanWorkflow`
- `TaskExecutionWorkflow`
- `TaskReviewWorkflow`
- `TaskFixWorkflow`
- `PhaseIntegrationWorkflow`
- `PhaseAuditWorkflow`
- `CompletionAuditWorkflow`
- `FinalReleaseWorkflow`

## Debugging

- If the worker exits with `DATABASE_URL is required`, load `.env` before
  starting it.
- If live runners resolve to stub, check `*_RUNTIME` and run `pnpm pm-go doctor`.
- If API requests start workflows but nothing changes, confirm API and worker
  use the same `TEMPORAL_TASK_QUEUE`.
- When a Claude runner returns a `structured_output` payload that fails
  runtime schema validation, the worker writes a sanitized diagnostic to
  `${RUNNER_DIAGNOSTIC_DIR:-./artifacts}/runner-diagnostics/<artifactId>.json`.
  When the diagnostic carries a session id that resolves to a `planId`, an
  entry is also added to the `artifacts` table with `kind='runner_diagnostic'`
  and `uri` pointing at the on-disk file. The on-disk JSON is the
  authoritative copy; the row exists for grep / dashboard discoverability.
