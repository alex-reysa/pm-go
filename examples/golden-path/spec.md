# Add `/plans/:planId/phases/:phaseId` GET endpoint

## Context

The `pm-go` API already exposes `GET /plans/:planId`, which returns an
entire Plan document including every phase. As plans grow, UI clients
need a cheaper, phase-scoped endpoint that returns only one phase plus
its tasks, without forcing callers to download and filter the full Plan.

## Goal

Add a new Hono route `GET /plans/:planId/phases/:phaseId` to `apps/api`.
The route MUST:

1. Validate that both `planId` and `phaseId` are well-formed UUIDs. Return
   `400` with a descriptive error body on failure.
2. Look up the `plans` row by `planId`. Return `404` if the plan does not
   exist.
3. Look up the `phases` row where `id = phaseId AND plan_id = planId`.
   Return `404` if no matching phase row exists.
4. Load every `plan_tasks` row where `phase_id = phaseId` and
   `plan_id = planId`, plus the phase's dependency edges from
   `task_dependencies`.
5. Reconstruct a single `Phase` object (per the `@pm-go/contracts`
   shape) with its `tasks` attached inline under a new `tasks` field and
   return `200` with the `{ phase, tasks }` JSON body.

## Acceptance Criteria

- `GET /plans/:planId/phases/:phaseId` returns `200` for a persisted
  plan/phase pair with correct `phase.id` and `tasks[*].phaseId`.
- `GET /plans/:planId/phases/:phaseId` returns `404` when the plan does
  not exist, and a distinct `404` when the plan exists but the phase
  does not.
- `GET /plans/:planId/phases/:phaseId` returns `400` on non-UUID inputs.
- New unit tests in `apps/api/test/plans.test.ts` cover the three cases
  above using a mocked DB client.
- No changes to `@pm-go/contracts`, `@pm-go/db`, or worker activities
  are required — the route is read-only and derives its shape from
  existing tables.
