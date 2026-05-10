# Build the pm-go Desktop Electron shell and attach screen

## Objective

Create a secure Electron desktop package that attaches to an already-running
pm-go API and rejects unreachable or foreign services before showing product
routes.

This spec covers dogfood milestones M0 (docs / readiness / repo setup
decisions) and M1 (Electron shell and attach screen) combined per the "First
Spec Sketch" in `docs/desktop/08-dogfood-plan.md`. Subsequent milestones
(M2-M8) will each be a separate spec authored only after this run's evidence
is recorded.

## Scope

- Create `apps/desktop` workspace package, provisionally named `@pm-go/desktop`,
  with `dev`, `build`, `typecheck`, and `test` scripts.
- Update root workspace manifests so the new package is picked up by `pnpm`:
  `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` if its glob does
  not already match (`apps/*` currently matches).
- Add Electron main/preload/renderer entrypoints with `contextIsolation: true`,
  `nodeIntegration: false`, and no raw IPC exposed to the renderer.
- Add a narrow typed preload bridge limited to the M1 host capabilities
  (read/write Desktop-local config, invoke `/health` probe).
- Persist and edit the API base URL as a Desktop-local preference, defaulting
  to `http://localhost:3001`.
- Implement a `GET /health` probe that requires the response body to include
  `service: "pm-go-api"` and preserves `version`, `instance`, and `port` for
  diagnostics. Reject any other payload, even when the status is `2xx`.
- Render Attach screen states: `not_configured`, `probing`, `connected`,
  `api_unreachable`, `foreign_service`, and `api_error`. Each state must have a
  user-visible label and a retry path.
- Provide a Settings path or minimal attach-form control to change and retry
  the base URL.
- Render a post-attach placeholder route (a stub Runs route or labeled
  placeholder) that is reachable only after a successful pm-go identity probe.
- Add unit tests for: URL normalization, `/health` identity handling
  (`pm-go-api` accept; foreign-service reject), and Attach state transitions.

## Out of Scope

- Starting or stopping the pm-go stack from Desktop. The stack is started
  externally via `pm-go run --repo .` or `pnpm dev`.
- Listing plans, creating specs, or any other API call beyond `/health`.
- SSE subscription (`GET /events`).
- Operator mutations (run task, approve task, integrate phase, release plan,
  etc.). All mutations are deferred to M4.
- Artifact rendering, path opening, native repo/spec pickers.
- Workflow Builder, graph preview, and any node-vocabulary work (M7).
- Packaging beyond a development build. Production packaging is M8.
- Stack supervision, Docker management, or worker control from Desktop.

## Constraints

Hard constraints, applied to every task in this plan:

- **No direct Postgres, Temporal, Docker, worktree mutation, or arbitrary
  filesystem reads from Desktop.** The renderer must not have access to `fs`,
  `child_process`, `shell.openExternal`, or raw IPC. The main process may
  read/write only Desktop-local config under the user's app-data directory.
- **Do not invent validation commands.** Use only the commands listed under
  Acceptance Criteria. Reject `pnpm test --filter <pkg>` — use the workspace-safe
  shape `pnpm --filter <pkg> test`.
- **If a missing API endpoint blocks a UI surface, stop the run and file an
  API-improvement spec.** Do not work around it in Desktop. The only API call
  in this spec is `GET /health`.
- **Electron security defaults are non-negotiable**: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true` where compatible with the chosen
  bundler. Renderer must reach the API only through `fetch` to the configured
  base URL — no `file://` navigation, no remote module loading.
- **Health validation must reject legacy `{ "status": "ok" }` payloads.** Only
  responses including `service: "pm-go-api"` count as `connected`.

M0 / M1 stop-and-re-plan triggers (from `docs/desktop/08-dogfood-plan.md`
lines 212-217 and 287-293, quoted here so the planner sees them):

- The plan includes more than one product milestone beyond M0+M1.
- The plan omits workspace manifest files (`package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `apps/desktop/package.json`) while creating
  `apps/desktop`.
- The plan introduces stack supervision, direct DB access, or graph execution.
- The renderer needs raw Node access to pass tests.
- The spec tries to call `pm-go run`, Docker, Temporal, or Postgres from
  Desktop.
- Health validation accepts legacy `{ "status": "ok" }` in normal MVP mode.

Additional dogfood-plan ceilings:

- Total tasks in this plan must be **between 3 and 5**, inclusive. If the
  planner emits more than 5, stop and split.
- One phase is preferred. A clear two-phase split (package setup → shell) is
  acceptable but not required.

## Acceptance Criteria

- `pnpm --filter @pm-go/desktop typecheck` passes.
- `pnpm --filter @pm-go/desktop test` passes.
- `pnpm --filter @pm-go/desktop build` passes.
- `pnpm typecheck` (root) passes.
- `pnpm test` (root) passes for all existing packages — no regressions.
- `pnpm smoke:bundle-freshness` passes.
- `pnpm smoke:v082-features` passes.
- Manual attach validation:
  - Launching Desktop with **no service listening on the configured port**
    shows `api_unreachable` and offers a retry / settings affordance.
  - Launching Desktop against a **non-pm-go service** returning `2xx` from
    `/health` (e.g. a stub returning `{ "ok": true }`) shows
    `foreign_service` and does **not** unlock the post-attach route.
  - Launching Desktop against a **valid pm-go API** shows the identity
    envelope (`service`, `version`, `instance`, `port`) and unlocks the
    post-attach placeholder route.
- M0 decisions recorded in `apps/desktop/README.md` (or equivalent) and
  visible in the plan summary: package name, dev/build/typecheck/test script
  names, API-client strategy (local copy from `apps/tui` vs shared package —
  default: local copy), renderer test harness, and bundler choice.
- Final audit confirms zero direct DB, Temporal, Docker, or worktree
  references in any file under `apps/desktop/`.

## Repo Hints

Required source docs for the planner (in addition to this spec):

- `docs/desktop/01-product-brief.md` — product purpose and non-goals.
- `docs/desktop/02-mvp-scope.md` — MVP flows, screens, actions, out-of-scope
  boundaries.
- `docs/desktop/04-desktop-architecture.md` — Electron process boundaries,
  attach behavior, filesystem integration, security, packaging.
- `docs/desktop/05-api-integration.md` — `/health` envelope contract.
- `docs/desktop/08-dogfood-plan.md` — milestone M0 (lines 144-217) and M1
  (lines 218-294), including stop-and-replan triggers.
- `docs/roadmap/2026-04-25-dogfood-dev-plan.md` — dogfood cautions:
  no direct DB edits, no `pnpm test --filter` shape, package creation must
  include root workspace files in task file scopes.

Existing patterns to consult but **not import** in this spec:

- `apps/tui/src/lib/api.ts` — TUI API client shape. M3 may reuse; M1 only
  needs `/health` so a minimal local fetch is sufficient.
- `apps/api/test/health.test.ts` — confirms `/health` returns
  `{ service: "pm-go-api", status, version, instance, port }`. The Desktop
  probe's identity check must match this contract.
- `front-end/` — static JSX prototype committed in the baseline. **Reference
  only for IA ideas.** Do not import, build, or copy code from it.

Files the planner is expected to create or modify:

- `apps/desktop/package.json` (new)
- `apps/desktop/tsconfig.json` (new)
- `apps/desktop/src/main/**` (new — Electron main process)
- `apps/desktop/src/preload/**` (new — preload bridge)
- `apps/desktop/src/renderer/**` (new — React renderer + Attach screen)
- `apps/desktop/test/**` (new — unit tests)
- `package.json` (root — may need a workspace script alias)
- `pnpm-lock.yaml` (root — picks up new package)
- `pnpm-workspace.yaml` (only if the `apps/*` glob is changed; currently it
  matches and no change is expected)

Validation commands (these and only these):

```sh
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop build
pnpm typecheck
pnpm test
pnpm smoke:bundle-freshness
pnpm smoke:v082-features
```

## Open Questions

These do not block planning, but the plan must record a decision for each in
`apps/desktop/README.md` before M1 exits:

- **API client strategy for M1-M3.** Recommended: copy a minimal `apiFetch` +
  `ApiError` from `apps/tui/src/lib/api.ts` into `apps/desktop/src/renderer/lib/`
  rather than extracting a shared package. Extraction would widen this first
  slice beyond M0+M1.
- **Bundler choice.** Vite + Electron Forge, or `electron-vite`. Either is
  acceptable. Picker should justify in `apps/desktop/README.md`.
- **Renderer test harness.** Default: Vitest, matching the rest of the
  monorepo. Confirm during M0 and record.
- **Config storage location.** Default: `app.getPath('userData')/config.json`
  via the Electron main process. The renderer must access config only through
  the preload bridge.
