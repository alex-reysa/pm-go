# pm-go Desktop Dogfood Plan

## Purpose

This document defines a staged plan for using pm-go to build pm-go Desktop.
It is intended to become one or more pm-go specs, not one oversized "build the
desktop app" request.

The dogfood goal is to prove the product loop against pm-go itself while
keeping each run bounded, reviewable, and recoverable. Desktop must remain an
attach-first Electron client for the existing control-plane API. It must not
become a second orchestrator, stack supervisor, Temporal client, direct
Postgres client, or worktree manager during the MVP.

## Source Context

Use these docs as the source of truth when writing milestone specs:

- `docs/desktop/01-product-brief.md` for product purpose and non-goals.
- `docs/desktop/02-mvp-scope.md` for MVP flows, screens, actions, and
  out-of-scope boundaries.
- `docs/desktop/03-information-architecture.md` for route ownership,
  progressive disclosure, event drawer, and inspector rules.
- `docs/desktop/04-desktop-architecture.md` for Electron process boundaries,
  local stack attachment, filesystem integration, security, and packaging.
- `docs/desktop/05-api-integration.md` for endpoint contracts, API errors,
  SSE behavior, read models, and action gates.
- `docs/desktop/06-workflow-builder-domain.md` for the Workflow Builder
  maturity boundary.
- `docs/desktop/07-node-and-workflow-types.md` for optional read-only graph
  vocabulary and durable-object invariants.
- `front-end/` for prototype context only. Use it to compare IA and
  progressive-disclosure ideas, not as final MVP scope.
- `docs/roadmap/2026-04-25-dogfood-dev-plan.md` for dogfood operating lessons:
  avoid direct DB edits, avoid known bad test-command shapes, capture durable
  intervention evidence, and use small-task fast paths only when policy allows.
- `examples/spec-input-template.md` for the shape of each pm-go spec.

## Runtime Choices

Implementation runtime:

- Create the Desktop app under `apps/desktop` as a workspace package,
  provisionally named `@pm-go/desktop`.
- Use Electron with a strict main/preload/renderer split.
- Use TypeScript throughout.
- Use React for the renderer, matching the existing TUI's React investment.
- Use TanStack Query or an equivalent query layer for API-backed read models.
- Use Vite or another Electron-friendly bundler only after M0 records the
  package scripts and build outputs.
- Keep Electron `contextIsolation: true`, `nodeIntegration: false`, and no raw
  IPC exposed to the renderer from the first shell milestone.

Dogfood runtime:

- Start the pm-go stack outside Desktop. Use `pnpm pm-go run --repo .`,
  `pnpm dev`, or the current local runbook. Desktop should only attach.
- Prefer stub/process runtime for smoke and UI-state validation. Use live
  SDK/Claude runtime only for narrow implementation specs after the milestone
  is well sliced.
- Keep reviewer/auditor gates on for medium or risky work. Use small-task
  review skip only when durable policy rows prove it was allowed.
- Do not use a run-to-completion/autopilot spec for Desktop until M4 action
  gates, M6 recovery behavior, and the relevant dogfood remediation smokes are
  passing.

## Operator Expectations

The operator should expect to intervene at product boundaries, not by editing
durable state manually.

- Before each run, confirm the target spec names one milestone or one narrow
  slice, not the whole Desktop MVP.
- Before execution, inspect the generated plan for direct Postgres, Temporal,
  Docker, git worktree, or filesystem orchestration from Desktop code. Reject
  or revise plans that cross those boundaries.
- During execution, approve only explicit plan/task gates with enough context.
  Bulk approval is acceptable only through the API endpoint and with a reason.
- Override reviews or audits only through API-supported override routes and
  only with durable reasons. Direct `psql UPDATE` is a failed dogfood outcome.
- If the app is not yet capable of showing its own progress, use the CLI/TUI as
  the operator surface for the dogfood run.

Expected intervention budget:

- M0-M2: planning feedback and normal code review are expected; no live
  orchestration interventions should be needed.
- M3-M4: one or two API precondition corrections are acceptable while action
  gates settle.
- M5-M8: recurring manual unblocks, direct DB edits, or unexplained stale
  workflow state mean stop and re-plan.

## Avoid Overloading The First Run

The first pm-go Desktop dogfood run should not implement the product. It should
prepare the repo and prove the attach-first shell.

First-run limits:

- Target only M0 plus M1, or only M1 if M0 decisions are already committed.
- Cap the generated plan at 3-5 tasks.
- Allow one phase unless the planner has a clear package-setup phase followed
  by a shell phase.
- Do not include live run cockpit data beyond `GET /health`.
- Do not include operator mutations, SSE, artifact rendering, path opening,
  packaging, or Workflow Builder.
- Require validation to stop at package build/typecheck/test and manual attach
  checks.

If the first plan contains more than six tasks, adds stack supervision, adds
graph authoring, or tries to operate live pm-go runs, stop before execution and
split the spec.

## Recommended Spec Slicing

Write one pm-go spec per milestone unless two adjacent milestones are already
small because prior work exists. A practical sequence is:

1. `desktop-shell-and-attach` - M0/M1 only.
2. `desktop-mocked-operator-routes` - M2 only.
3. `desktop-readonly-api-data` - M3 only.
4. `desktop-operator-actions` - M4 only.
5. `desktop-task-review-evidence-surfaces` - M5 only.
6. `desktop-events-and-recovery` - M6 only.
7. `desktop-readonly-workflow-graph-preview` - optional M7 only.
8. `desktop-dogfood-packaging` - M8 only.

Do not combine M3-M6 into one spec. That slice would mix API read models,
mutating controls, evidence rendering, and streaming recovery, which makes
review and rollback too hard.

Each spec should use the template in `examples/spec-input-template.md` and
include:

- The milestone id and title.
- Source docs for that milestone.
- Explicit out-of-scope items.
- Files or package areas likely to change.
- Validation commands.
- Stop-and-replan triggers.

## Milestones

### M0: Docs, Readiness, And Repo Setup Decisions

Objective: make the first implementation spec boring and bounded.

Use source docs:

- `docs/desktop/01-product-brief.md`
- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/04-desktop-architecture.md`
- `docs/roadmap/2026-04-25-dogfood-dev-plan.md`
- `examples/spec-input-template.md`

Deliverables:

- Decide and document the Desktop package path, package name, dev script,
  build script, and test script.
- Decide whether the first API client copies TUI client patterns locally or
  extracts a shared client package. Prefer local copy for M1-M3 if extraction
  would broaden the first slice.
- Decide the first renderer stack and test harness.
- Record how the existing `front-end/` draft will be translated: Attach first,
  Runs as the MVP landing route after attachment, no global event drawer,
  run-scoped Approvals/Evidence first, read-only Workflow Preview only if
  deferred behind a flag, and Settings limited to Desktop-local preferences.
- Confirm existing root validation commands:
  `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm smoke:bundle-freshness`, and `pnpm smoke:v082-features`.
- Create the first implementation spec from this milestone plan, not from the
  entire desktop docs directory.

Dependencies:

- Required desktop docs are present and internally consistent.
- Current dogfood remediation smokes are known and runnable or their absence is
  recorded as a blocker.

Out of scope:

- Creating application screens beyond a package skeleton if the spec includes
  setup work.
- Live API integration.
- Electron stack supervision.
- Workflow Builder.

Exit criteria:

- The first implementation spec has no more than 3-5 tasks.
- The chosen package/scripts are clear enough for pm-go to modify workspace
  manifests without file-scope misses.
- The plan explicitly rejects Desktop direct access to Postgres, Temporal,
  Docker, and git worktree mutation.

Validation commands:

```sh
pnpm typecheck
pnpm test
pnpm smoke:bundle-freshness
pnpm smoke:v082-features
```

Risk notes:

- The biggest M0 risk is generating a plan that includes all Desktop MVP work.
- Package creation must include root workspace files in task file scopes:
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` if touched, and
  `apps/desktop/package.json`.

Stop and re-plan when:

- The plan includes more than one product milestone.
- The plan omits workspace manifest files while creating `apps/desktop`.
- The plan introduces stack supervision, direct DB access, or graph execution.

### M1: Electron Shell And Attach Screen

Objective: ship a secure desktop shell that attaches to an existing pm-go API.

Use source docs:

- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/03-information-architecture.md`
- `docs/desktop/04-desktop-architecture.md`
- `docs/desktop/05-api-integration.md`

Deliverables:

- `apps/desktop` package with Electron main, preload, and renderer entrypoints.
- Strict Electron security defaults and a narrow typed preload bridge.
- Desktop-local config for API base URL, defaulting to
  `http://localhost:3001`.
- Attach screen with states: not configured, probing, connected,
  api_unreachable, foreign_service, and api_error.
- `GET /health` probe that requires `service: "pm-go-api"` and preserves
  version/instance/port for diagnostics.
- Settings path or minimal attach-form control to change and retry the base
  URL.

Dependencies:

- M0 package/script decisions.
- A local stack can be started outside Desktop for manual attach checks.
- `/health` identity envelope is available from the API.

Out of scope:

- Starting or stopping the pm-go stack.
- Listing plans.
- Native repo/spec pickers.
- Mutating API actions.
- SSE.
- Workflow Builder.

Exit criteria:

- Desktop opens to Attach when no valid API is connected.
- A foreign service on the configured port does not unlock product screens.
- A valid pm-go API unlocks the post-attach route shell or a placeholder runs
  list.
- Renderer has no direct `fs`, `child_process`, shell, Postgres, Temporal, or
  raw IPC access.

Validation commands:

```sh
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop build
pnpm typecheck
```

Manual validation:

- Launch with no API listening on port 3001 and confirm `api_unreachable`.
- Launch with a non-pm-go service returning 2xx `/health` and confirm
  `foreign_service`.
- Launch with pm-go API and confirm identity details are displayed.

Risk notes:

- Electron preload scope can sprawl quickly. Keep M1 host capabilities limited
  to config and health probe.
- Do not solve local stack lifecycle from the Attach screen.

Stop and re-plan when:

- The renderer needs raw Node access to pass tests.
- The spec tries to call `pm-go run`, Docker, Temporal, or Postgres from
  Desktop.
- Health validation accepts legacy `{ "status": "ok" }` in normal MVP mode.

### M2: Mocked UI Routes And Progressive-Disclosure Layout

Objective: prove the desktop IA with mocked data before live API complexity.

Use source docs:

- `docs/desktop/01-product-brief.md`
- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/03-information-architecture.md`

Deliverables:

- Top-level routes for Attach, Runs, New Spec, Settings, and selected-run
  sections.
- Mocked Runs List, New Spec, Run Overview, Plan/Phases, Tasks, Task Detail,
  Approvals, Budget, Evidence, Artifact Detail, and Release surfaces.
- Prototype-informed phase/timeline cockpit pattern if it supports the next
  action/blocker summary without becoming an all-in-one dashboard.
- Collapsed event drawer only on run-related routes.
- Optional right inspector only on allowed run-related routes.
- Confirmation modal pattern for future mutating actions.
- Loading, empty, and error state patterns that preserve route context.

Dependencies:

- M1 shell can route after successful attachment or dev override.
- Mock fixtures can be local renderer fixtures; they must be clearly marked
  non-authoritative.

Out of scope:

- Live API reads except health.
- Actual repo/spec submission.
- Mutating actions.
- Real artifact fetching.
- SSE.
- Pixel-perfect final design.
- Workflow graph preview.
- Dashboard-first navigation, global Approvals/Artifacts, editable Workflow
  Builder, and runtime/sandbox/notification Settings copied from the prototype.

Exit criteria:

- Runs List has no permanent right inspector and no event drawer.
- The post-attach landing path is Runs or a route-shell placeholder that
  leads to Runs, not the prototype Dashboard.
- Run Overview answers current state, blocker/next action, and release
  readiness before showing detail.
- Details open through explicit navigation, drawer, modal, or inspector.
- The UI can demonstrate the full MVP route map with static or fixture data.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop build
```

Manual validation:

- Navigate every route at desktop and narrow window sizes.
- Confirm long task titles and artifact labels do not overlap controls.
- Confirm no screen turns into a raw log dashboard.

Risk notes:

- Mock data can hide API gaps. Keep fixture shapes close to `docs/desktop/05`.
- UI density can creep toward a permanent all-in-one dashboard. Preserve the IA
  layers.

Stop and re-plan when:

- The main run screen requires every subsystem to be visible at once.
- The dashboard grows a permanent inspector.
- Workflow Builder becomes required to operate the MVP.

### M3: API Client And Read-Only Live Data

Objective: replace mocks with live API-backed read models without changing
state.

Use source docs:

- `docs/desktop/04-desktop-architecture.md`
- `docs/desktop/05-api-integration.md`
- Existing TUI client patterns in `apps/tui/src/lib/api.ts` and
  `apps/tui/src/lib/events.ts`.

Deliverables:

- Base URL normalization shared by probes, JSON reads, artifact reads, and
  future SSE.
- `ApiError` equivalent preserving status, body, message, and request id when
  available.
- Read-only clients for:
  - `GET /plans`
  - `GET /plans/:planId`
  - `GET /phases?planId=:planId`
  - `GET /tasks?planId=:planId`
  - `GET /tasks/:taskId`
  - `GET /tasks/:taskId/review-reports`
  - `GET /agent-runs?taskId=:taskId`
  - `GET /approvals?planId=:planId`
  - `GET /plans/:planId/budget-report`
  - `GET /events?planId=:planId`
  - `GET /artifacts/:id`
- Run, phase, task, approval, budget, event, artifact, and evidence read
  models for renderer state.
- Manual refresh for run-related reads.
- New Spec submit path through `POST /spec-documents` and `POST /plans` only
  if it is kept narrow and treated as intake rather than operation.

Dependencies:

- M2 routes and empty/loading/error states.
- API and worker stack can be started outside Desktop.
- API endpoint gaps are accepted as UI limitations rather than reasons for
  direct DB reads.

Out of scope:

- Operator action mutations, except optional New Spec intake.
- SSE live subscription.
- Path opening.
- Artifact local URI dereferencing.
- Client-side duplication of deep policy rules.

Exit criteria:

- Runs List loads real plans from the configured API.
- Selecting a run reconstructs the cockpit from durable API reads.
- Task detail shows task, latest run, latest lease, latest review, policy
  decisions, and related reads when available.
- Artifact content is fetched only through `GET /artifacts/:id`.
- `409`, `403`, `404`, and `5xx` are represented as recoverable UI states.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm typecheck
pnpm test
```

Manual validation:

- Start the stack outside Desktop.
- Open a historical or active plan and compare visible state with the TUI.
- Break one endpoint or use a missing id and confirm the route stays
  recoverable.

Risk notes:

- `GET /plans` lacks some context and attention counts. Do not compensate with
  direct DB joins from Desktop.
- Budget reads compute a fresh report, so avoid aggressive refresh.

Stop and re-plan when:

- A required display cannot be implemented without a new API endpoint. Add an
  API-gap spec instead of bypassing the API.
- The API client starts embedding deep server policy logic.
- Desktop stores copied run state as authority in local config.

### M4: Operator Actions And State-Machine Gates

Objective: let the operator drive valid pm-go actions through the API with
confirmation, reasons, refresh, and clear precondition failures.

Use source docs:

- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/05-api-integration.md`
- `docs/desktop/07-node-and-workflow-types.md`
- `docs/roadmap/2026-04-25-dogfood-dev-plan.md`

Deliverables:

- Structured `ActionAvailability` for plan, phase, task, and approval rows.
- Confirmation modal for every mutating action.
- Pending state scoped to the subject/action, not optimistic durable state.
- Mutating API calls for supported actions:
  - run task
  - review task
  - fix task
  - approve task
  - approve plan
  - bulk approve pending gates
  - override review
  - integrate phase
  - audit phase
  - override phase audit
  - complete plan
  - release plan
- Inline `409` rendering near the attempted action with a refresh afterward.
- Reason collection for bulk approval and overrides.

Dependencies:

- M3 live read models.
- Current API routes exist for the action being exposed.
- The TUI/CLI remains available for dogfood fallback while Desktop action
  handling is validated.

Out of scope:

- `POST /plans/:id/run-to-completion`.
- Direct workflow signals outside the API.
- Direct DB edits.
- Background auto-drive loops.
- Stack repair.

Exit criteria:

- Every visible mutation maps to one documented API endpoint.
- Every mutation confirms before sending.
- Success refreshes affected plan, phase, task, approval, budget, or evidence
  state from the API.
- Server `409` messages are treated as normal operator feedback, not crashes.
- Bulk approval displays skipped rows and reasons without implying approval.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm test
pnpm smoke:v082-features
```

Manual validation:

- Attempt at least one stale/invalid action and verify the `409` message stays
  in context.
- Approve one pending task gate and one plan gate through Desktop if a dogfood
  plan provides them.
- Confirm release remains disabled until a passing completion audit exists.

Risk notes:

- Action buttons can imply more certainty than the client has. Labels and
  disabled reasons should be clear that the server is authoritative.
- Review/audit override actions are high-risk UX. They need reasons and durable
  evidence, or they stay hidden.

Stop and re-plan when:

- An action requires a missing API endpoint.
- A Desktop action would need to call Temporal, write Postgres, or mutate a
  worktree directly.
- Repeated `409` responses show the client-side state machine is misleading.

### M5: Task, Review, Evidence, And Artifact Detail Surfaces

Objective: make durable evidence inspectable without turning Desktop into a
terminal or filesystem browser.

Use source docs:

- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/03-information-architecture.md`
- `docs/desktop/04-desktop-architecture.md`
- `docs/desktop/05-api-integration.md`
- `docs/desktop/07-node-and-workflow-types.md`

Deliverables:

- Task Detail route with task identity, phase, status, file scope, acceptance
  criteria, risk, budget, branch, worktree lease path, latest agent run, latest
  review, policy decisions, review-skip evidence, artifacts, and related
  events.
- Review history and fix-cycle state.
- Evidence route grouping review reports, phase audits, completion audits,
  release evidence, and artifacts by context.
- Artifact Detail route that keeps source context visible.
- Inert Markdown/text/JSON artifact viewer.
- Main-process path validation for opening or revealing trusted repo and
  worktree paths. Artifact reveal is included only if trusted artifact path
  metadata exists; current artifact content fetching remains API-only.
- Editor integration through an allowlist only, such as VS Code, Cursor, or
  system default folder opener.

Dependencies:

- M3 read models.
- M4 action surfaces for task-level operations if actions are included on
  detail routes.
- Main/preload bridge is still narrow and typed.

Out of scope:

- Editing task worktrees.
- Cleaning, deleting, committing, or merging worktrees.
- Direct `file://` rendering from the renderer.
- Executable artifact HTML.
- Full binary artifact viewers.
- Revealing artifact directories from streamed artifact bytes alone.
- General-purpose diff editor unless separately scoped later.

Exit criteria:

- A task can be inspected from intent through latest evidence without reading
  raw logs first.
- Artifact content is fetched through the API and rendered inertly.
- Missing artifact or path access failures preserve the surrounding task/audit
  context.
- Open/reveal is disabled when a path is missing or fails validation.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop build
pnpm test
```

Manual validation:

- Open a task with a worktree lease and reveal/open only that trusted path.
- Fetch a review report artifact and confirm Markdown does not execute raw
  HTML or remote resources.
- Inspect a failed artifact fetch and confirm the audit/release context remains
  visible.

Risk notes:

- Artifact metadata is sparse in the current API. Prefer weak labels over
  unsafe filesystem inspection.
- Host path opening is a security boundary. Do not pass user-controlled shell
  command strings.

Stop and re-plan when:

- Renderer code needs `fs`, raw IPC, shell commands, or `file://` navigation.
- Evidence views require unsupported artifact metadata; add an API improvement
  spec instead.
- The task detail route starts duplicating every run cockpit panel.

### M6: Event Stream, Reconnect, And Recovery States

Objective: make long-running runs feel live and recoverable without depending
on Desktop for orchestration.

Use source docs:

- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/03-information-architecture.md`
- `docs/desktop/04-desktop-architecture.md`
- `docs/desktop/05-api-integration.md`

Deliverables:

- SSE subscription only after a plan is selected:
  `GET /events?planId=<planId>` with `Accept: text/event-stream`.
- Per-plan event cursor and reconnect with `sinceEventId`.
- Abort stream and in-flight requests when selected plan or base URL changes.
- Known event invalidation for `phase_status_changed`,
  `task_status_changed`, and `artifact_persisted`.
- Debug-tolerant handling for unknown future event kinds.
- Polling fallback at a conservative interval when streaming is unavailable.
- Collapsed event drawer on run-related routes only.
- Recovery states for API unreachable, stream reconnecting, stale/no progress,
  artifact fetch failure, plan persistence delay, and Desktop restart.

Dependencies:

- M3 read models and refresh functions.
- M5 event/evidence context if event drawer links to artifacts or task detail.

Out of scope:

- Raw terminal-style live log as a primary screen.
- Direct worker or Temporal diagnostics.
- Desktop auto-repair.
- New event kinds unless a separate API spec adds them.

Exit criteria:

- Closing and reopening Desktop reloads durable run state from the API.
- SSE reconnect replays missed events with `sinceEventId`.
- Polling fallback keeps selected run state usable when SSE is down.
- Event drawer never appears on Attach, Runs List, New Spec, Settings, or the
  optional Workflow Preview route.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm test
pnpm smoke:phase7
pnpm smoke:phase7-process-runtime
```

Manual validation:

- Start a run, open it in Desktop, restart Desktop, and confirm state reloads.
- Interrupt SSE or restart the API and confirm reconnect/polling behavior.
- Trigger a task or phase status change and confirm targeted refresh.

Risk notes:

- Over-refreshing budget or task detail can create avoidable load. Keep
  invalidation targeted.
- Sparse event kinds mean some panels will still refresh after mutations or
  poll; that is acceptable for MVP.

Stop and re-plan when:

- The UI hides durable state during reconnect.
- Stream errors block manual refresh or valid actions.
- The event drawer becomes the primary operator workflow.

### M7: Optional Read-Only Workflow Graph Prototype

Objective: explore a Level 1 run graph without making it part of MVP
operation.

Use source docs:

- `docs/desktop/06-workflow-builder-domain.md`
- `docs/desktop/07-node-and-workflow-types.md`
- `docs/desktop/03-information-architecture.md`

Deliverables:

- Feature-flagged or clearly optional Workflow Preview route.
- Read-only graph projection derived from durable plan, phase, task, review,
  merge, audit, approval, budget, artifact, and event records.
- Canonical node vocabulary where useful: Spec, RepoSnapshot, PlanCreation,
  PlanReviewGate, PhasePartition, TaskGroup, ImplementTask, ReviewTask,
  FixLoop, PhaseIntegration, PhaseAudit, CompletionAudit, Release,
  HumanApprovalGate, BudgetGate, Artifact.
- Edges for phase sequence, task dependency, merge order, provenance, gates,
  fix loops, evidence, and policy blocks when the durable data supports them.
- Node/detail links back to existing run sections.

Dependencies:

- M3 live run data.
- M5 evidence references.
- M6 event/recovery behavior if live graph updates are included.

Out of scope:

- Template editing.
- Custom workflow authoring.
- Graph execution.
- Dragging nodes to change order.
- Any graph state that overrides durable pm-go records.
- Replacing the Run Overview or cockpit.

Exit criteria:

- Graph route is not required for MVP operation.
- Every node that represents runtime truth carries a durable reference or a
  diagnostic explaining what is missing.
- Visual order never overrides phase order, task dependency order, merge order,
  or release gates.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop build
```

Manual validation:

- Open a plan with at least two phases and verify phase sequence and task
  dependencies match durable state.
- Open a blocked task or approval and verify the graph shows a gate rather
  than styling-only warning.

Risk notes:

- This milestone is optional. It should be cut if M1-M6 are not stable.
- The graph can easily become a product detour. Keep it read-only and
  secondary.

Stop and re-plan when:

- A graph edit changes execution semantics.
- The graph becomes necessary to run, approve, integrate, audit, complete, or
  release a plan.
- The spec introduces Level 2 templates or Level 3 custom executable workflows.

### M8: Packaging And Dogfood Release Hardening

Objective: make the MVP usable as a local dogfood release without expanding
distribution scope.

Use source docs:

- `docs/desktop/01-product-brief.md`
- `docs/desktop/02-mvp-scope.md`
- `docs/desktop/04-desktop-architecture.md`
- `docs/desktop/05-api-integration.md`
- `docs/roadmap/2026-04-25-dogfood-dev-plan.md`

Deliverables:

- Repeatable Desktop dev, build, test, and package commands.
- Local unsigned package or app bundle suitable for internal dogfood.
- Desktop dogfood runbook covering stack startup, attach, new spec, resume,
  actions, evidence inspection, restart recovery, and known limitations.
- Manual QA checklist mapped to MVP success criteria.
- Error copy for unsupported stack supervision, foreign service, stale worker,
  stream reconnecting, path validation failure, and artifact fetch failure.
- Final audit that confirms Desktop did not add direct orchestrator behavior.

Dependencies:

- M1-M6 are complete and stable.
- M7 is complete only if included; otherwise it remains explicitly deferred.
- Dogfood remediation smokes pass or open failures are documented.

Out of scope:

- Code signing.
- Auto-update.
- Hosted or multi-user control planes.
- CLI installation or upgrade.
- Bundling Docker, Postgres, Temporal, or model runtimes.
- Supervised stack startup.

Exit criteria:

- A local operator can install/open Desktop, attach to a running stack, create
  or resume a run, operate valid actions, inspect evidence, restart Desktop,
  and continue from durable state.
- Release readiness is shown only from durable completion audit and release
  evidence.
- No normal Desktop path requires direct database inspection or mutation.
- The package can be reproduced from clean checkout commands.

Validation commands:

```sh
pnpm --filter @pm-go/desktop test
pnpm --filter @pm-go/desktop typecheck
pnpm --filter @pm-go/desktop build
pnpm typecheck
pnpm test
pnpm smoke:bundle-freshness
pnpm smoke:v082-features
pnpm smoke:phase7
pnpm smoke:phase7-process-runtime
```

Manual validation:

- Attach to a clean local stack.
- Attach to a foreign service and confirm rejection.
- Create a small spec-backed run.
- Resume an existing dogfood run.
- Approve a gate through Desktop.
- Inspect task review evidence and completion/release evidence.
- Restart Desktop during an active run and confirm recovery.

Risk notes:

- Packaging can expose platform-specific Electron issues late. Keep internal
  packaging modest until the operator loop is stable.
- Packaging must not become the excuse to add stack supervision before the MVP
  proves attach-first operation.

Stop and re-plan when:

- The app is packaged before the core attach/read/action/recovery loop works.
- Release hardening discovers missing API evidence that Desktop cannot safely
  infer.
- A normal dogfood run still needs direct DB edits.

## Cross-Milestone Stop Conditions

Stop the current pm-go run and write a smaller follow-up spec when any of these
occur:

- The plan contains direct Desktop access to Postgres, Temporal, Docker,
  worktree mutation, shell execution, or arbitrary filesystem reads.
- More than three operator interventions are needed for reasons already known
  from the v0.8.2 dogfood remediation plan.
- A task needs manual DB mutation to continue.
- The implementation introduces a second source of truth for plans, tasks,
  approvals, audits, events, or artifacts.
- A missing API endpoint is being worked around in Desktop instead of captured
  as an API improvement.
- The generated task graph has overlapping file scopes for unrelated Desktop
  subsystems.
- The run tries to include M7 Workflow Builder work before M1-M6 are stable.
- Validation commands are invented or use the known-bad
  `pnpm test --filter <pkg>` shape.

## Dogfood Evidence To Capture

For each Desktop dogfood run, record:

- Spec file or spec title.
- pm-go plan id and phase/task count.
- Runtime mode used for planning, implementation, review, and audit.
- Wall time and model spend when available.
- Manual interventions and whether each used a durable API path.
- Direct DB edits, expected value: zero.
- Failed validation commands and whether they were product bugs, test bugs, or
  environment issues.
- API gaps discovered.
- Screens or flows validated manually.
- Release evidence artifact ids if the run reaches completion.

## First Spec Sketch

The first implementation spec should be no broader than:

Title:

```text
Build the pm-go Desktop Electron shell and attach screen
```

Objective:

```text
Create a secure Electron desktop package that attaches to an already-running
pm-go API and rejects unreachable or foreign services before showing product
routes.
```

Scope:

- Create `apps/desktop` workspace package and scripts.
- Add Electron main/preload/renderer entrypoints.
- Persist and edit API base URL as Desktop-local preference.
- Probe `GET /health` and require `service: "pm-go-api"`.
- Render Attach states and a post-attach placeholder.
- Add unit tests for URL normalization, health identity handling, and attach
  state transitions.

Out of scope:

- Starting the stack.
- Listing plans.
- Creating specs.
- Operator actions.
- SSE.
- Artifact rendering.
- Workflow Builder.
- Packaging beyond a development build.

Acceptance criteria:

- `pnpm --filter @pm-go/desktop typecheck` passes.
- `pnpm --filter @pm-go/desktop test` passes.
- `pnpm --filter @pm-go/desktop build` passes.
- `pnpm typecheck` passes.
- Manual attach checks pass for unreachable API, foreign service, and valid
  pm-go API.
