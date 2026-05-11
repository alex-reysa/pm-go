# Build the pm-go Desktop read-only API data layer

## Objective

Replace the M2 fixture-only Desktop route data with live API-backed read models while preserving the same information architecture and keeping Desktop read-only. After this milestone, an operator can attach to a running pm-go API, see real plans in Runs List, open a run cockpit reconstructed from durable HTTP reads, inspect task/review/agent-run/budget/approval/evidence state, and recover cleanly from expected API errors.

This spec is M3 only. M4 operator actions, M5 evidence/path-opening polish, and M6 SSE live updates are separate specs.

## Scope

- **Desktop API client module** under `apps/desktop/src/renderer/api/` or an equivalent local renderer-owned package area. Copy/adapt the existing TUI patterns from `apps/tui/src/lib/api.ts` and `apps/tui/src/lib/events.ts`; do not extract a shared client package in this milestone unless the planner proves the scope stays smaller.
- **Base URL normalization** shared by attach probes, JSON reads, artifact reads, and future SSE setup. Keep the configured API base URL as Desktop-local config through the existing bridge.
- **`ApiError` equivalent** preserving HTTP status, parsed body, user-facing message, and request id when available. `409`, `403`, `404`, and `5xx` must be represented as recoverable route states, not blank screens.
- **Read-only HTTP clients** for:
  - `GET /plans`
  - `GET /plans/:planId`
  - `GET /phases?planId=:planId`
  - `GET /tasks?planId=:planId`
  - `GET /tasks/:taskId`
  - `GET /tasks/:taskId/review-reports`
  - `GET /agent-runs?taskId=:taskId`
  - `GET /approvals?planId=:planId`
  - `GET /plans/:planId/budget-report`
  - `GET /events?planId=:planId` as JSON replay only, not SSE
  - `GET /artifacts/:id`
- **Renderer read models** for run summaries, run cockpit, phases, tasks, task detail, approvals, budget, event replay, artifact/evidence content, and release readiness. Keep raw API payloads available where useful, but route components should render UI-focused view models.
- **Manual refresh** controls for run-scoped reads. Refresh should preserve the surrounding shell, selected route, and last known data where reasonable.
- **Fixture fallback only for tests and explicit disconnected/empty states.** Once attached to a valid pm-go API, route content should prefer live reads. Do not leave the M2 fixture warning visible on live-data routes.
- **New Spec route remains non-mutating** unless the planner keeps intake extremely narrow and isolated to `POST /spec-documents` + `POST /plans`. The default expectation for this spec is read-only; adding intake is optional and should be rejected if it expands task count or blurs M4 action scope.
- **Tests** for client URL normalization, error parsing, route loading/error states, and live-data view-model mapping. Mock `fetch`; do not require a real API for unit tests.
- **README decisions** appended under an `M3 decisions` section: API client location, query/cache strategy, fixture-to-live transition behavior, refresh behavior, and known API gaps.

## Out of Scope

- Operator action mutations:
  - `POST /tasks/:taskId/run`
  - `POST /tasks/:taskId/review`
  - `POST /tasks/:taskId/fix`
  - `POST /tasks/:taskId/approve`
  - `POST /plans/:planId/approve`
  - `POST /plans/:planId/approve-all-pending`
  - `POST /phases/:phaseId/integrate`
  - `POST /phases/:phaseId/audit`
  - `POST /phases/:phaseId/override-audit`
  - `POST /plans/:planId/complete`
  - `POST /plans/:planId/release`
- SSE subscription or reconnect behavior. JSON event replay is allowed; live streaming is M6.
- Path opening, local artifact URI dereferencing, filesystem reveal, shell execution, or direct worktree access.
- Direct Postgres, Temporal, Docker, or git access from Desktop code.
- Client-side duplication of deep server policy rules. Desktop may derive visible affordance states, but the API remains authoritative.
- Workflow Builder, graph editing, or graph execution.
- Global Approvals or global Artifacts outside a selected run.
- Pixel-perfect final visual redesign.

## Constraints

- **Desktop remains attach-first.** It must only talk to the configured pm-go HTTP API after `/health` proves `service: "pm-go-api"`.
- **No direct orchestration from Desktop.** Do not add Postgres clients, Temporal clients, Docker commands, worktree mutation, shell execution, or arbitrary filesystem reads.
- **Use existing contracts where available.** Prefer `@pm-go/contracts` types and existing TUI read shapes over hand-written drift-prone aliases. When the API returns summary projections not represented directly in contracts, define narrow local types and document the gap.
- **Keep route recovery explicit.** Loading, empty, not found, forbidden, conflict, and server-error states must keep the shell/nav mounted.
- **Artifact reads are inert.** Fetch content only through `GET /artifacts/:id`; render text/JSON/Markdown safely without `dangerouslySetInnerHTML` or remote-resource loading.
- **Do not invent validation commands.** Use only the commands listed under Acceptance Criteria. The known-bad shape `pnpm test --filter <pkg>` must not appear in any task; use `pnpm --filter <pkg> test`.
- **Stop for API gaps.** If a required display cannot be implemented from current endpoints, record the API gap in `apps/desktop/README.md` and render a recoverable limitation state. Do not bypass the API.

M3 stop-and-re-plan triggers from `docs/desktop/08-dogfood-plan.md`:

- A required display cannot be implemented without a new API endpoint and the plan tries to bypass the API.
- The API client starts embedding deep server policy logic.
- Desktop stores copied run state as authority in local config.

Cross-milestone stop triggers:

- Plan contains direct Desktop access to Postgres, Temporal, Docker, worktree mutation, shell execution, or arbitrary filesystem reads.
- A task needs manual DB mutation to continue.
- Implementation introduces a second source of truth for plans, tasks, approvals, audits, events, or artifacts.
- A missing API endpoint is worked around in Desktop instead of captured as an API improvement.
- Generated task graph has overlapping file scopes for unrelated Desktop subsystems.
- Validation commands are invented or use the known-bad `pnpm test --filter <pkg>` shape.

Task-count ceiling:

- Target **4-8 tasks** across **1-2 phases**. Reject plans above 10 tasks unless the extra tasks are purely test/docs split-outs with disjoint file scopes.

## Acceptance Criteria

- `pnpm --filter @pm-go/desktop typecheck` passes.
- `pnpm --filter @pm-go/desktop test` passes, including API-client and route loading/error-state tests.
- `pnpm --filter @pm-go/desktop build` passes.
- `pnpm typecheck` passes.
- `pnpm test` passes, or any known flaky failure is rerun at the package level and documented with exact failing test names.
- Runs List loads real plans from the configured API after attach.
- Selecting a real run reconstructs the cockpit from durable API reads: plan detail, phases, tasks, approvals, budget, events replay, and release/audit context when available.
- Task detail shows task, latest agent run, latest lease if returned, latest review, policy decisions when returned, review history, and related agent runs when available.
- Evidence/artifact routes fetch content only through `GET /artifacts/:id` and render missing/failed artifact reads as recoverable UI states.
- Manual refresh re-reads run-scoped data without resetting the selected route.
- `409`, `403`, `404`, and `5xx` read failures are visible, recoverable states.
- M3 decisions and API gaps are recorded in `apps/desktop/README.md`.

Manual validation:

- Start the pm-go stack outside Desktop with Codex-backed runtime.
- Open a historical or active plan and compare visible state with the TUI/API responses.
- Use a missing plan id or artifact id and confirm the route stays recoverable.
- Confirm Runs List still has no permanent right inspector and no event drawer.

## Repo Hints

Required source docs:

- `docs/desktop/03-information-architecture.md` — route ownership, progressive disclosure, event drawer rules, inspector rules.
- `docs/desktop/04-desktop-architecture.md` — Electron boundaries, preload bridge, local config, security defaults.
- `docs/desktop/05-api-integration.md` — endpoint contracts, error handling, read models, JSON event replay, artifact safety.
- `docs/desktop/08-dogfood-plan.md` — M3 milestone definition and stop triggers.

Existing implementation context:

- `apps/desktop/src/renderer/App.tsx` — post-attach route tree wiring.
- `apps/desktop/src/renderer/routes/**` — M2 route surfaces currently backed by fixtures.
- `apps/desktop/src/renderer/fixtures/**` — M2 mock data and shapes; keep for tests/disconnected states only.
- `apps/desktop/src/renderer/layout/**` — shell, selected-run layout, drawer, inspector, confirmation modal.
- `apps/desktop/src/renderer/bridge.ts` — typed renderer access to preload bridge.
- `apps/desktop/src/shared/*` — shared health/config/url types.
- `apps/tui/src/lib/api.ts` — existing HTTP client and `ApiError` patterns.
- `apps/tui/src/lib/events.ts` — existing SSE/event parsing patterns; use only the JSON replay concepts in M3.
- `apps/desktop/test/renderer/**` — route tests to extend.
- `apps/desktop/README.md` — append M3 decisions.

Likely files to create or modify:

- `apps/desktop/src/renderer/api/**`
- `apps/desktop/src/renderer/read-models/**` or route-local view-model helpers
- `apps/desktop/src/renderer/routes/**`
- `apps/desktop/src/renderer/layout/**` only where refresh/error shell integration requires it
- `apps/desktop/src/renderer/fixtures/**` only to mark fixture fallback/test use
- `apps/desktop/test/renderer/**`
- `apps/desktop/README.md`
- `apps/desktop/package.json` only if adding a query/cache dependency is justified and contained

Validation commands, and only these:

```sh
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop build
pnpm typecheck
pnpm test
```

## Open Questions

The plan must settle these in `apps/desktop/README.md`:

- **Cache/query strategy**: plain hooks + `useEffect`, TanStack Query, or another already-accepted lightweight approach. Prefer the smallest choice that supports refresh and recoverable loading/error states.
- **Live/fixture boundary**: how route components switch from M2 fixture data to live API data while preserving tests.
- **API gaps**: whether missing run-list context, artifact metadata, or phase/task counts are surfaced as limitations or deferred API-improvement specs.
- **Event replay**: whether M3 stores the JSON replay cursor in memory only or simply refreshes full replay per route load. SSE cursor persistence belongs to M6.
- **New Spec intake**: keep mocked/non-mutating by default unless the plan can add narrow intake without expanding beyond M3 read-model scope.
