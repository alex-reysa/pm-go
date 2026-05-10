# pm-go Desktop MVP Scope

## Objective

Build the first pm-go Desktop MVP as an attach-first Electron operator console
for an already-running pm-go control-plane API.

The MVP should make the clean operator loop usable without terminal keybinds or
manual API calls: create a new spec-backed run, inspect the runs list, operate a
run cockpit, inspect task/review/evidence state, approve gates, inspect
artifacts, and manage connection settings.

The app must not become a second orchestrator. Durable pm-go state remains in
Postgres and is accessed only through `apps/api`. The API, worker, Temporal,
Docker, worktrees, policy engine, audits, and release workflows remain owned by
the existing stack.

## Scope

MVP Desktop includes:

- Attach to a running pm-go API, defaulting to `http://localhost:3001`.
- Validate `/health` identity before treating the API as connected.
- Persist Desktop-local preferences such as API base URL, recent repo roots,
  recent spec paths, selected editor, window state, and last selected run.
- Create a new run by selecting a local repo root, selecting or pasting a spec,
  calling `POST /spec-documents`, then calling `POST /plans`.
- List existing runs from `GET /plans`, ordered for operator resumption.
- Open a run detail shell backed by `GET /plans/:planId`, `GET /phases`,
  `GET /tasks`, `GET /approvals`, `GET /plans/:planId/budget-report`, and
  `GET /events?planId=:planId`.
- Subscribe to run events through SSE, with replay using `sinceEventId` and a
  polling fallback when streaming is unavailable.
- Drive valid operator actions through the API: run task, review task, fix task,
  approve task, approve plan, bulk approve eligible pending approvals,
  override review, integrate phase, audit phase, override phase audit, complete
  plan, and release plan.
- Inspect task details, file scope, acceptance criteria, budget, branch name,
  worktree lease path, latest agent run, review report, and related artifacts.
- Inspect review reports, phase audits, completion audits, release evidence,
  budget reports, policy decisions, and workflow events through progressive
  disclosure.
- Open or reveal trusted repo/worktree paths through Electron main process host
  integrations after path validation. Reveal artifact paths only when trusted
  artifact path metadata exists; artifact content itself is fetched through the
  API.
- Present recoverable API, SSE, artifact, and action-precondition failures as
  operator-readable states.

## Out of Scope

MVP Desktop does not include:

- Starting, stopping, repairing, or supervising Docker, Postgres, Temporal, the
  API, the worker, or drive loops.
- Calling Temporal, Postgres, Docker, `tctl`, or git worktree operations
  directly from Desktop.
- Installing or upgrading the pm-go CLI.
- Credential or runtime management for model providers.
- Multi-user collaboration, hosted control planes, or cross-repo execution
  graphs.
- A permanent right inspector on the dashboard.
- A dashboard-first product home. The MVP starts at Attach when disconnected
  and Runs after successful attachment.
- Global Approvals or Artifacts as required primary routes. Approval and
  evidence views are run-scoped first.
- A global event drawer. Events belong only to selected-run routes.
- A terminal-style live log screen as a primary workflow.
- Direct editing, cleaning, deleting, committing, or merging of task worktrees.
- Autonomous deploys or production release publishing.
- Executable Workflow Builder behavior.
- Node-based Workflow Builder as a core MVP screen.
- Runtime/model/provider policy management, sandbox configuration,
  notifications policy, or credential management.
- Generic cancel, stop, continue, retry, lease extension, run-to-completion, or
  drive-loop controls unless a separate API/product spec adds explicit
  endpoints.

If a Workflow Builder preview is included during MVP development, it must be a
read-only Level 1 visualization or prototype behind clear boundaries. It must
not execute plans, mutate runs, replace the cockpit, or become required for the
operator loop.

## Current MVP Action Set

These are the only mutating actions Desktop should expose in MVP. All require
confirmation, server-authoritative API handling, and a refresh after success or
`409`.

| UI action | API endpoint | MVP notes |
|---|---|---|
| Create spec document | `POST /spec-documents` | Intake only; repo path comes from a native picker. |
| Start plan | `POST /plans` | Opens the new run detail shell and tolerates persistence delay. |
| Audit stored plan | `POST /plans/:planId/audit` | Optional planning validation; deterministic and synchronous. |
| Run task | `POST /tasks/:taskId/run` | Only shown when the owning phase appears executable. |
| Review task | `POST /tasks/:taskId/review` | Only shown for review-ready task state. |
| Fix task | `POST /tasks/:taskId/fix` | Only shown when current state asks for fixes. |
| Approve task gate | `POST /tasks/:taskId/approve` | Human gate; reason display comes from approval state. |
| Override review | `POST /tasks/:taskId/override-review` | Advanced action; requires reason and must surface budget/scope refusal. |
| Integrate phase | `POST /phases/:phaseId/integrate` | Phase-level confirmation. |
| Audit phase | `POST /phases/:phaseId/audit` | Phase-level confirmation. |
| Override phase audit | `POST /phases/:phaseId/override-audit` | Advanced action; requires reason and audit context. |
| Approve plan gate | `POST /plans/:planId/approve` | Plan-scoped human gate. |
| Bulk approve pending gates | `POST /plans/:planId/approve-all-pending` | Requires reason; skipped rows must be shown. |
| Complete plan | `POST /plans/:planId/complete` | Locked until all phases are complete. |
| Release plan | `POST /plans/:planId/release` | Locked until latest completion audit outcome is `pass`. |

Reject, request changes from an approval queue, cancel/stop, generic continue,
retry aliases, lease extension, and stack repair are not MVP actions unless
the control-plane API adds explicit contracts for them.

## Primary User Flows

### Attach To API

1. User opens Desktop.
2. App loads saved API base URL or defaults to `http://localhost:3001`.
3. App probes `GET /health`.
4. If the API identifies as `pm-go-api`, the user lands on the runs list.
5. If unreachable or foreign, the user sees an attach screen with the base URL,
   retry control, and command hints such as `pm-go run --repo <repo>`.

### Create New Run

1. User chooses "New Spec".
2. User selects a repo root with a native directory picker.
3. User selects a spec Markdown file or pastes spec text.
4. App submits `POST /spec-documents` with title, body, absolute repo root, and
   `source: "manual"`.
5. App submits `POST /plans` with the returned spec document and repo snapshot.
6. App opens the new run detail shell and shows planning state until durable
   plan state is readable.

### Resume Existing Run

1. User opens the runs list.
2. User scans run status, updated time, repo/spec identity, and attention state.
3. User selects a run.
4. App opens the run detail shell, loads plan/phase/task/approval/budget state,
   and starts SSE from the last known event cursor.

### Operate Run Cockpit

1. User sees one clear answer at the top: current run state, blocked reason or
   next valid action, and release readiness.
2. User reviews phase progress and task rows grouped by phase.
3. User expands details only when needed: event drawer, task detail, approvals,
   budget, review report, audit report, or artifacts.
4. User triggers an available action from the relevant row or action area.
5. App opens a confirmation modal, sends the API mutation, refreshes state, and
   surfaces any `409` server precondition message inline.

### Inspect Task, Review, And Evidence

1. User opens a task detail view from the cockpit.
2. App shows task title, slug, status, phase, file scope, acceptance criteria,
   budget, branch/worktree, latest agent run, and latest review outcome.
3. User opens review findings, fix history, artifacts, worktree location, and
   related workflow events on demand.
4. User can run, review, fix, approve, override review, or open trusted paths
   only when those actions are valid for the current task state.

### Approve Gates

1. User sees pending approval count and highest-risk approval on the cockpit.
2. User opens the approvals screen or drawer.
3. App lists plan-scoped and task-scoped approvals with risk, reason, scope, and
   current status.
4. User approves one request or bulk approves eligible pending requests.
5. App displays skipped bulk-approval rows and reasons returned by the API.

### Complete And Release

1. User sees completion available only when every phase is completed.
2. User confirms completion to run `POST /plans/:planId/complete`.
3. App renders completion audit outcome, findings, summary, and artifact IDs.
4. User sees release available only when the latest completion audit outcome is
   `pass`.
5. User confirms release to run `POST /plans/:planId/release`.
6. App shows release evidence and artifact access without claiming success before
   durable release state exists.

### Restart And Recover

1. User closes and reopens Desktop.
2. App reloads local preferences, reconnects to the API, and reloads durable run
   state.
3. If SSE reconnects, the app replays missed events using `sinceEventId`.
4. If work has stalled, the app surfaces stack health hints and points to
   `pm-go status` or `pm-go doctor` instead of trying to repair the stack.

## Screens

### Attach Screen

Purpose: connect to an already-running pm-go API.

Required content:

- API base URL input.
- Connection state: not configured, probing, connected, unreachable, foreign
  service, API error, or stream reconnecting.
- `/health` identity result when available.
- Retry action.
- Command hints for starting the stack outside Desktop.

### Runs List

Purpose: choose or resume a run.

Required content:

- Runs from `GET /plans`.
- Status, title, repo/spec identity when available, updated time, and attention
  indicators for blocked work, pending approvals, failed audits, or release
  readiness.
- "New Spec" action.
- Settings access.

Progressive disclosure rule: no permanent right inspector on this dashboard.
Selecting a run opens the cockpit.

### New Spec

Purpose: submit a feature spec against a selected local repo.

Required content:

- Repo root picker.
- Spec file picker and paste/edit field. The renderer must not read the file
  directly; the main/preload bridge should return validated spec data.
- Derived title with editable override.
- Submit state for `POST /spec-documents` and `POST /plans`.
- Inline validation for missing repo, missing spec body, unreachable API, and
  API errors.

### Run Detail / Cockpit Overview

Purpose: operate one selected run from current state to release evidence.

Run Detail is the selected-run shell. The Cockpit is its default Overview
section: it answers what is happening, what needs attention, and what can
safely happen next. Other run sections handle Plan/Phases, Tasks, Approvals,
Budget, Evidence, Artifact Detail, and Release.

Required content:

- Run header with title, status, repo identity, current phase, updated time, and
  release readiness.
- Single next-action or blocker summary.
- Phase list with progress and integration/audit state.
- Task rows grouped by phase with status, review state, risk/approval markers,
  and action affordances.
- Pending approval summary.
- Budget summary.
- Completion/release summary when completion audit exists.
- Event drawer collapsed by default and visible only on selected-run routes.

Progressive disclosure rule: this screen shows the operator loop first. Details
open in drawers, modals, or dedicated views only when selected.

### Task Detail

Purpose: inspect and operate one task.

Required content:

- Task identity, phase, status, file scope, acceptance criteria, risk, budget,
  branch, worktree lease path, and latest agent run.
- Latest review report outcome and findings.
- Fix cycle state when applicable.
- Related artifacts and events.
- Valid task actions: run, review, fix, approve, reasoned override review,
  open worktree, reveal worktree.

### Approvals

Purpose: resolve human policy gates.

Required content:

- Pending and decided approval requests from `GET /approvals?planId=:planId`.
- Scope, risk, reason, requested time, decided time, and approver.
- Approve task, approve plan, and bulk approve eligible requests.
- Skipped bulk-approval result details.

### Artifacts And Evidence

Purpose: inspect durable evidence without reading raw files manually.

Required content:

- Artifact list by context: task, review, phase audit, completion audit, release.
- Artifact ID, kind/title when available, created time when available, and source
  context.
- Text/markdown viewer that renders generated content inertly.
- Fetch error state that preserves surrounding audit or release context.
- Reveal/open action only when a trusted local path is available from API state
  or a future metadata endpoint and validated by the main process. Current
  artifact content fetches must still go through `GET /artifacts/:id`.

### Settings

Purpose: manage Desktop-local preferences.

Required content:

- API base URL.
- Recent repo roots and spec paths.
- Editor preference: VS Code, Cursor, or system default folder opener.
- Terminal preference if supported.
- Dev-only feature flags if any.
- Clear connection test action.

Settings must not become runtime, model, sandbox, approval-policy,
notification, stack-supervision, or durable-run-state configuration in MVP.

## Functional Requirements

### FR-01 API Attachment

Desktop must attach to a configured HTTP API base URL and verify `GET /health`
returns the pm-go identity envelope before enabling product screens.

### FR-02 Local Preferences

Desktop must persist only local UI and connection preferences under Electron
`userData`. It must not persist durable pm-go run state.

### FR-03 Spec Submission

Desktop must create new runs through `POST /spec-documents` followed by
`POST /plans`. The repo root sent to the API must be an absolute path selected
by the user.

### FR-04 Runs List

Desktop must list runs using `GET /plans` and allow resuming an existing run
without requiring terminal commands or workflow IDs.

### FR-05 Run Cockpit State

Desktop must reconstruct the cockpit from API reads, including plan, phases,
tasks, approvals, budget report, completion audit, artifacts, and events.

### FR-06 Event Updates

Desktop must subscribe to `GET /events?planId=:planId` with
`Accept: text/event-stream`, maintain a per-run event cursor, replay missed
events with `sinceEventId`, and fall back to conservative polling when SSE is
unavailable.

### FR-07 Server-Authoritative Actions

Desktop may disable obviously invalid actions client-side, but every mutation
must treat the API as authoritative. `409` responses must be shown inline and
must trigger a refresh of the relevant plan, phase, or task state.

### FR-08 Task Operations

Desktop must support task run, review, fix, approve, and reasoned review
override flows through API endpoints when server state makes those flows valid.

### FR-09 Phase Operations

Desktop must support phase integrate, phase audit, and reasoned audit override
flows through API endpoints when server state makes those flows valid.

### FR-10 Plan Operations

Desktop must support plan approval, bulk approval, completion audit, and release
flows through API endpoints. Release must remain locked until the latest
completion audit outcome is `pass`.

### FR-11 Evidence Inspection

Desktop must make review reports, phase audits, completion audits, budget
reports, policy decisions, agent runs, workflow events, and artifacts reachable
from the cockpit without making raw logs the primary interface.

### FR-12 Progressive Disclosure

Desktop must keep the runs list and run cockpit focused. It must not place a
permanent right inspector on the dashboard, and the event drawer must be
collapsed by default and limited to selected-run routes.

### FR-13 Host Path Safety

Desktop must open or reveal only trusted absolute paths from user selection or
pm-go API state. The renderer must request these operations through a narrow
preload bridge; it must not receive direct filesystem or shell access.

### FR-14 Restart Recovery

Desktop must recover from app restart by reconnecting to the API and rebuilding
all visible run state from durable API reads.

### FR-15 Failure States

Desktop must render explicit states for API unreachable, foreign service, API
error, stream reconnecting, stale/no progress, artifact fetch failure, action
precondition failure, missing worktree path, and editor launch failure.

## Acceptance Criteria

- A user can start `pm-go run --repo <repo>` outside Desktop, open Desktop,
  attach to `http://localhost:3001`, and see existing runs from `GET /plans`.
- A user can create a new run from a local repo and spec file without writing
  curl commands; Desktop submits the spec document, starts the plan, and opens
  the run cockpit.
- The run cockpit shows current status, next valid action or blocker, phases,
  tasks, pending approvals, budget state, completion audit state, and release
  readiness from API state.
- The event drawer is collapsed by default, can be opened on demand, and resumes
  after reconnect using the last event cursor.
- Task detail exposes file scope, acceptance criteria, worktree lease, latest
  agent run, review outcome, review findings, artifacts, and valid task actions.
- Mutating actions require confirmation and show server `409` messages inline
  without losing the current screen context.
- Approval flows show enough context for a human decision and display skipped
  rows from bulk approval.
- Completion and release are gated by durable audit evidence; release cannot be
  triggered until the latest completion audit outcome is `pass`.
- Closing and reopening Desktop restores connection preferences and reloads
  run state from the API without relying on cached UI state.
- When the API is unreachable or a foreign service owns the port, Desktop stays
  on the attach screen and gives actionable stack-start or port-change hints.
- When the API is unreachable, Desktop shows hints only. It must not launch
  `pm-go`, Docker, Temporal, Postgres, the API, or the worker as a hidden
  recovery side effect.
- No MVP screen requires Workflow Builder usage to operate a run.
- The implementation does not modify worktrees directly and does not call
  Temporal, Postgres, Docker, or git plumbing from the renderer.
- Electron security defaults are verifiable: `contextIsolation: true`,
  `nodeIntegration: false`, no raw IPC exposure, and path/file operations only
  through typed preload allowlists.
- Override flows collect durable reasons, show server refusal messages inline,
  and never bypass budget, scope, or audit blockers client-side.

## Constraints

- The MVP is attach-first. Users must start the stack outside Desktop with the
  CLI or existing dev commands.
- The API is the only product boundary for run state and mutations.
- Desktop must follow Electron security constraints from the architecture doc:
  `contextIsolation: true`, `nodeIntegration: false`, strict IPC allowlists, and
  no raw host capabilities in the renderer.
- The app must work as a pure client even if later releases add supervised stack
  startup.
- Artifact content is untrusted generated content and must be rendered inertly.
- Client-side gates are convenience only; server state and server errors decide
  what is valid.
- The UI should optimize for local dogfood on pm-go itself before broad
  packaging, code signing, auto-update, or remote control planes.
- Screens should have one primary purpose each. Dense diagnostics, logs, raw
  events, and artifact metadata belong behind explicit disclosure controls.

## Repo Hints

- Product intent: `docs/desktop/01-product-brief.md`.
- Desktop architecture boundary: `docs/desktop/04-desktop-architecture.md`.
- Current API surface: `docs/specs/control-plane-api.md`.
- Existing operator model: `apps/tui/README.md`.
- TUI API client patterns: `apps/tui/src/lib/api.ts`.
- TUI SSE replay/reconnect patterns: `apps/tui/src/lib/events.ts`.
- TUI action gates: `apps/tui/src/lib/state-machines.ts`.
- TUI screen decomposition to translate, not copy wholesale:
  `apps/tui/src/screens/plans-list.tsx`,
  `apps/tui/src/screens/plan-detail.tsx`,
  `apps/tui/src/screens/task-drawer.tsx`,
  `apps/tui/src/screens/approvals.tsx`, and
  `apps/tui/src/screens/release-screen.tsx`.
- CLI stack lifecycle remains outside MVP Desktop; use README command examples
  such as `pm-go run --repo <repo>` and `pm-go doctor` as hints, not as hidden
  Desktop subprocess behavior.

## UI Draft Alignment Notes

The prototype under `front-end/` is a useful design artifact, not the MVP
source of truth. When translating it:

- Add Attach before any product screen; the draft currently starts on
  Dashboard.
- Treat Dashboard as a possible later post-attach runs summary, not the MVP
  landing route.
- Move the draft's global Approvals and Artifacts concepts into run-scoped
  Approvals and Evidence first.
- Keep the phase/timeline cockpit idea if it helps the Overview answer the next
  action or blocker, but do not require every subsystem on the first screen.
- Replace draft Workflow Builder save/override language with a hidden or
  clearly optional read-only preview.
- Replace draft Settings runtime/sandbox/notifications controls with
  Desktop-local preferences.
- Keep the draft's task inspector pattern as an optional run-scoped disclosure
  surface, closed by default.

## Risks

- API shape may not expose every display field needed for a polished desktop
  cockpit, especially repo/spec labels, artifact titles, or worktree root
  metadata.
- Attaching to an already-running stack creates onboarding friction, but avoids
  mixing UI work with process supervision in the first slice.
- A desktop UI can tempt scope creep into logs, workflow graphs, and stack
  repair. The MVP should keep those behind hints or future work.
- SSE reconnect and polling fallback can create stale or duplicated event UI if
  the event cursor is not treated carefully.
- Artifact and generated markdown rendering can become a security issue if the
  renderer treats agent output as trusted HTML.
- Bulk approval must preserve the API's skipped-row semantics so the UI does
  not imply more work was approved than the server accepted.
- Workflow Builder prototypes could distract from the dogfood operator loop if
  they are presented as a primary path.

## Open Questions

- Which fields should `GET /plans` expose for repo root, spec title, and
  attention state so the runs list does not need extra per-run requests?
- Should Desktop initially copy the TUI API/SSE client patterns, or should a
  shared client package be extracted before the first Electron implementation?
- What is the minimum artifact metadata needed for a useful evidence browser?
- What should be the stable API for discovering trusted worktree roots and stack
  instance metadata?
- Which editor integrations are required for first dogfood: VS Code, Cursor,
  system default opener, or all three?
- Which post-MVP milestone should evaluate a read-only plan graph after the
  cockpit is proven?
