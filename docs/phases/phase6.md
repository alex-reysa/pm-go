# Phase 6 — Operator UI and Visibility Layer

Phase 6 makes the Phase 5 execution backend operable without reading raw worker
logs or touching `psql`. The operator surface is a **terminal UI** (`apps/tui`)
built on Ink 5 + React 18, consuming the same HTTP + SSE endpoints any future
web surface would — the backend is unchanged.

The pivot from a Next.js `apps/web` to `apps/tui` is documented in
[`docs/roadmap/phase6-hyper-prompt.md`](../roadmap/phase6-hyper-prompt.md).
Rationale: faster MVP iteration, zero new toolchain (the repo is 100%
TypeScript/pnpm), and direct consumption of `@pm-go/contracts`. A browser-based
operator surface is deferred post-MVP.

## What shipped

Phase 6 landed across four workers, each gated on the previous worker's merge:

| Worker | Commit | Scope |
|---|---|---|
| 1 — Foundation | `17b7843` → `7aa108d` (4 commits) | `WorkflowEvent` contract + validator + `workflow_events` table + migration 0008/0009 + emit hooks in phase-integration / task-execution / completion-audit activities + additive read endpoints (`/plans`, `/phases`, `/tasks`, `/agent-runs`, `/events`, `/artifacts/:id`) + SSE live-tail on `/events` |
| 2 — TUI runtime | `a04c0d6` | `apps/tui` bootstrap (Ink 5 + React 18 + @tanstack/react-query + `ink-testing-library`), typed API client, hand-rolled SSE client with reconnect + `sinceEventId` resume, vim-style keybind system with chord parser, plans-list screen, plan-detail placeholder + live events tail |
| 3 — Screens + controls | `365b6f3` | Filled plan-detail (flat cursor over tasks grouped by phase, Release row when eligible), fullscreen task drawer, release screen, confirm modal with busy spinner + inline error, 7 operator chords (`g r`/`g v`/`g f`/`g i`/`g a`/`g c`/`g R`), client-side gates in `state-machines.ts` mirroring the server's primary 409 rule per action |
| 4 — Smoke + docs | this commit | `scripts/phase6-smoke.sh`, `docs/phases/phase6.md`, expanded `apps/tui/README.md`, deleted `apps/web` stub |

## Architecture at a glance

```
  apps/worker                          apps/api                         apps/tui
  ───────────                          ────────                         ────────
  TaskExecutionWorkflow  ──┐           GET /plans                       PlansList ◀── useQuery
  PhaseIntegrationWorkflow─┼──► plans  GET /phases?planId                     │
  PhaseAuditWorkflow       │    phases GET /tasks?{phaseId|planId}            ▼
  CompletionAuditWorkflow  │    tasks  GET /agent-runs?taskId           PlanDetail ◀── useQuery
  FinalReleaseWorkflow  ───┘    ...                                          │
                                                                             │  SSE
                                 workflow_events ─────► GET /events ────────►│  (fetch + ReadableStream)
                                 (append-only)         (replay + live)       │
                                                                             ▼
                                 artifacts  ──────────► GET /artifacts/:id   TaskDrawer / Release
                                                       (realpath-contained)
```

Phase 5's durable tables (`plans`, `phases`, `plan_tasks`, `merge_runs`,
`phase_audit_reports`, `completion_audit_reports`, `artifacts`) remain the source
of truth. `workflow_events` is an append-only read model; losing a row never
blocks the owning workflow transition (emission is best-effort and log-and-continue).

The TUI consumes the HTTP surface as a read-only client for everything except
the seven Phase 5 POST endpoints it already exposes. No new orchestration, no
new workflows, no new contract fields in Phase 6.

## Running the operator UI

```sh
pnpm docker:up        # postgres + temporal
pnpm db:migrate       # apply db/migrations/*.sql (0008, 0009 added by Worker 1)
pnpm dev:worker       # Temporal worker (stub executors by default)
pnpm dev:api          # Hono control-plane on :3001
pnpm tui              # the operator dashboard
```

To point the TUI at a different API: `PM_GO_API_BASE_URL=http://host:port pnpm tui`.
Full keybind table and operator flows live in
[`apps/tui/README.md`](../../apps/tui/README.md).

## Exit bar achieved

Per the hyper-prompt §8 success criteria:

- [x] `pnpm typecheck && pnpm test` green across the workspace (12 packages, 430+
      tests at this point in history)
- [x] `pnpm --filter @pm-go/tui build` emits `dist/index.js` with an executable
      shebang
- [x] `pnpm smoke:phase5` still exits `0` (non-regression gate)
- [x] `pnpm smoke:phase6` exits `0` and proves the Phase 6 read surface:
      - plans list visibility
      - per-plan phase + task listing (both `?phaseId` and `?planId` scopes,
        plus mutual-exclusion 400 rule)
      - agent-runs per task
      - events JSON replay includes `phase_status_changed`,
        `task_status_changed`, `artifact_persisted`
      - `sinceEventId` cursor narrows the replay
      - SSE live-tail emits the `ready` handshake + `phase_status_changed`
      - artifact HTTP streaming with `text/markdown` content-type
      - traversal guard rejects `file:///etc/hosts`-style artifacts with 403
      - backward-compat: `GET /plans/:id` still returns `{plan, artifactIds,
        latestCompletionAudit}`
- [x] Manual operator check: `pnpm tui` boots, navigates, streams events live,
      and every operator chord fires through the confirm modal against a stub
      stack

## Smoke coverage vs manual

`pnpm smoke:phase6` is curl-driven and proves the HTTP + SSE surface the TUI
consumes. It does **not** drive the Ink rendering layer — Ink keystroke
automation against a subprocess would add a rabbit-hole test harness for
marginal gain over the unit tests in `apps/tui/test/`, which already cover:

- Per-endpoint fetch wrappers + 409 → `ApiError` mapping (`api.test.ts`)
- SSE parser + reconnect with `sinceEventId` + backoff gating (`events.test.ts`)
- Keybind chord parser + token mapping (`keybinds.test.ts`)
- Event → query-key invalidation (`hooks.test.ts`)
- App render + navigation (`app.test.tsx`)
- Each `canX` gate, one ok + one blocked (`state-machines.test.ts`)
- Confirm modal y/enter/n/esc + busy suppression + error display (`confirm-modal.test.tsx`)
- Plan-detail renders + cursor + enter→drawer + disabled-kinds reporting (`plan-detail.test.tsx`)
- Release screen rendering + gated `g R` dispatch (`release-screen.test.tsx`)
- Integration: operator chord → modal → api.runTask called, 409 inline, cancel (`operator-actions.test.tsx`)

The manual check (drive a plan end-to-end via chords in a running TUI against
a stub stack) is the last-mile verification documented in `apps/tui/README.md`
under "Operator flows".

## Deferred / post-MVP

From the hyper-prompt §1 out-of-scope list, explicitly deferred beyond Phase 6:

- A browser-based operator surface in `apps/web` — removed in Worker 4; may
  re-scaffold from scratch in a future phase.
- Auth, multi-user, RBAC.
- Human approval gates and policy-engine UI (Phase 7 territory).
- Editing plans or re-running the planner from the TUI.
- New orchestration workflows or event kinds.
- GitHub PR creation (V1 ships the PR-summary markdown as an artifact).
- Browser/Ink E2E automation in the smoke.
- Artifact content streaming into the TUI (operators still `curl
  /artifacts/:id` or tail the on-disk file).

## Pointers

- Hyper-prompt: [`docs/roadmap/phase6-hyper-prompt.md`](../roadmap/phase6-hyper-prompt.md)
- Operator manual: [`apps/tui/README.md`](../../apps/tui/README.md)
- Event contract: `packages/contracts/src/events.ts`
- TUI gates: `apps/tui/src/lib/state-machines.ts`
- Smoke script: `scripts/phase6-smoke.sh`
