# pm-go

Agent-driven delivery falls apart when the workflow lives inside the model: context windows lose state, "done" is whatever the last message claimed, and a crashed run has to start over. `pm-go` pulls planning, retries, approvals, budgets, merge order, and completion audit out of model context and into a durable control plane — so runs are resumable, "done" is decided from evidence instead of claims, and agents operate inside bounded, policy-enforced worktrees instead of open-ended recursion.

The repository is intentionally split into two layers:

1. A durable orchestration layer that owns planning, retries, approvals, budgets, worktree lifecycle, merge order, and auditability.
2. An execution layer that runs Claude-powered implementers and reviewers inside bounded task scopes.

The system is assembled across seven phases (see `docs/phases/`). The current tree delivers:

- 14 packages covering contracts, planner, executor-claude, worktree manager, review engine, integration engine, policy engine, observability, orchestrator, repo-intelligence, db, temporal workflows/activities, and sample-repos fixtures
- Drizzle-managed Postgres schema with migrations `0000–0012`, Temporal workflows with durable retry/stop/budget policies, OpenTelemetry-backed span writer, and Hono API surfacing plans, tasks, approvals, and budget reports
- CI runs typecheck, test, `phase7-matrix`, and `phase7-chaos` on every push — all against stub executors, no Docker, no API key. The Docker-backed gates (`phase5`, `phase6`, `phase7` full durable-state + Temporal replay) live under `scripts/` and run locally; see the phase sections below.
- Operator-facing runbooks in `docs/runbooks/` and historical phase reports in `docs/phases/`

## Quick Start

### Fast check (~30s, zero dependencies)

No Docker, no Postgres, no Temporal, no Anthropic API key. Just Node `>=22` and pnpm `>=10`.

```bash
git clone https://github.com/alex-reysa/pm-go.git
cd pm-go
pnpm install
pnpm smoke:phase7-matrix   # 4 sample-repo fixtures, stub executors, ~30s
pnpm smoke:phase7-chaos    # optional: 3 failure-mode recovery scenarios, stub executors
```

`phase7-matrix` drives a planner-stub → implementer-stub → reviewer-stub round trip against each of the four fixtures under `packages/sample-repos/`. This is what CI runs on every push.

### Full local stack

Exercises the Docker-backed gates: Postgres + Temporal + durable-state assertions + replay.

Requirements: Node `>=22`, pnpm `>=10`, Docker (for Postgres + Temporal).

```bash
cp .env.example .env
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm smoke:phase7          # full durable-state + Temporal replay
```

All stub-mode smoke tests run without an Anthropic API key. To exercise the live Claude executors, export `ANTHROPIC_API_KEY` and set `PLANNER_EXECUTOR_MODE=live` / `IMPLEMENTER_EXECUTOR_MODE=live` per the phase sections below.

## Repository Map

- `apps/tui`: Ink-based terminal operator dashboard for plans, tasks, findings, and release readiness
- `apps/api`: Node control-plane API for orchestration commands and event streaming
- `apps/worker`: Temporal worker process
- `packages/contracts`: schema-first domain types shared across the system
- `packages/temporal-workflows`: workflow names and definitions
- `packages/temporal-activities`: activity contracts for workflow implementations
- `packages/orchestrator`: plan/task/merge application services
- `packages/executor-claude`: Claude Agent SDK adapter boundary
- `packages/worktree-manager`: git branch, worktree, and lease logic
- `packages/repo-intelligence`: repo snapshot and context collection
- `packages/review-engine`: reviewer loop orchestration
- `packages/integration-engine`: deterministic integration sequencing
- `packages/policy-engine`: risk, approval, and budget policy enforcement
- `packages/observability`: OpenTelemetry and durable event log conventions
- `docs`: architecture, specs, ADRs, and roadmap
- `examples`: input templates for spec-driven execution
- `db`: persistence model notes and migration guidance
- `infra`: local runtime infrastructure notes

## Development Order

1. Finalize and stabilize the shared contracts in `packages/contracts`.
2. Implement planner and plan audit workflows against those contracts.
3. Add Temporal workflow implementations and durable state transitions.
4. Add Claude execution adapter and worktree manager.
5. Add reviewer loop, integration engine, and UI.

The authoritative implementation guidance lives in `docs/`.

Start with:

- `docs/roadmap/action-plan.md` for the working delivery sequence
- `docs/roadmap/milestones.md` for the higher-level milestone view

## Local Runtime (Phase 1b)

Phase 1b landed the local substrate: Postgres plus Temporal via
`docker-compose.yml`, Drizzle ORM (ADR 0003), an `@pm-go/db` workspace
package with initial migrations for `spec_documents` and `repo_snapshots`,
a Temporal worker with a `persistSpecDocument` activity, and a Hono API
with `POST /spec-documents` that starts a stub `SpecToPlanWorkflow`.

To run the end-to-end smoke test:

```bash
cp .env.example .env
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm smoke:phase1b
```

`pnpm smoke:phase1b` runs `scripts/phase1b-smoke.sh`, which starts the
worker and API, posts a sample spec, and verifies the row appears in
Postgres.

The integration-test database (`pm_go_test`, referenced by
`DATABASE_URL_TEST`) is provisioned automatically on fresh Postgres volume
creation via `db/init/00-create-test-db.sql`. If you already ran
`pnpm docker:up` before this was added, the init script will not re-run
against the existing volume; create the database manually:

```bash
docker exec pm-go-postgres-1 createdb -U pmgo pm_go_test
```

### Phase 2: Planner Vertical Slice

Phase 2 adds the planner package, six orchestration-review DB tables
(`plans`, `phases`, `plan_tasks`, `task_dependencies`, `agent_runs`,
`artifacts`), and end-to-end `/spec-documents` + `/plans` endpoints.
`POST /spec-documents` now persists the spec and captures a
`RepoSnapshot` from `repoRoot` inline. `POST /plans` starts the
`SpecToPlanWorkflow`, which runs the planner (stub or Claude), audits
the resulting Plan deterministically, persists the Plan, and — if the
audit approves — renders a Markdown artifact to
`./artifacts/plans/<planId>.md`.

```bash
cp .env.example .env  # if not already done
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm smoke:phase2
```

By default the smoke runs in `PLANNER_EXECUTOR_MODE=stub` — no
Anthropic API key required. The stub planner returns a canned Plan
fixture (with ids rebased to the live spec/snapshot) so the full
workflow, persistence, and artifact emission are exercised without a
key. To run against the real Claude planner:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export PLANNER_EXECUTOR_MODE=live
pnpm smoke:phase2
```

See `examples/golden-path/README.md` for the spec the smoke feeds in
and a walk-through of the durable rows and on-disk artifact the run
produces.

### Phase 3: Task Execution Vertical Slice

Phase 3 adds the implementer half of the pipeline: `TaskExecutionWorkflow`
leases a worktree, runs the implementer (stub or Claude) inside it,
runs the deterministic diff-scope audit against `Task.fileScope`, and
stamps the task `in_review` (`ready_for_review` in the workflow result)
or `blocked`. The new HTTP surface:

- `POST /tasks/:taskId/run` starts `TaskExecutionWorkflow` for the task
- `GET /tasks/:taskId` returns the task row plus the latest `agent_run`
  and `worktree_lease` rows for that task

```bash
cp .env.example .env  # if not already done
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm smoke:phase3
```

Like Phase 2, the default smoke runs with `PLANNER_EXECUTOR_MODE=stub`
and `IMPLEMENTER_EXECUTOR_MODE=stub` — no Anthropic API key required.
The stub implementer writes `NOTES.md` into the leased worktree and
commits, so downstream diff-scope has something to verify. To run the
full Claude-backed flow:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export PLANNER_EXECUTOR_MODE=live
export IMPLEMENTER_EXECUTOR_MODE=live
pnpm smoke:phase3
```

`scripts/phase3-smoke.sh` also verifies the durable `worktree_leases`
and `agent_runs` rows land in Postgres and the leased worktree
directory exists on disk.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, branch and commit conventions, and the per-PR test expectations.

Security issues: please follow [`SECURITY.md`](./SECURITY.md) — do not open a public issue for vulnerabilities.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](./LICENSE).
