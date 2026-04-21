# Phase 6 Hyper-Prompt — Operator UI And Visibility Layer

> **Pivot (2026-04-21):** Phase 6 shipped Worker 1 (contract + read API + SSE)
> as originally scoped. Workers 2/3/4 retargeted from a Next.js web app
> (`apps/web`) to a **terminal** UI in `apps/tui`, built on
> [Ink](https://github.com/vadimdemedes/ink). Rationale: faster iteration
> for an MVP single-operator tool, zero new toolchain (the repo is 100%
> TypeScript/pnpm), and direct `@pm-go/contracts` consumption. The API
> surface is unchanged; `apps/web` becomes a deferred post-MVP surface.

## 1. Phase identity

- **Phase:** `6 — Operator UI And Visibility Layer`
- **Phase type:** additive read surface + terminal UI over the verified Phase 5 execution backend
- **Exact goal:** an operator can follow and drive a complete plan from a terminal dashboard and HTTP API alone. The operator should be able to submit a spec, inspect plans/phases/tasks/agent runs, trigger the existing control-plane actions, watch live state transitions, and inspect release artifacts without reading worker logs or touching `psql`.
- **Source-of-truth rule:** Phase 5's durable tables and artifacts remain authoritative. Phase 6 adds read models, event streaming, and UI wiring. It does **not** move orchestration logic into the client.
- **In-scope outcomes:**
  - a schema-first `WorkflowEvent` contract plus durable `workflow_events` persistence
  - additive list/read endpoints on the existing Hono API:
    - `GET /plans`
    - `GET /phases?planId=<uuid>`
    - `GET /tasks?phaseId=<uuid>|planId=<uuid>`
    - `GET /agent-runs?taskId=<uuid>`
    - `GET /events?planId=<uuid>&sinceEventId=<uuid>?`
    - `GET /artifacts/:id`
  - best-effort workflow event emission for task, phase, audit, merge, and artifact milestones
  - a real `apps/tui` Ink operator UI with two screens today (plans list + plan detail with live event tail) and operator-action keybinds for every existing POST endpoint
  - operator action controls for the **existing** POST endpoints only:
    - task run / review / fix
    - phase integrate / audit
    - plan complete / release
  - `scripts/phase6-smoke.sh` that proves the list endpoints, SSE stream, and artifact HTTP serving on top of the already-verified Phase 5 flow
- **Explicitly out of scope:**
  - auth, multi-user state, or RBAC
  - human approval gates or policy-engine UI
  - editing plans or re-running the planner from the TUI
  - new orchestration workflows
  - GitHub PR creation
  - browser E2E
  - the deferred Next.js web app in `apps/web`
  - mouse support in the TUI; keyboard-only

## 2. Preconditions

- `main` is at `51192a0` or later.
- `pnpm smoke:phase5` passes on a clean local stack before Phase 6 starts.
- Phase 5's read/write API routes are stable and remain the source of truth:
  - `POST /spec-documents`
  - `POST /plans`
  - `GET /plans/:id`
  - `POST /tasks/:id/run`
  - `POST /tasks/:id/review`
  - `POST /tasks/:id/fix`
  - `POST /phases/:id/integrate`
  - `POST /phases/:id/audit`
  - `POST /plans/:id/complete`
  - `POST /plans/:id/release`
- `apps/web` exists only as a stub package and is now deferred post-MVP. Phase 6's operator UI lives in a new `apps/tui` workspace.
- Stop immediately if `smoke:phase5` is red, if any Phase 5 API contract is still moving, or if Phase 6 work would require changing Phase 5 workflow semantics instead of consuming them.

## 3. Operating model

- **Orchestrator branch:** `codex/pm-go-phase6-orchestrator`
- **Orchestrator worktree:** `../pm-go-phase6-orchestrator`
- **Execution shape:** one foundational worker first, then the smallest useful web split, then a reconciliation/smoke worker.
- **Delegation rule:** prefer one level of delegation. Do not create deeper agent trees.
- **Max delegation depth:** `2`
- **Max review/fix cycles per worker lane:** `2`
- **Reviewers are read-only.** They do not edit files.
- **Implementers do not merge their own work.**
- **The orchestrator owns:**
  - worker launch order
  - branch/worktree creation
  - merge order
  - post-merge verification
  - the final Phase 6 smoke gate
- **Phase 6 split guidance:** do not force fake parallelism. Only split work where file ownership is actually clean.

Recommended lane order:

1. **Foundation:** event contract + DB + additive read API + artifact serving
2. **TUI runtime + data layer** (`apps/tui` bootstrap, typed API client, SSE client, keybind system, app shell)
3. **TUI screens + operator controls**
4. **Smoke/docs/reconciliation**

Workers 2 and 3 may overlap only after Worker 1 has stabilized the API surface and Worker 2 has frozen the shared data layer + keybind table. Merge order still remains deterministic.

## 4. Worker plan

### Worker 1 — Events, contracts, and additive read API

- **Branch:** `codex/pm-go-phase6-foundation`
- **Worktree:** `../pm-go-phase6-foundation`
- **Exact scope:**
  - add a schema-first `WorkflowEvent` contract
  - persist `workflow_events`
  - expose read/list routes and SSE
  - expose artifact streaming over HTTP
  - wire best-effort event emission into the worker activity/workflow boundary
- **File ownership:**
  - `packages/contracts/src/**` for any new event contract/export
  - `packages/contracts/src/validators/**`
  - `packages/contracts/src/json-schema/**`
  - `packages/contracts/src/fixtures/**`
  - `packages/contracts/test/**`
  - `packages/db/src/schema/workflow-events.ts`
  - `packages/db/src/schema/index.ts`
  - `db/migrations/0008_*.sql`
  - `apps/worker/src/activities/events.ts`
  - `apps/worker/src/activities/**` and `apps/worker/src/workflows/**` only where event emission hooks are required
  - `apps/api/src/routes/**` for new list/stream/artifact routes and read-model additions
  - `apps/api/src/app.ts`
  - matching tests under `apps/api/test/**`, `apps/worker/test/**`, `packages/contracts/test/**`, `packages/db/test/**`
- **Constraints:**
  - `WorkflowEvent` is additive and append-only. It is a projection, not the source of truth over phase/task state.
  - existing Phase 5 endpoints must remain backward compatible
  - `/artifacts/:id` must realpath-check the resolved file and reject anything outside `PLAN_ARTIFACT_DIR`
  - SSE stays in the existing Hono app; do not add websockets or a second server
  - event emission is best-effort and must never block the underlying workflow transition
- **Deliverables:**
  - `workflow_events` contract, validator, JSON Schema export, and fixture coverage
  - `workflow_events` table and migration
  - list/read endpoints
  - SSE endpoint with replay + live tail
  - artifact streaming endpoint
  - event emission helpers wired to Phase 5 persistence points

### Worker 2 — TUI runtime and shared data layer

- **Branch:** `codex/pm-go-phase6-tui-runtime`
- **Worktree:** `../pm-go-phase6-tui-runtime`
- **Exact scope:**
  - bootstrap `apps/tui` as an Ink 5 (React 18) terminal app
  - add the shared typed API client, query layer, SSE client, and keybind system
  - provide the app shell and placeholder screens that Worker 3 can fill
- **File ownership:**
  - `apps/tui/package.json`
  - `apps/tui/tsconfig.json`
  - `apps/tui/vitest.config.ts`
  - `apps/tui/src/index.tsx`
  - `apps/tui/src/app.tsx`
  - `apps/tui/src/types.ts`
  - `apps/tui/src/components/**`
  - `apps/tui/src/screens/**` (placeholder bodies)
  - `apps/tui/src/lib/api.ts`
  - `apps/tui/src/lib/events.ts`
  - `apps/tui/src/lib/hooks.ts`
  - `apps/tui/src/lib/query-client.ts`
  - `apps/tui/src/lib/keybinds.ts`
  - `apps/tui/src/lib/config.ts`
  - `apps/tui/src/lib/context.tsx`
  - `apps/tui/test/**` for runtime/data-layer tests
  - root `package.json` for the `tui` run script
- **Constraints:**
  - `apps/tui` imports `@pm-go/contracts` as its single source for domain types
  - no imports from `apps/worker`, `packages/temporal-workflows`, `packages/executor-claude`, or `packages/worktree-manager`
  - no business logic in the client beyond UI precondition checks and query invalidation
  - the SSE client must parse the server's framing without a native-module dependency (Node 22 `fetch` + `ReadableStream` is the baseline)
  - the keybind table is authoritative — screens dispatch `TuiAction` values from it instead of hard-coding chords
- **Deliverables:**
  - Ink 5 + React 18 runtime in `apps/tui`
  - typed API wrappers for current backend routes
  - query hooks (`@tanstack/react-query`)
  - SSE client with reconnect + `sinceEventId` resume
  - keybind chord parser + vim-style default table
  - placeholder screens that prove the runtime boots end-to-end

### Worker 3 — Operator screens and controls

- **Branch:** `codex/pm-go-phase6-tui-screens`
- **Worktree:** `../pm-go-phase6-tui-screens`
- **Exact scope:**
  - implement the filled screen bodies: plans list, plan detail (phase cards, task lists, drawers), release view
  - add confirm modals that dispatch the existing POST endpoints
  - render plan/phase/task/audit/artifact state cleanly in standard terminal widths (80+ columns)
- **File ownership:**
  - `apps/tui/src/screens/plans-list.tsx` (richer filters/paging)
  - `apps/tui/src/screens/plan-detail.tsx` (phase + task subviews)
  - `apps/tui/src/screens/release.tsx`
  - `apps/tui/src/components/**` (new: confirm modal, drawer, task-list, phase-card)
  - `apps/tui/src/lib/state-machines.ts`
  - `apps/tui/test/**` for screen/component interaction tests
- **Constraints:**
  - no direct `fetch` inside screens; reads go through hooks, writes go through action dispatchers
  - client-side disabled-state logic must mirror server preconditions but never replace them
  - no approval UI for policy-engine decisions yet; only chords for routes that already exist
- **Deliverables:**
  - plans list with live status
  - plan detail with phase cards, task drawers, and live event tail
  - release view with completion-audit details and artifact links
  - operator controls for the existing POST routes (seven chords: `g r`, `g v`, `g f`, `g i`, `g a`, `g c`, `g R`) with confirm modals
  - component test coverage for statuses, disabled states, and action wiring

### Worker 4 — Smoke, docs, and reconciliation

- **Branch:** `codex/pm-go-phase6-smoke`
- **Worktree:** `../pm-go-phase6-smoke`
- **Exact scope:**
  - add the real Phase 6 smoke
  - document how to run the operator UI
  - delete the `apps/web` stub now that the TUI is the Phase 6 surface
  - reconcile any final wiring gaps across workers without broad refactors
- **File ownership:**
  - `scripts/phase6-smoke.sh`
  - root `package.json` for `smoke:phase6`
  - `docs/phases/phase6.md`
  - `apps/tui/README.md`
  - delete `apps/web/` (or keep with a one-line README pointing to the TUI — orchestrator's call)
  - any narrowly-scoped final wiring files required to boot the TUI or smoke flow
- **Constraints:**
  - `phase6-smoke` must build on `phase5-smoke`, not replace or weaken it
  - smoke must exercise the Phase 6 read surface over HTTP (curl-based: list endpoints, SSE replay, artifact fetch)
  - no TUI automation (Ink-level keystroke scripting is out of scope for smoke; the TUI gets its own manual check)
  - if a reconciliation fix touches a worker-owned file, keep it mechanical and minimal
- **Deliverables:**
  - `pnpm smoke:phase6`
  - docs for local operator workflow
  - final verification pass over the merged branch

## 5. Review policy

- Each implementer lane ends at `READY_FOR_REVIEW`.
- Each lane gets one read-only auditor.
- The auditor returns exactly one of:
  - `APPROVED`
  - `CHANGES_REQUIRED`
- If `CHANGES_REQUIRED`, findings go back to the same worker branch.
- Allow at most one fix pass and one final audit pass.
- Cap review loops at `2` total per worker lane.
- If a lane still fails review after the cap, stop Phase 6 and report the blocker instead of broadening the scope.

## 6. Integration protocol

- **Strict merge order:**
  1. Worker 1 — foundation
  2. Worker 2 — web runtime/data layer
  3. Worker 3 — web views/controls
  4. Worker 4 — smoke/docs/reconciliation
  5. orchestrator final verification
- Worker 2 and Worker 3 may overlap in development, but Worker 2 must merge before Worker 3.
- Resolve mechanical conflicts only.
- If a merge reveals a design mismatch between the Phase 5 API and the Phase 6 UI contract, stop and report it instead of inventing new backend semantics.
- **Verification after each merge:**
  - after Worker 1: `pnpm typecheck && pnpm test`
  - after Worker 2: `pnpm --filter @pm-go/tui typecheck && pnpm --filter @pm-go/tui test && pnpm --filter @pm-go/tui build`
  - after Worker 3: `pnpm typecheck && pnpm test && pnpm --filter @pm-go/tui build`
  - after Worker 4: `pnpm typecheck && pnpm test && pnpm smoke:phase5 && pnpm smoke:phase6`

## 7. Mandatory invariants

- Phase 5 state tables and artifacts remain authoritative. `workflow_events` is a read model, not the control plane.
- Phase 6 must not introduce new orchestration workflows or change the semantics of Phase 5 workflow transitions.
- `apps/api` must not import `@anthropic-ai/claude-agent-sdk`.
- `apps/tui` must not import anything from `apps/worker` or `packages/temporal-workflows`.
- `apps/tui` uses `@pm-go/contracts` for domain types instead of duplicating interfaces.
- Every operator-action keybind's disabled state must correspond to the server's 409 rules.
- `/artifacts/:id` must reject paths outside `PLAN_ARTIFACT_DIR` after realpath resolution.
- SSE heartbeats must keep idle connections alive without requiring websockets.
- The TUI must render cleanly at 80+ column widths; truncate rather than wrap in status cells.
- No approval-gate UI or policy-engine semantics may be pulled forward from Phase 7.
- `pnpm smoke:phase5` must stay green throughout Phase 6. If Phase 6 breaks Phase 5, Phase 6 is not done.

## 8. Success criteria

- `pnpm typecheck && pnpm test` passes across the workspace, including the new TUI package.
- `pnpm --filter @pm-go/tui build` succeeds (emits `dist/index.js` with executable shebang).
- `pnpm smoke:phase5` still exits `0`.
- `pnpm smoke:phase6` exits `0` and verifies:
  - plan list visibility
  - per-plan phase/task listing
  - SSE replay/live tail
  - artifact HTTP serving
  - the existing Phase 5 execution flow remains intact
- Manual operator check:
  - `pnpm tui` boots the dashboard
  - navigate plans list with j/k/enter
  - open plan detail; event tail updates live
  - fire each operator chord (`g r`/`g v`/`g f`/`g i`/`g a`/`g c`/`g R`) once against a fixture plan
  - confirm the event tail updates without watching worker logs
  - `q` exits cleanly (terminal state restored)

## 9. Stop conditions

- `pnpm smoke:phase5` regresses at any point.
- the event stream cannot replay or tail events reliably enough for the dashboard to function.
- the artifact route accepts a path outside `PLAN_ARTIFACT_DIR`.
- Phase 6 requires breaking an existing Phase 5 API response shape instead of adding new read surfaces.
- Ink cannot render cleanly in a standard terminal (xterm-256color, 80+ columns).
- approval controls or policy-engine work begin leaking into Phase 6 scope.

## 10. Progress and next commit shape

Worker 1 proved the read-model pattern end-to-end (commits through `7aa108d`):

- `WorkflowEvent` contract + validator + fixture
- migration `0008_*` and `packages/db/src/schema/workflow-events.ts`
- `apps/worker/src/activities/events.ts` + emit hooks in phase-integration / task-execution / completion-audit
- best-effort emit points for `phase_status_changed`, `task_status_changed`, `artifact_persisted`
- `GET /events?planId=<uuid>` replay + SSE live-tail
- additive list endpoints (`/plans`, `/phases`, `/tasks`, `/agent-runs`) and artifact streaming
- contract/DB/route test coverage

Worker 2's first commit is the TUI bootstrap: `apps/tui` package + data layer + app shell + placeholder screens proving the runtime boots, renders the plans list, and tails SSE into a panel on plan detail.
