# Contributing to pm-go

Thanks for your interest. This document covers local setup, conventions, and what's expected before a PR is merged.

## Prerequisites

- Node `>=22.0.0`
- pnpm `>=10.0.0` (see `packageManager` in `package.json`)
- Docker (Postgres + Temporal run via `docker-compose.yml`)
- git `>=2.35` (worktree support is used by `@pm-go/worktree-manager`)

## Local Setup

```bash
cp .env.example .env
pnpm install
pnpm docker:up      # starts postgres + temporal + temporal-ui
pnpm db:migrate     # applies db/migrations/*.sql via drizzle-kit
pnpm typecheck
pnpm test
```

Stub-mode smokes (no Anthropic API key required):

```bash
pnpm smoke:phase7-matrix   # 4 sample-repo fixtures, in-process stubs
pnpm smoke:phase7-chaos    # 3 failure-mode recovery scenarios
```

Full-stack smoke (requires docker + migrated DB):

```bash
pnpm smoke:phase7
```

Live Claude executors (requires `ANTHROPIC_API_KEY`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export PLANNER_EXECUTOR_MODE=live
export IMPLEMENTER_EXECUTOR_MODE=live
pnpm smoke:phase3   # or later phase smokes
```

## Repository Layout

This is a pnpm workspace monorepo. See `README.md` for the full repository map. Most work lands under `packages/` (control-plane libraries) or `apps/` (api, worker, tui).

Schema-first guidance: all cross-package types live in `packages/contracts`. Before changing a workflow signature, activity shape, or persisted row, update the contract first and propagate from there.

## Branching

- `main` is the integration branch and must stay green on typecheck + tests + matrix/chaos smokes.
- Feature branches: `feature/<short-topic>` or `fix/<short-topic>`.
- Phase work historically uses `phase-<N>` / `phase-<N>-w<M>` branches; follow that pattern for multi-worker efforts.

## Commits

Commits in this repo follow a descriptive prefix convention — see `git log` for examples. For external contributions a conventional form is fine:

```
<type>(<scope>): <short summary>

<body explaining the *why*, not the *what*>
```

`<type>` is one of: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `build`, `ci`. Scope is optional but helpful (e.g. `executor-claude`, `orchestrator`, `db`).

Keep commits focused. Schema changes (migrations in `db/migrations/`) belong in their own commit.

## Pull Requests

Before opening a PR, make sure:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (affected packages at minimum)
- [ ] `pnpm smoke:phase7-matrix` passes if touching planner, executor, reviewer, or integration paths
- [ ] `pnpm smoke:phase7-chaos` passes if touching retry/stop/budget policy, worktree lease recovery, or workflow durable state
- [ ] New durable rows, workflow events, or span kinds have matching entries in `packages/contracts` and a migration in `db/migrations/`
- [ ] Changes that alter reviewer, planner, or policy behavior have updated docs under `docs/` and, when relevant, `docs/runbooks/`

PR description should include:

- What changed (short bullets)
- Why (link to the issue, phase doc, or runbook driving the change)
- Any new env vars, migrations, or smoke-script flags
- Manual test notes if automated coverage wasn't feasible

## Testing Conventions

- Unit tests live next to the code in `*.test.ts` (vitest).
- Per-package: `pnpm --filter @pm-go/<pkg> test`.
- Full matrix: `pnpm test` at the repo root.
- Don't mock the database in integration-flavor tests — use the `pm_go_test` database that docker-compose provisions. Mocked DB tests have historically masked migration regressions.

## Reporting Security Issues

See [`SECURITY.md`](./SECURITY.md). Do not open a public issue for vulnerabilities.

## License

By contributing you agree that your contributions are licensed under the Apache License, Version 2.0 (see [`LICENSE`](./LICENSE)).
