# Golden Path: End-to-End Planner Smoke

This directory contains a small, realistic specification that the Phase 2
smoke (`pnpm smoke:phase2`) feeds into the planner pipeline end-to-end.

## What the smoke does

1. Boots the Temporal worker and the Hono API locally.
2. `POST /spec-documents` with `examples/golden-path/spec.md` as the
   body — this persists a `spec_documents` row plus a
   `repo_snapshots` row captured from the current working tree.
3. `POST /plans` with the two returned IDs — this starts the
   `SpecToPlanWorkflow` on Temporal.
4. Polls `GET /plans/:planId` until the workflow has persisted the plan.
5. Verifies the durable rows in Postgres (`plans`, `phases`,
   `plan_tasks`, `agent_runs`, `artifacts`) and the Markdown artifact
   on disk under `./artifacts/plans/<planId>.md`.

## Stub vs live planner

By default the smoke runs with `PLANNER_EXECUTOR_MODE=stub`, which does
not require an Anthropic API key. The stub planner returns a canned
Plan fixture (with the spec / snapshot IDs rebased to the live values),
so the smoke exercises full workflow wiring, persistence, and artifact
generation — just not planner quality.

To run against the real Claude planner:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export PLANNER_EXECUTOR_MODE=live
pnpm smoke:phase2
```

Under live mode the planner is read-only (`Read`, `Grep`, `Glob` only)
and structured-output-pinned to `PlanSchema`, so the Plan it returns is
shape-validated before persistence.

## Running it

From the repo root:

```bash
cp .env.example .env           # if not already
pnpm install
pnpm docker:up                 # Postgres + Temporal
pnpm db:migrate
pnpm smoke:phase2
```

On success the script prints `PASS: plan=<uuid> phases=<n>
tasks=<n> artifact=<path>` and exits 0. Any DB/artifact mismatch causes
the script to exit non-zero with worker and API log tails emitted to
stderr.
