# pm-go

`pm-go` is a schema-first orchestration system for agent-driven software delivery.

The repository is intentionally split into two layers:

1. A durable orchestration layer that owns planning, retries, approvals, budgets, worktree lifecycle, merge order, and auditability.
2. An execution layer that runs Claude-powered implementers and reviewers inside bounded task scopes.

This scaffold focuses on structure and development contracts first. The main deliverables in this initial commit are:

- a monorepo layout aligned to the control-plane and executor split
- TypeScript contract stubs for plans, tasks, reviews, policies, and workflows
- architecture and product specs that define the MVP before implementation begins

## Repository Map

- `apps/web`: Next.js UI for plans, tasks, findings, and merge visibility
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
