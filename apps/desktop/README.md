# `@pm-go/desktop`

Electron + React desktop shell for pm-go. M0 is a scaffold: the
shared modules every later task imports (`HealthEnvelope` guard,
`normalizeBaseUrl`, the `Config` schema, the `AttachState` union)
are landed and unit-tested, and `dev` / `build` / `typecheck` /
`test` scripts exist so the workspace recognises the package.
Phase 1 fills in the actual main / preload / renderer behaviour.

## M0 decisions

These are intentionally written down here (and not just in the task
spec) so the next implementer can reconstruct the "why" without
re-reading the M0 PR.

### Package name

`@pm-go/desktop` — matches the rest of the monorepo's
`@pm-go/<app-or-package>` convention (`@pm-go/api`, `@pm-go/tui`,
`@pm-go/worker`, `@pm-go/contracts`, ...).

### Script names

| Script      | Command                          | Phase-1 expectation                                  |
| ----------- | -------------------------------- | ---------------------------------------------------- |
| `dev`       | `electron-vite dev`              | Launches Electron with HMR for the renderer.          |
| `build`     | `electron-vite build`            | Produces a packageable build under `out/`.            |
| `typecheck` | `tsc -p tsconfig.json --noEmit`  | Same shape as every other workspace's typecheck.      |
| `test`      | `vitest run --passWithNoTests`   | Unit tests under `test/shared/**` (M0) and `test/**` (later). |

The root `package.json` adds a `dev:desktop` alias that fans out to
`pnpm --filter @pm-go/desktop dev`, matching the existing
`dev:api` / `dev:worker` conventions.

### API-client strategy

**Local minimal `apiFetch` copy.** Phase 1 will copy the parts of
`apps/tui/src/lib/api.ts` it actually needs (the `ApiError` class,
`parseJsonSafe`, and the read-only `getJson` helper) into
`apps/desktop/src/main/apiClient.ts` rather than extracting a
`@pm-go/api-client` package.

Rationale: the TUI and desktop targets diverge in non-trivial ways
(the TUI never needs to surface a "foreign service" attach state;
the desktop will probably want streaming SSE for live workflow
events that the TUI doesn't). Extracting a shared package now would
either grow a kitchen-sink interface or force both sides to import a
package with optional fields they don't use. A local copy keeps the
contracts narrow until phase 2 sees a real second consumer that
justifies the shared package.

The shared **contracts** still come from `@pm-go/contracts` — only
the HTTP plumbing is copied.

### Renderer test harness

**Vitest.** Matches the rest of the monorepo (TUI, API, packages).
For renderer component tests we'll add `jsdom` + `@testing-library/react`
in phase 1 when there's an actual component to render; M0's `test`
script passes `--passWithNoTests` and the only suites live under
`test/shared/**`, which are pure-Node and need no DOM.

We considered Playwright for end-to-end coverage. Deferred to phase
3+ — the M0 scope is too small to justify a second test runner.

### Bundler choice

**electron-vite.** Wired via `apps/desktop/electron.vite.config.ts`.
The competing option was "Vite + Electron Forge". electron-vite
wins at M0 because:

- It is one tool, one config — three Vite roots (main, preload,
  renderer) wired into one `dev` / `build` command. Forge requires
  a separate maker/publisher config block to do equivalent work,
  and we don't need maker artifacts until milestone "ship a DMG".
- The renderer's React HMR works out of the box; with Forge we'd
  layer `@electron-forge/plugin-vite` on top, which is roughly
  electron-vite with more YAML.
- Migration cost when we DO need Forge (signed installers) is one
  PR — Forge can consume the Vite config we already have.

`vite.config.ts` is included in `fileScope` for completeness but
not authored at M0; electron-vite's three-root config supersedes
it. Phase 1 may add it back if renderer-only tooling (e.g. Storybook)
benefits from a standalone Vite config.

### Config storage location

`app.getPath('userData')/config.json` — the Electron-blessed
per-user, per-platform path. Concretely:

- macOS: `~/Library/Application Support/pm-go/config.json`
- Linux: `~/.config/pm-go/config.json`
- Windows: `%APPDATA%/pm-go/config.json`

The parser (`src/shared/config.ts`) is forgiving: a missing field
falls back to the default, and `apiBaseUrl` is run through
`normalizeBaseUrl` so a partial write or a hand-edited file with
a trailing slash still produces a canonical value at runtime.

Default `apiBaseUrl` is `http://localhost:3001`, matching the API's
default bind port.

## Layout

```
apps/desktop/
├── README.md                    # this file
├── package.json
├── tsconfig.json
├── electron.vite.config.ts      # bundler (M0 chosen tool)
├── index.html                   # renderer HTML entry
├── src/
│   ├── main/index.ts            # stub — phase 1 owns electron bootstrap
│   ├── preload/index.ts         # stub — phase 1 wires contextBridge
│   ├── renderer/index.tsx       # stub — phase 1 mounts React tree
│   └── shared/                  # contracts shared across the three entrypoints
│       ├── attachState.ts       # AttachState union + label map
│       ├── config.ts            # Config schema + DEFAULT_CONFIG + parseConfig
│       ├── health.ts            # HealthEnvelope + isPmGoHealthEnvelope
│       └── url.ts               # normalizeBaseUrl
└── test/
    └── shared/                  # Vitest unit coverage for src/shared/**
        ├── health.test.ts
        └── url.test.ts
```

## What phase 1 owns

- Actual Electron bootstrap: `app.whenReady()`, `BrowserWindow`,
  preload `contextBridge` exposure.
- The `apiFetch` copy + identity-aware health probe loop wired to
  `AttachState`.
- React tree + first-screen UI keyed on `AttachState`.
- Config read/write at `app.getPath('userData')/config.json`.
- Renderer test harness (`jsdom` + Testing Library) for the first
  React component.

## M2 decisions

- **Router choice:** React Router v6 via `react-router-dom`. The
  renderer uses `HashRouter` by default because Electron loads the
  bundle from `file://`, while tests can inject static or memory
  routers. React Router keeps the nested `/runs/:planId/...` route
  tree explicit without adding another routing dependency.
- **Fixture module location:** mock renderer data lives under
  `apps/desktop/src/renderer/fixtures/`.
- **Drawer toggle implementation:** `EventDrawerProvider` owns the
  collapsed-by-default open state, `EventDrawerToggle` flips it, and
  `RunDetailShell` mounts the toggle plus drawer only for route ids in
  `DRAWER_ALLOWED_ROUTE_IDS`. `AppShell` passes `null` for top-level
  routes so Attach, Runs List, New Spec, and Settings never show the
  drawer affordance.
- **Inspector allowed routes:** `INSPECTOR_ALLOWED_ROUTE_IDS` contains
  `run.overview`, `run.phases`, `run.tasks`, `run.taskDetail`,
  `run.approvals`, `run.budget`, `run.evidence`,
  `run.artifactDetail`, and `run.release`. The top-level `attach`,
  `runs`, `runs.new`, and `settings` routes are intentionally absent.
- **Confirmation modal component:** shared mutating-action confirms use
  `ConfirmationModal`.
- **Markdown rendering:** M2 renders Markdown-like fixture content as
  inert preformatted text only. No raw HTML execution, remote resource
  loading, or Markdown runtime dependency is introduced before live
  artifact rendering lands.

## M3 decisions

- **API client location:** Desktop keeps its HTTP client in
  `apps/desktop/src/main/apiClient.ts` for M3. Renderer code asks the
  preload bridge for run data; it does not call the API directly, and
  no shared `@pm-go/api-client` package is introduced until a later
  milestone proves the Desktop and TUI clients have the same shape.
- **Query and cache strategy:** M3 uses a plain local query/cache layer
  in the Desktop main process: request helpers fetch JSON, normalize it
  to renderer DTOs, and retain the latest successful snapshot in memory
  per query key. No React Query, IndexedDB, SQLite, or durable cache is
  added for this milestone. A failed refresh leaves the last good
  snapshot visible with an error state attached so the renderer can
  recover without inventing fallback data.
- **Fixture-to-live boundary:** Fixtures remain renderer-only seed data
  for unimplemented views. When a live endpoint exists, the main process
  owns the fetch and the fixture path is disabled for that surface; if an
  endpoint is missing, the view is documented as fixture-backed or
  deferred instead of mixing live payloads with partial local
  reconstruction.
- **Manual refresh behavior:** M3 refresh is explicit and user-driven.
  The refresh action re-runs the relevant live query, updates the local
  cache only after a valid response is parsed, and reports stale/error
  state through the bridge. Desktop does not poll, retry in the
  background, or synthesize missing server state during M3.
- **JSON event replay:** Workflow event replay is stored as JSON event
  records returned by the API and cached in memory with the rest of the
  run snapshot. Desktop may parse those records for display, filtering,
  and inspector selection, but it does not persist a separate replay log
  or derive authoritative task/run state from replayed events.
- **New Spec intake:** New Spec is read-only in M3. The renderer may
  display the intake route, validation copy, and disabled controls, but
  it must not create plans, write specs, or post mutation requests until
  the API contract for spec submission is agreed.
- **Known API gaps:** Missing live run-list filters, artifact body
  retrieval, approvals mutation, budget/evidence detail shape, event
  pagination, and New Spec submission are recoverable API gaps or
  deferred specs. Desktop should surface those gaps as unavailable or
  fixture-backed states and wait for the API contract rather than
  bypassing the API with local filesystem reads, inferred mutations, or
  renderer-owned domain state.
