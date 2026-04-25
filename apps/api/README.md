# `@pm-go/api`

Hono control-plane API for pm-go.

The API is intentionally thin: it validates requests, starts Temporal workflows,
signals blocked workflows, and reads durable state from Postgres. Workflow logic
lives in `apps/worker`; domain shapes live in `packages/contracts`.

## Run Locally

From the repo root:

```bash
set -a; source .env; set +a
pnpm dev:api
```

The server listens on `http://localhost:${API_PORT:-3001}`.

Health check:

```bash
curl -sS http://localhost:3001/health
```

Diagnostics (`pm-go doctor`) require the CLI to be built first:

```bash
pnpm --filter @pm-go/cli build
pnpm pm-go doctor
```

## Required Services

- Postgres from `pnpm docker:up`
- Temporal from `pnpm docker:up`
- migrated database from `pnpm db:migrate`
- worker running on the same `TEMPORAL_TASK_QUEUE`

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. |
| `API_PORT` | `3001` | HTTP listen port. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend address. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `TEMPORAL_TASK_QUEUE` | `pm-go-worker` | Queue used when starting workflows. |
| `PLAN_ARTIFACT_DIR` | `./artifacts/plans` | Artifact read root. |
| `REPO_ROOT` | repo root | Repo passed to task execution workflows. |
| `WORKTREE_ROOT` | `<repo>/.worktrees` | Task worktree root. |
| `MAX_WORKTREE_LIFETIME_HOURS` | `24` | Lease lifetime for API-started task runs. |

## Routes

Spec and plan:

- `POST /spec-documents`
- `POST /plans`
- `POST /plans/:planId/audit`
- `GET /plans`, `GET /plans/:planId`

Task execution and review:

- `GET /tasks`, `GET /tasks/:taskId`
- `GET /tasks/:taskId/review-reports`
- `POST /tasks/:taskId/run`
- `POST /tasks/:taskId/review`
- `POST /tasks/:taskId/fix`
- `POST /tasks/:taskId/approve`
- `POST /tasks/:taskId/override-review`

Phase integration and audit:

- `GET /phases`, `GET /phases/:phaseId`
- `GET /merge-runs/:id`
- `GET /phase-audit-reports/:id`
- `POST /phases/:phaseId/integrate`
- `POST /phases/:phaseId/audit`
- `POST /phases/:phaseId/override-audit`

Approvals, completion, release:

- `GET /approvals?planId=:planId`
- `POST /plans/:planId/approve`
- `POST /plans/:planId/approve-all-pending`
- `POST /plans/:planId/complete`
- `GET /completion-audit-reports/:id`
- `POST /plans/:planId/release`

Reads and observability:

- `GET /agent-runs`
- `GET /artifacts/:id`
- `GET /plans/:planId/budget-report`
- `GET /events?planId=:planId` (also SSE with `Accept: text/event-stream`)
- `GET /health`

See [../../docs/specs/control-plane-api.md](../../docs/specs/control-plane-api.md)
for payloads, state-machine preconditions, and operator guidance.

## Debugging

- `curl http://localhost:3001/health` should return `{ "status": "ok" }`.
- `curl http://localhost:3001/plans` should return JSON when the DB is
  reachable.
- A `409` response usually means the state machine is protecting ordering. Read
  the `error` field and inspect `GET /tasks/:id` or `GET /phases/:id`.
- If workflow starts fail, confirm the worker is running with the same
  `TEMPORAL_TASK_QUEUE`.
