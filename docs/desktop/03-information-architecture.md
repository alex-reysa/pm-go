# pm-go Desktop Information Architecture

## Purpose

This document defines the product and UX information architecture for the
pm-go Desktop MVP. It describes how the Electron app is organized, how an
operator moves through the product loop, what each screen is responsible for,
and where detailed state is disclosed.

It is not a visual design specification. It intentionally avoids prescribing
colors, final layout treatment, component styling, or aesthetic direction.

## IA Principles

- Desktop is an attach-first client for an already-running pm-go API.
- The API and persisted pm-go state are the authority. Desktop reconstructs UI
  state from API reads and never becomes a second orchestrator.
- Each screen has one primary purpose. Screens may link to supporting detail,
  but they should not try to show every subsystem at once.
- Run detail uses focused sections, tabs, or equivalent subroutes. The cockpit
  answers the current operational question first; tasks, approvals, budgets,
  evidence, and events are available on demand.
- Progressive disclosure is mandatory. Dense diagnostics, raw events, artifact
  metadata, review internals, and policy details sit behind explicit choices.
- The runs list is not a run inspector. It has no permanent right inspector and
  no event drawer.
- The event drawer is collapsed by default and exists only on run-related
  screens.
- Generated artifacts are evidence, not application UI. Render them inertly and
  keep surrounding audit or release context visible.
- Workflow Builder is not required for MVP operation. If included during MVP
  development, it is a read-only preview and not a primary route.
- Prototype screens are context, not commitments. The `front-end/` draft's
  Dashboard, global Approvals, global Artifacts, and Workflow Builder routes
  should be translated into this run-scoped IA unless a later product decision
  explicitly promotes them.

## App Shell

The app shell provides stable product structure around the current route. It
does not own orchestration state.

Shell responsibilities:

- Track connection state for the configured API base URL.
- Expose top-level navigation for Runs, New Spec, and Settings after a valid
  API attachment.
- Preserve a clear path back to the runs list from every run-related route.
- Show the current run context only after a run is selected.
- Host route content in one main work area.
- Host contextual confirmation, action error, and path-opening dialogs.
- Host an optional right inspector only where a run-related screen explicitly
  opens one.
- Host a collapsed event drawer only on run-related routes.

The shell must not:

- Start, stop, repair, or supervise the pm-go stack in the MVP.
- Persist durable run state outside pm-go.
- Show API-backed product screens before `/health` identifies the service as
  `pm-go-api`.
- Keep a global log terminal visible as a primary workflow.

## Navigation Model

### Top-Level Navigation

Top-level navigation is available only after attachment succeeds:

- Runs: resume an existing plan or create a new one.
- New Spec: create a spec-backed run against a selected local repo.
- Settings: edit Desktop-local preferences and test the API connection.

A lightweight post-attach Dashboard may be explored later, but it is not the
MVP landing route. If it exists during development, it is a summary shortcut to
Runs and selected-run sections. It must not have a permanent right inspector,
event drawer, global log tail, or unique run-operation actions.

If attachment fails or the configured service is not pm-go, the app remains on
the Attach screen. The operator can edit the base URL, retry, or use command
hints to start the stack outside Desktop.

### Run Navigation

Selecting a run opens a run detail shell for that plan. Inside the run detail
shell, navigation is organized into focused sections:

- Overview: current run state, blocker or next valid action, and release
  readiness.
- Plan / Phases: phase order, progress, integration, and audit state.
- Tasks: task list grouped or filtered by phase/status.
- Approvals: pending and decided human gates.
- Budget: budget report and policy pressure.
- Evidence: reviews, audits, artifacts, and release evidence.
- Release: completion audit outcome and release action when eligible.

The implementation may render these as tabs, segmented navigation, or nested
routes. The important IA rule is that opening Run Detail should not reveal every
subsystem at once.

### Back And Resume Behavior

- Returning from a run-related route goes back to the previous run section or
  the runs list, depending on navigation history.
- The last selected run may be stored as a Desktop preference, but visible run
  state must still be reloaded from the API after restart.
- Deep links to run sections should tolerate missing or stale IDs by showing a
  recoverable error and a path back to the runs list.

## Route Map

Routes are conceptual product routes. The implementation may use hash routing,
memory routing, or another Electron-appropriate router.

| Route | Screen | Primary purpose | Event drawer | Right inspector |
|---|---|---|---|---|
| `/attach` | Attach | Connect to an existing pm-go API | No | No |
| `/runs` | Runs List | Resume or create a run | No | No |
| `/runs/new` | New Spec | Submit repo + spec and start a plan | No | No |
| `/runs/:planId` | Run Overview | Understand current state and next action | Yes, collapsed | Optional, explicit |
| `/runs/:planId/phases` | Plan / Phases | Inspect plan structure and phase gates | Yes, collapsed | Optional, explicit |
| `/runs/:planId/tasks` | Tasks | Scan and operate task rows | Yes, collapsed | Optional, explicit |
| `/runs/:planId/tasks/:taskId` | Task Detail | Inspect and operate one task | Yes, collapsed | Optional, explicit |
| `/runs/:planId/approvals` | Approvals | Resolve human approval gates | Yes, collapsed | Optional, explicit |
| `/runs/:planId/budget` | Budget | Inspect budget state and policy pressure | Yes, collapsed | Optional, explicit |
| `/runs/:planId/evidence` | Evidence | Inspect durable review/audit/artifact evidence | Yes, collapsed | Optional, explicit |
| `/runs/:planId/evidence/:artifactId` | Artifact Detail | Inspect one artifact in context | Yes, collapsed | Optional, explicit |
| `/runs/:planId/release` | Release | Review completion audit and release evidence | Yes, collapsed | Optional, explicit |
| `/settings` | Settings | Manage Desktop-local preferences | No | No |
| `/workflow-preview` | Workflow Preview, future | Read-only visualization if enabled | No by default | No |

`/workflow-preview` is not required for MVP operation. If the route exists
during MVP development, it must be clearly separated from the run cockpit and
must not execute plans, mutate runs, or replace any required route above.

Prototype mapping:

- Draft `Dashboard` maps to a later post-attach runs summary, not MVP home.
- Draft `Approvals` maps first to `/runs/:planId/approvals`.
- Draft `Artifacts` maps first to `/runs/:planId/evidence` and artifact detail.
- Draft `Workflow builder` maps only to `/workflow-preview` when feature
  flagged and read-only.
- Draft Run Detail tabs `Findings`, `Diff`, `Events`, and `Artifacts` should
  roll into Tasks, Evidence, Artifact Detail, and the collapsed event drawer
  rather than becoming required primary MVP routes.

## Screen Responsibilities

### Attach

Purpose: connect Desktop to an already-running pm-go API.

Required content:

- API base URL input, defaulting to `http://localhost:3001` when no preference
  exists.
- Connection state: not configured, probing, connected, unreachable, foreign
  service, API error, or stream reconnecting where relevant.
- `/health` identity result when available.
- Command hints for starting or checking the stack outside Desktop.

Primary actions:

- Retry connection.
- Save or change API base URL.
- Proceed to Runs only after the service identity is accepted.

The Attach screen must not show stale run data as authoritative while the API
is unreachable.

### Runs List

Purpose: choose or resume an existing run.

Required content:

- Runs from `GET /plans`, ordered for operator resumption.
- Run title, status, updated time, repo/spec identity when available, and
  attention indicators for blockers, pending approvals, failed audits, or
  release readiness.
- Access to New Spec and Settings.

Primary actions:

- Open a selected run.
- Start New Spec.
- Refresh runs.

Disclosure rules:

- No permanent right inspector.
- No event drawer.
- No task, approval, artifact, or event detail panes. Selecting a run navigates
  into run detail.

### New Spec

Purpose: create a new spec-backed run against a local repository.

Required content:

- Repo root picker.
- Spec file picker and paste/edit field.
- Derived title with editable override.
- Submission progress for `POST /spec-documents` and `POST /plans`.
- Inline validation for missing repo, missing spec body, unreachable API, and
  API errors.

Primary actions:

- Choose repo root.
- Choose spec file.
- Paste or edit spec body.
- Submit and open the new run.
- Cancel back to Runs.

The screen should treat plan persistence delay as an expected state. After
submit, open the new run context and show planning/loading until durable plan
state is readable.

### Run Detail Shell

Purpose: provide the shared context for one selected plan.

Required content:

- Run identity, status, repo/spec identity when available, current phase,
  updated time, and release readiness.
- Focused run navigation for Overview, Plan / Phases, Tasks, Approvals, Budget,
  Evidence, and Release.
- Connection and stream state for the selected run.

Primary actions:

- Return to Runs.
- Refresh run state.
- Open or close the event drawer.
- Open focused run sections.

The run detail shell owns SSE subscription for the selected plan, maintains the
per-run event cursor, and refreshes relevant API data when workflow events
arrive. If streaming is unavailable, it exposes a reconnecting or polling state
without replacing the focused screen with raw logs.

### Run Overview

Purpose: answer what is happening, what needs attention, and what can safely
happen next.

Required content:

- Single blocker or next valid action summary.
- Phase progress summary.
- Task progress summary grouped by phase.
- Pending approval summary.
- Budget summary.
- Completion audit and release readiness summary when available.

Primary actions:

- Trigger the most relevant valid run action when one exists and the server
  accepts it.
- Navigate to the focused section that explains the current blocker.
- Open confirmation for mutating actions.

Disclosure rules:

- Do not show every task detail, review finding, policy decision, event, and
  artifact at once.
- Use links, drawers, modals, or section navigation for supporting detail.

### Plan / Phases

Purpose: inspect plan structure, phase order, and phase gates.

Required content:

- Phase list in dependency order.
- Phase status, task counts, integration state, audit state, and current
  blockers.
- Phase audit summary when available.

Primary actions:

- Integrate eligible phase.
- Audit eligible phase.
- Open phase audit evidence.
- Navigate to tasks in the selected phase.

Phase actions must be confirmed and must surface server `409` messages inline
with enough context to retry or inspect the blocker.

### Tasks

Purpose: scan and operate task rows without entering full task detail.

Required content:

- Task rows grouped by phase by default, with optional filtering by status,
  approval state, review state, or attention state.
- Task title/slug, status, phase, review state, risk marker, approval marker,
  and current action availability.

Primary actions:

- Open Task Detail.
- Run, review, fix, approve, or reasoned override review when valid.
- Open relevant review or artifact detail through explicit disclosure.

The Tasks screen should support efficient operation, but it should not become a
full log, artifact browser, and budget dashboard simultaneously.

### Task Detail

Purpose: inspect and operate one task.

Required content:

- Task identity, phase, status, file scope, acceptance criteria, risk, budget,
  branch name, worktree lease path, and latest agent run.
- Latest review outcome and findings.
- Fix cycle state when applicable.
- Related approvals, artifacts, and events.

Primary actions:

- Run task.
- Review task.
- Fix task.
- Approve task.
- Override review if the MVP includes that action.
- Open or reveal trusted worktree path through the main process.
- Open related artifact or review evidence.

If a worktree path is missing or fails validation, open/reveal actions are
disabled and the task remains inspectable.

### Approvals

Purpose: resolve human policy gates.

Required content:

- Pending and decided approvals for the selected plan.
- Scope, risk, reason, requested time, decided time, approver, and linked task
  or plan context.
- Highest-risk pending approval surfaced clearly.

Primary actions:

- Approve one task-scoped request.
- Approve one plan-scoped request.
- Bulk approve eligible pending requests.
- Inspect skipped rows returned by bulk approval.

The Approvals screen must preserve server semantics. If bulk approval skips
rows, the UI must not imply those requests were approved.

### Budget

Purpose: inspect budget state and policy pressure for the selected run.

Required content:

- Plan budget summary from the budget report.
- Task or phase budget pressure where available.
- Related policy decisions and blocked approvals when budget is the reason.

Primary actions:

- Navigate to affected tasks or approvals.
- Open policy decision detail.
- Refresh budget report.

Budget is a decision-support section. It should not duplicate every task row or
become a replacement for Approvals.

### Evidence

Purpose: inspect durable evidence without reading raw files manually.

Required content:

- Review reports, phase audits, completion audits, release evidence, and
  artifacts grouped by context.
- Artifact ID, kind/title when available, created time when available, and
  source context.
- Audit outcome, summary, findings, and related artifact IDs.

Primary actions:

- Open artifact detail.
- Reveal or open trusted local artifact paths after main-process validation.
- Navigate to the task, phase, completion audit, or release context that
  produced the evidence.

Artifact content is untrusted generated content. Render it as inert text or
markdown and do not execute embedded HTML, scripts, or remote resources.

### Artifact Detail

Purpose: inspect one artifact while preserving its source context.

Required content:

- Artifact ID, type/kind, source context, created time when available, and fetch
  status.
- Inert text or markdown content viewer.
- Surrounding task, audit, or release context.

Primary actions:

- Return to Evidence or the source context.
- Reveal/open trusted path if available and validated.
- Retry artifact fetch.

Fetch failures should show the artifact ID and API error while keeping the
surrounding evidence context visible.

### Release

Purpose: complete the run only after durable audit evidence supports it, then
inspect release evidence.

Required content:

- Completion audit status, outcome, summary, findings, and artifact IDs.
- Release readiness state.
- Release evidence after `POST /plans/:planId/release` succeeds.

Primary actions:

- Run completion audit when every phase is completed.
- Release plan only when the latest completion audit outcome is `pass`.
- Open release artifacts and evidence.

The Release screen must not claim success before durable completion or release
state exists in the API.

### Settings

Purpose: manage Desktop-local preferences.

Required content:

- API base URL.
- Connection test result.
- Recent repo roots and spec paths.
- Editor preference: VS Code, Cursor, or system default folder opener.
- Terminal preference if supported.
- Dev-only feature flags if any.

Primary actions:

- Save preferences.
- Test connection.
- Clear recent paths.

Settings must not expose durable run-state editing, direct database controls,
Temporal controls, Docker controls, worktree cleanup actions, runtime/model
provider policy, sandbox configuration, notification policy, or stack
supervision.

## Progressive Disclosure Rules

The information hierarchy for a run is:

1. Current run status, blocker or next valid action, and release readiness.
2. Focused sections for phases, tasks, approvals, budget, evidence, and release.
3. Detail views, right inspectors, modals, and the event drawer.
4. Raw event fields, artifact metadata, and advanced diagnostic hints.

Rules:

- The first layer should be enough to decide what to inspect or do next.
- Details open only after an explicit user action.
- Mutating actions open confirmation before calling the API.
- Server `409` precondition failures render inline and keep the current context.
- After any mutation, refresh the affected plan, phase, task, approval, budget,
  or evidence state from the API.
- Empty, loading, and error states should preserve the user's route whenever
  possible instead of forcing a reset to the runs list.
- CLI hints such as `pm-go status` or `pm-go doctor` are recovery guidance, not
  hidden subprocesses launched by Desktop.

## Right Inspector Behavior

The right inspector is contextual and temporary.

Allowed:

- A selected task quick look from Run Overview or Tasks.
- A selected approval from Approvals.
- A selected policy decision from Budget.
- Artifact metadata or related evidence from Evidence or Release.
- A compact review or audit detail that does not deserve a full route.

Not allowed:

- No right inspector on Attach.
- No right inspector on Runs List.
- No right inspector on New Spec.
- No right inspector on Settings.
- No permanent dashboard inspector.
- No inspector that is required to perform the primary action on a screen.

Behavior:

- Closed by default on every route.
- Opens only from explicit selection.
- Closes when leaving the selected run or moving to a route where it is not
  relevant.
- Does not subscribe to its own independent source of truth; it receives data
  from the same API-backed route state or triggers an explicit detail fetch.
- If content becomes stale after an event or mutation, it refreshes or clearly
  indicates that the user should reload detail.

## Event Drawer Behavior

The event drawer is supporting context for a selected run.

Rules:

- Exists only on `/runs/:planId` routes and their nested run sections.
- Collapsed by default on every run-related route.
- Never appears on Attach, Runs List, New Spec, Settings, or MVP Workflow
  Preview.
- Shows workflow events for the selected plan only.
- Uses a per-plan event cursor and resumes with `sinceEventId` after reconnect.
- Falls back to polling the relevant run state when SSE is unavailable.
- Makes stream reconnecting visible without hiding the current durable state.
- Treats "no events yet" as an empty state, not an error.

Required event content:

- Event type.
- Event time or sequence when available.
- Related plan, phase, task, approval, artifact, or audit context when
  available.
- Short human-readable summary.
- Link to the focused route for the related entity when possible.

The event drawer is not the primary workflow. It should help the operator
understand recent changes and debug timing, not require reading a live log to
operate the run.

## Empty, Loading, And Error States

### Global / Attachment

- No saved API URL: show Attach with default URL ready to test.
- Probing: show connection in progress and prevent product navigation.
- API unreachable: show retry, editable base URL, and stack-start command hint.
- Foreign service: show the received identity when available and ask the user
  to change port or stop the other service.
- API error: show endpoint context and retry path.

### Runs List

- Loading runs: show a runs-loading state without assuming there are no runs.
- No runs: explain that no plans were returned and offer New Spec.
- Runs fetch error: preserve Settings and Attach access; allow retry.

### New Spec

- Missing repo: keep submit disabled and explain the missing input.
- Missing spec body: keep submit disabled and explain the missing input.
- Spec document submit failure: keep the user's inputs and show the API error.
- Plan creation delay: show planning or persistence in progress and poll the
  plan state rather than declaring failure immediately.

### Run-Related Screens

- Initial run load: show route-level loading for plan, phases, tasks,
  approvals, budget, and evidence as each becomes available.
- Partial failure: keep available durable state visible and mark the failed
  section with retry.
- SSE reconnecting: keep the last read API state visible and mark the stream as
  reconnecting.
- Stale/no progress: surface a stack health hint and point to `pm-go status` or
  `pm-go doctor`.
- Missing task/phase/artifact ID: show a recoverable not-found state with a path
  back to the parent run section.

### Actions

- Invalid client-side precondition: disable the action and expose why it is not
  currently available.
- Server `409`: show the server message inline in the confirmation or action
  area and refresh relevant state.
- Non-409 API failure: show endpoint context, preserve the user's route, and
  allow retry where safe.
- Editor/path launch failure: show the target path or integration that failed
  and offer reveal/copy fallback when valid.

### Evidence

- No evidence yet: show the expected context, such as no review report, no phase
  audit, no completion audit, or no release evidence.
- Artifact fetch failure: show artifact ID, API error, and retry without losing
  the surrounding audit or release context.
- Untrusted or invalid path: disable open/reveal and show that the path failed
  validation.

## First-Time Path

1. The operator opens Desktop.
2. Desktop loads the saved API base URL or defaults to `http://localhost:3001`.
3. Desktop probes `GET /health`.
4. If the service is unreachable or not `pm-go-api`, Desktop stays on Attach
   with retry, base URL editing, and command hints such as
   `pm-go run --repo <repo>`.
5. After attachment succeeds, Desktop opens Runs.
6. If no run should be resumed, the operator opens New Spec.
7. The operator selects a repo root, selects or pastes a spec, edits the title
   if needed, and submits.
8. Desktop calls `POST /spec-documents`, then `POST /plans`.
9. Desktop opens the new Run Overview and shows planning/loading until durable
   plan state is readable.
10. The operator uses focused run sections to inspect phases, tasks, approvals,
    budget, evidence, and release readiness.
11. Mutating actions use confirmations and server-authoritative preconditions.
12. Completion and release remain unavailable until the durable API state says
    they are valid.

## MVP Decisions Carried Forward

- Desktop is attach-first and does not supervise the stack.
- The runs list has no permanent right inspector.
- The event drawer is collapsed by default and only appears on run-related
  screens.
- Run Detail is split into focused sections instead of showing every subsystem
  at once.
- Screens have one primary purpose each.
- Workflow Builder is future/read-only preview territory and is not required to
  operate the MVP.
