# pm-go Desktop Architecture

## Recommendation

Build the MVP desktop app as an Electron client for an already-running pm-go
control-plane API.

The desktop app should not supervise Docker, Postgres, Temporal, the API, or
the worker in the first slice. It should connect to `apps/api` over HTTP/SSE,
drive the same endpoints used by the TUI and CLI, and treat Postgres plus the
worker as external durable infrastructure.

This is conservative by design:

- It keeps Desktop inside the existing UI boundary: `apps/api` is already the
  operator and UI surface.
- It avoids a second process manager while `pm-go run`, `pm-go ps`,
  `pm-go stop`, and `pm-go doctor` continue to own local stack lifecycle.
- It makes dogfooding faster because failures stay attributable: if the API or
  worker is down, Desktop reports that instead of trying to repair it.
- It preserves a clean later path: the Electron main process can optionally
  call or wrap the existing supervisor once the attach-first UI is stable.

The tradeoff is that MVP users must start the stack first, usually with:

```text
pm-go run --repo <repo>
```

or:

```text
pnpm dev
```

Desktop should make that prerequisite visible and actionable, but it should not
hide stack boot complexity until the app has proved the operator loop.
`pm-go implement --repo <repo> --spec <spec>` may be useful for external
auto-drive demos, but it drives a run toward release itself and should not be
the normal Desktop attach prerequisite.

## Existing System Boundary

pm-go already separates the product loop into durable layers:

- `apps/api`: Hono control-plane API. It validates requests, starts Temporal
  workflows, signals blocked workflows, and reads durable state from Postgres.
- `apps/worker`: Temporal worker hosting planning, task execution, review,
  fix, integration, audit, completion, and release workflows.
- Postgres: source of truth for plans, tasks, approvals, policy decisions,
  worktree leases, reviews, audits, events, agent runs, and artifacts.
- Temporal: workflow execution and retry engine.
- `packages/worktree-manager`: git branch, worktree, lease, and diff-scope
  behavior.
- `apps/tui`: existing UI client. It consumes the same HTTP/SSE surface and
  contains no orchestration logic.
- `apps/cli`: stack supervision, diagnostics, drive loops, recovery, and
  process lifecycle.

Desktop should follow the TUI model: it is a richer operator surface, not a
new orchestrator.

## Electron Process Model

### Main Process

The Electron main process owns host integration and privileged operations:

- create and manage application windows
- load and persist Desktop-local configuration
- show native file and directory pickers for repo/spec selection
- probe and connect to the pm-go API
- open local paths in editors, terminals, Finder, or the OS file manager
- later, optionally start and stop a local pm-go stack
- enforce IPC allowlists between renderer and host capabilities

The main process may use Node APIs. It must not contain pm-go orchestration
logic. Starting tasks, reviewing tasks, approving gates, integrating phases,
auditing, completing, and releasing remain API calls.

### Renderer

The renderer owns product UI only:

- plan list and plan detail views
- phase and task status presentation
- progressive disclosure for task details, reviews, budgets, artifacts,
  approvals, and event history
- confirm flows for mutating actions
- forms for repo/spec submission
- connection state and recoverable errors

The renderer should not get direct Node access. It should not read the
filesystem, spawn processes, open arbitrary URLs, connect to Postgres, or talk
to Temporal.

### Preload

The preload script exposes a narrow, typed bridge:

- `config.get`, `config.update`
- `api.probe`, `api.setBaseUrl`
- `files.pickRepo`, `files.pickSpec`
- `files.readPickedSpec` or an equivalent picker result that returns validated
  `{ path, title, body }`
- `files.openPath`, `files.revealPath`
- `shell.openExternalSafe`
- later, outside MVP: `stack.start`, `stack.stop`, `stack.status`

The bridge should validate inputs before forwarding them to the main process.
It should expose specific operations, not raw `ipcRenderer`, `child_process`,
`fs`, or shell execution.

## Local Stack Connection

MVP Desktop should start in an "Attach to API" state:

1. Read the saved API base URL from Desktop config.
2. Default to `http://localhost:3001` when no config exists.
3. Probe `GET /health`.
4. Require the pm-go identity envelope when the API is launched through the
   current production entrypoint:
   `{ status: "ok", service: "pm-go-api", version, instance, port }`.
5. Treat legacy `{ status: "ok" }` as insufficient for Desktop MVP unless a
   dev-only override is explicitly enabled.
6. Once connected, read plans with `GET /plans` and subscribe to plan events
   only after a plan is selected.

The app should fail fast when another service owns the configured port. Match
the CLI's behavior: a 2xx `/health` response is not enough unless the service
identity is `pm-go-api`.

Connection states should be explicit:

- `not_configured`: no base URL saved
- `probing`: `/health` in flight
- `connected`: identity accepted
- `api_unreachable`: network error, refused connection, timeout
- `foreign_service`: HTTP response did not identify as `pm-go-api`
- `api_error`: pm-go API responded but a specific endpoint failed
- `stream_reconnecting`: HTTP reads work, SSE is reconnecting

MVP should not call Temporal, Postgres, Docker, or `tctl` directly. If the API
is healthy but workflows do not move, Desktop should surface that as a stack
health issue and point to `pm-go status` or `pm-go doctor`.

## Optional Stack Supervision

Stack supervision is a later feature and belongs in the Electron main process,
never in the renderer.

The later supervision boundary should reuse the CLI's ownership model instead
of duplicating it:

- Prefer invoking `pm-go run` as a tracked child process first.
- Keep `pm-go run` responsible for Docker startup, migrations, worker/API
  child processes, API identity probing, runtime env, and shutdown.
- Read process status through `pm-go ps --json` or a shared instance-state
  module once that surface is stable.
- Use `pm-go stop` for teardown rather than killing Docker or child PIDs
  independently.
- Use `pm-go doctor --repair` as an explicit repair action, not an automatic
  background side effect.

Later Desktop can offer "Start local stack" with clear controls:

- repo root
- runtime mode: `auto`, `stub`, `sdk`, `claude`
- API port
- database URL
- whether to run migrations
- whether to start Docker

The tradeoff: supervised startup improves onboarding, but it expands Desktop
from UI client to local process owner. That adds responsibility for logs,
crashes, orphan cleanup, port conflicts, Docker readiness, signal handling, and
multi-instance behavior. Those risks are not needed for the MVP UI.

## Configuration Storage

Desktop-local config should live under Electron's `app.getPath("userData")`.
It should store only UI and connection preferences:

- API base URL
- recent repo roots and spec file paths
- selected editor command or editor bundle id
- preferred terminal app
- window state
- last selected plan id
- feature flags for dev-only behavior

It should not store durable pm-go state. Plans, tasks, approvals, worktree
leases, reviews, audits, budget reports, events, and artifacts stay in
Postgres and are read through the API.

Secrets should not be stored in the config file. If Desktop later accepts
provider keys or tokens, use the OS keychain and pass values only to the
supervised child environment at launch time. The first MVP should avoid
credential management entirely by attaching to an already configured stack.

When stack supervision lands, Desktop should align with pm-go instance config
rather than creating a second instance model. The current CLI has helpers for
`~/.pm-go/instances/<name>/config.json`, and the supervisor/process commands
already track running processes. Desktop should consume that model once it is
the stable contract.

## API And SSE Client

Desktop should use the same control-plane API surface as the TUI:

- `GET /plans`
- `GET /plans/:planId`
- `GET /phases?planId=:planId`
- `GET /tasks?planId=:planId` and `GET /tasks/:taskId`
- `GET /agent-runs?taskId=:taskId`
- `GET /approvals?planId=:planId`
- `GET /plans/:planId/budget-report`
- `GET /artifacts/:id`
- `GET /events?planId=:planId`
- `GET /events?planId=:planId` with `Accept: text/event-stream`
- mutating POSTs for run, review, fix, approve, integrate, audit, complete,
  and release

The client should be extracted or shared from the TUI where practical. The TUI
already has useful behavior to preserve:

- base URL normalization
- JSON parsing with `ApiError`
- 409 errors surfaced as operator precondition failures
- artifact reads through `GET /artifacts/:id`
- SSE reconnect with `sinceEventId`
- event filtering for `phase_status_changed`, `task_status_changed`, and
  `artifact_persisted`

Desktop should maintain a per-plan event cursor. On reconnect, it should pass
`sinceEventId` so the server replays missed events. If SSE is unavailable, the
UI should degrade to polling `GET /plans/:id`, phases, tasks, approvals, and
budget report at a conservative interval.

The API remains authoritative. Client-side gating can disable obviously invalid
actions, but every mutation must still handle `409` and render the server's
actionable error.

## Filesystem And Worktrees

Desktop needs filesystem integration for selection and inspection, not for
orchestration.

MVP filesystem capabilities:

- choose a repo root with a native directory picker
- choose a spec document with a native file picker
- read the picked spec through the main/preload bridge after validating that it
  is a readable UTF-8 text/Markdown file within a reasonable size limit
- send the absolute repo path and validated spec body to `POST /spec-documents`
- open or reveal trusted repo/worktree paths that came from user selection or
  pm-go API state
- fetch artifacts through `GET /artifacts/:id`

The app should not scan the repository itself for planning context. The API
already captures the repo snapshot during `POST /spec-documents`.

Worktree behavior must stay under pm-go control:

- task branches and worktrees are created by orchestration
- worktrees are leased and tracked durably
- default task worktree root is `.worktrees`
- integration worktrees use `.integration-worktrees`
- agents must operate inside task file scopes
- dirty or stale worktrees are policy/recovery conditions, not UI cleanup
  shortcuts

Desktop can display the latest worktree lease path from `GET /tasks/:taskId`.
It can offer "Open Worktree" only for paths returned by the API and only after
path validation in the main process.

## Opening Editors And Worktrees

Opening local tools is useful, but it is a host capability and must go through
the main process.

MVP should support:

- reveal repo or worktree directories in the OS file manager
- open repo or worktree in a configured editor
- copy safe shell commands for manual use when direct opening fails
- reveal artifact directories only after a future artifact metadata endpoint or
  trusted API state exposes a contained local path; current artifact content is
  fetched through `GET /artifacts/:id`

Use a fixed allowlist of editor integrations:

- VS Code: `code <path>`
- Cursor: `cursor <path>`
- system default folder opener

Do not pass user-controlled strings through a shell. Use `spawn`/OS APIs with
argument arrays. Validate that the path is absolute, exists, and is within an
expected root before opening it. For worktrees, expected roots are the current
repo root and worktree lease paths returned by the API. Do not infer broad
filesystem roots from arbitrary renderer input. If Desktop later needs
`WORKTREE_ROOT`, `INTEGRATION_WORKTREE_ROOT`, or artifact roots, expose them
through an explicit API or instance metadata contract.

Desktop should never silently modify, clean, delete, or commit in a worktree.
Those remain pm-go workflow and runbook actions.

## Security Boundaries

Electron security defaults should be strict:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` where compatible
- no remote module
- no raw IPC exposed to the renderer
- CSP that disallows inline script and remote script
- navigation blocked except for the app origin
- `window.open` denied by default
- external links opened only after scheme allowlisting

Trust boundaries:

- Renderer UI is untrusted relative to the host OS.
- API responses are trusted as pm-go control-plane data, but file paths from
  responses still need validation before opening.
- Artifact content may contain markdown or text generated by agents. Render it
  as inert text/markdown, not executable HTML.
- Repo/spec paths selected by the user are local filesystem inputs. Store them
  as absolute paths and avoid shell interpolation.
- Desktop config is preferences, not authority. Durable state is the API.

The renderer must not have direct access to:

- `fs`
- `child_process`
- environment variables
- shell execution
- arbitrary `shell.openExternal`
- Postgres credentials
- Temporal address or client APIs

## Failure Modes

Desktop should make failures legible without becoming a terminal dashboard.

| Failure | MVP behavior |
|---|---|
| API unreachable | Show attach screen with base URL, retry, and command hint. |
| Foreign service on port | Show identity mismatch and ask user to change port or stop the other service. |
| API healthy, worker not moving | Show stale/no progress state; point to `pm-go status` and `pm-go doctor`. |
| SSE disconnect | Keep cached state visible, mark stream reconnecting, resume with `sinceEventId`. |
| POST returns `409` | Show server message inline; refresh the relevant plan/task/phase. |
| Plan persistence delay after submit | Show planning in progress and poll `GET /plans`; do not assume failure early. |
| Artifact fetch fails | Show artifact id and API error; keep release/audit context visible. |
| Worktree path missing | Disable open/reveal action and show that the lease path is unavailable. |
| Editor launch fails | Show the command target and offer reveal/copy fallback. |
| Desktop restart | Reload config, reconnect to API, and recover state from durable reads. |

No failure should require direct database inspection from the desktop app.
Runbook links or CLI command hints are acceptable for advanced recovery.

## Packaging And Distribution

Packaging assumptions for the MVP:

- Electron app ships as a local desktop UI only.
- It does not bundle Docker, Postgres, Temporal, or model runtimes.
- It does not install or update the pm-go CLI.
- It assumes the user has a pm-go checkout or installed `pm-go` command when
  they want to run the local stack.
- It connects to `http://localhost:3001` by default, with an editable base URL.
- It targets local development and dogfood use before code signing,
  auto-update, and hosted collaboration.

Later distribution can add:

- signed macOS builds
- auto-update
- CLI discovery and install checks
- supervised stack startup
- multi-instance selection
- bundled helper binaries where licensing and update policy are clear

The app should remain functional as a pure client even after supervised startup
exists. Operators should always be able to attach Desktop to a stack they
started manually.

## MVP Decisions

MVP decisions:

- Electron main/preload/renderer split with strict host capability boundaries.
- Attach to an already-running pm-go API first.
- Default API base URL: `http://localhost:3001`.
- Require `/health` identity for normal connections.
- Use HTTP reads/writes and SSE; no direct Temporal or Postgres access.
- Reuse or extract the TUI API/SSE client patterns.
- Store only Desktop-local preferences under Electron `userData`.
- Submit specs through `POST /spec-documents` and start plans through
  `POST /plans`.
- Display and open worktrees only from trusted API state.
- Keep UI progressive: summary first, details on demand, no dense terminal
  dashboard.

## Later Decisions

Later decisions:

- Supervise `pm-go run` from Electron main, or factor the CLI supervisor into a
  shared library.
- Add `pm-go doctor --repair` as an explicit Desktop action.
- Support multiple pm-go instances and instance selection.
- Persist shared instance config under the pm-go instance model.
- Add richer artifact viewers and diff views.
- Add terminal/log panes behind progressive disclosure.
- Add model/runtime credential management through the OS keychain.
- Add signed packaging and auto-update.
- Support remote or team-hosted control planes.

## Open Architecture Questions

- Should the first implementation extract the TUI API client into a shared
  package, or copy it into Desktop and extract after the first UI stabilizes?
- What should be the stable API for discovering worktree roots and stack
  instance metadata without reading CLI internals?
- Should Desktop support direct `pm-go drive` control later, or keep all
  operator actions as individual API mutations?
- Which editor integrations are in scope for the first dogfood build?
