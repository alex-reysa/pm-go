# pm-go Desktop Test And Release Plan

## Purpose

This document defines the validation strategy and MVP release bar for pm-go
Desktop: an Electron client that attaches to an already-running `apps/api`
control plane. The goal is to prove that Desktop can safely drive the operator
loop without becoming a second orchestrator.

Desktop release evidence must show that state is read from the API, mutating
actions are server-authoritative, host integrations stay behind Electron
main/preload boundaries, and the app can complete the core run path from spec
intake to release evidence.

## Release Principles

- The API and Postgres-backed runtime are the source of truth.
- Desktop may mirror simple action gates, but every mutation must handle API
  rejection and refresh state.
- The renderer has no direct filesystem, shell, environment, Postgres,
  Temporal, Docker, or worktree access.
- Stub runtime validation is required before live runtime validation.
- A package is releasable only after the packaged app attaches to a real local
  API and completes a smoke path.

## Quality Gates

| Gate | Required for MVP release | Evidence |
|---|---:|---|
| Workspace non-regression | Yes | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass. |
| API/runtime smoke | Yes | Existing smoke coverage still passes, with `pnpm smoke:phase6` and `pnpm smoke:phase7` as the minimum API/TUI/runtime regression bar. |
| Desktop unit/component | Yes | Desktop package unit and component tests pass in CI. |
| Mocked API E2E | Yes | Electron E2E covers attach, cockpit, actions, failures, restart recovery, and release evidence against deterministic fixtures. |
| API contract | Yes | Desktop client contract tests pass against `apps/api` responses and expected `409`/`403`/`404` shapes. |
| Security checks | Yes | Electron config, preload bridge, path validation, artifact rendering, and dependency audit checks pass. |
| IA/prototype alignment | Yes | Implementation preserves Attach-first routing, run-scoped event drawer, run-scoped Approvals/Evidence, Desktop-local Settings, and non-primary read-only Workflow Preview behavior. |
| Accessibility smoke | Yes | Keyboard path and automated accessibility checks pass for Attach, Runs, New Spec, Cockpit, Task Detail, Approvals, Evidence, Release, and Settings. |
| Visual regression | Yes | Stable screenshots pass for the primary screens and failure states. |
| Packaging smoke | Yes | Packaged app launches, attaches to `http://localhost:3001`, runs the golden path, and opens/reveals only validated paths. |
| Live runtime dogfood | Required before external MVP handoff | One live `sdk` or `auto` run completes to release evidence, or any blocker is accepted as release-blocking. |

When the Desktop package lands, add package-level scripts for these gates, such
as `test`, `test:e2e`, `test:a11y`, `test:visual`, `test:security`, and
`pack:smoke`. Until then, the existing repo commands above remain the baseline.

## Test Layers

| Layer | What it proves | Required MVP coverage |
|---|---|---|
| Unit | Pure state, formatting, guards, and API client behavior are deterministic. | Base URL normalization; `ApiError`; action availability; event cursor updates; route guards; budget/evidence derivations; release readiness. |
| Component | Screens render the right controls and states from read models. | Attach states; Runs empty/error/loading; New Spec validation; Cockpit next action/blocker; Task Detail; Approvals skipped rows; Evidence artifact failures; Release locked/pass states. |
| Mocked API | UI behavior is correct without a live stack. | MSW or equivalent fixtures for `/health`, reads, writes, SSE, polling, artifact fetches, and `409` responses. |
| API contract | Desktop client matches the current control-plane surface. | `GET /health` production identity and legacy-shape rejection in normal mode; `POST /spec-documents`; `POST /plans`; cockpit reads; action endpoints and request bodies; bulk approve response; artifact `403`; event replay with `sinceEventId`. |
| Electron main/preload IPC | Host capabilities are narrow and validated. | `contextIsolation`; `nodeIntegration: false`; no raw `ipcRenderer`; config read/write; repo/spec pickers; `openPath`/`revealPath`; `openExternalSafe`; invalid path and scheme rejection. |
| E2E/smoke | The packaged workflow is operable. | Attach, create spec, operate tasks, approve gates, integrate, audit, complete, release, restart recovery, SSE reconnect, polling fallback. |
| Accessibility | Operator loop is usable by keyboard and screen-reader tooling. | Focus order; modal focus trap; button names; table/list semantics; disabled-action reasons; no inaccessible icon-only commands. |
| Visual regression | Dense state screens stay readable. | Golden screenshots for primary desktop viewport plus narrow window for Attach, Runs, Cockpit, Task Detail, Approvals, Evidence, Release, Settings, and key error states. |
| Security checks | Renderer cannot escape into host capabilities. | CSP; navigation/window-open blocking; external URL allowlist; inert artifact markdown; no shell interpolation; dependency audit; IPC schema validation. |
| Packaging smoke | The installed artifact works outside dev mode. | Launch packaged app; attach; load runs; create a run against stub stack; perform one validated path open/reveal; verify preferences survive restart. |

## Golden Path

The core release smoke must validate this path end to end:

| Step | Expected validation |
|---|---|
| Attach | Default `http://localhost:3001` probes `GET /health` and accepts only `service: "pm-go-api"`. |
| Create spec | Repo root and spec are selected through native pickers or paste; app calls `POST /spec-documents`, then `POST /plans`. |
| Plan readable | Cockpit opens and tolerates plan persistence delay until `GET /plans/:planId`, phases, tasks, approvals, budget, and events are readable. |
| Cockpit | Header shows run status, next action/blocker, phase/task progress, approvals, budget, completion audit, and release readiness. |
| Task action | A task can be run from a confirmed action; invalid local gates are disabled and server `409` is shown inline. |
| Review/fix | Review can be requested; a changes-requested path can trigger fix and then pass review. |
| Integrate | Eligible phase integration is confirmed, started through the API, and reflected from durable phase/merge state. |
| Audit | Phase audit runs through the API; audit outcome and artifacts appear under Evidence. |
| Complete | Completion is locked until all phases are completed; completion audit outcome is rendered from API state. |
| Release evidence | Release is locked until latest completion audit outcome is `pass`; after release, durable artifact/event state proves release evidence exists. |

## Dogfood Paths

### Stub Runtime Path

Use stub runtimes for CI and every release candidate before live dogfood.

Required validation:

- Start the local stack outside Desktop with existing CLI/dev commands and stub
  runtimes, or use the current smoke harnesses.
- Run the workspace gates and API/runtime smokes.
- Drive the Desktop golden path against deterministic data.
- Cover one review-fix-review cycle, one approval gate, one phase
  integrate/audit cycle, completion, release, and artifact viewing.
- Capture release evidence: command output, packaged app version, API health
  identity, plan id, completion audit id, release artifact ids, and screenshots
  of Cockpit and Release.

### Live Runtime Path

Use `sdk` or `auto` only after the stub path passes.

Required validation:

- Start the stack outside Desktop with live runtime configuration already
  handled by pm-go, not Desktop.
- Attach Desktop to the live API and run a small pm-go repo/spec through the
  same golden path.
- Do not mask live runtime failures as Desktop success. Runtime unavailability,
  stalled workflows, schema validation failures, or missing release evidence
  block release until triaged.
- Capture the same evidence as the stub path plus runtime mode, model/runtime
  diagnostics available from the stack, and any manual interventions.

## Manual QA Checklist

- [ ] Attach accepts a valid pm-go API identity and rejects unreachable,
      foreign, and legacy health responses.
- [ ] Attach failures show command hints only and do not launch `pm-go`,
      Docker, Temporal, Postgres, the API, or worker processes.
- [ ] Settings persists API base URL, editor preference, window state, recent
      repo roots/spec paths, and last selected run without storing durable run
      state.
- [ ] Settings does not expose runtime/model provider policy, sandbox,
      notifications, stack supervision, direct database controls, or durable
      run-state editing.
- [ ] New Spec preserves user inputs on validation/API errors.
- [ ] Runs List shows runs from `GET /plans` and has no permanent right
      inspector or event drawer.
- [ ] Cockpit shows one clear next action or blocker and keeps details behind
      explicit disclosure.
- [ ] Event drawer is collapsed by default, reconnects with `sinceEventId`, and
      polling fallback keeps state usable when SSE is down.
- [ ] Every mutating action opens confirmation, sends the API request, renders
      `409` inline, and refreshes affected state.
- [ ] Approvals show risk, scope, reason, status, and skipped bulk-approval
      rows.
- [ ] Task Detail shows file scope, acceptance criteria, budget, branch,
      worktree lease, agent run, review outcome, findings, and artifacts.
- [ ] Artifact content is fetched through the API and rendered inertly.
- [ ] Open/reveal path actions work only for validated absolute trusted
      repo/worktree paths, or artifact paths when trusted metadata exists;
      invalid or missing paths are disabled with a readable reason.
- [ ] Completion and release remain locked until durable API state permits them.
- [ ] App restart reloads local preferences and reconstructs visible run state
      from API reads.
- [ ] Packaged app performs the same attach and smoke path outside dev mode.

## Failure-Mode Tests

| Failure | Required test |
|---|---|
| API unreachable | Attach screen shows retry, editable base URL, and `pm-go run --repo <repo>` or diagnostics hints. |
| Foreign service on port | Any 2xx health response without `service: "pm-go-api"` stays blocked. |
| Legacy health response | `{ "status": "ok" }` stays blocked in normal Desktop mode and is accepted only by explicit dev override. |
| API endpoint error after attach | Product route preserves context and shows endpoint-specific retry. |
| Worker/API healthy but no progress | Cockpit shows stale/no-progress hint and points to `pm-go status` or `pm-go doctor`. |
| SSE disconnect | Current state remains visible; stream state changes to reconnecting; reconnect uses `sinceEventId`. |
| SSE unavailable repeatedly | Polling refreshes plan, phases, tasks, approvals, budget, and events. |
| Stale event cursor | Cursor can be cleared and replay restarted without losing route context. |
| Plan persistence delay | New Spec opens planning/loading and polls instead of declaring early failure. |
| Server `409` | Inline message appears near the attempted action and relevant state refreshes. |
| Bulk approval skips rows | Skipped rows and reasons are displayed; UI does not claim they were approved. |
| Artifact `403` or fetch failure | Evidence context remains visible; no renderer local-file fallback is offered. |
| Generated markdown contains HTML/script/link traps | Content renders inertly and external navigation is blocked unless allowlisted. |
| Event drawer on non-run route | Drawer is absent on Attach, Runs, New Spec, Settings, Dashboard experiments, and Workflow Preview. |
| Prototype route drift | Dashboard, global Approvals/Artifacts, editable Workflow Builder, and runtime Settings are absent from MVP routing unless explicitly feature-flagged as non-primary previews. |
| Missing worktree path | Open/reveal is disabled; task remains inspectable. |
| Invalid path from API | Main process rejects open/reveal outside expected roots. |
| Editor launch failure | UI shows failed target and offers reveal/copy fallback when safe. |
| Desktop restart | App reconnects and reloads durable state without trusting cached copies. |
| Base URL changes mid-run | In-flight requests/SSE abort and product screens reattach before showing state. |

## Release Criteria

An MVP release candidate is releasable when:

- Required quality gates pass on a clean checkout.
- Stub runtime dogfood completes the golden path through release evidence.
- Packaged app smoke passes outside dev mode.
- Live runtime dogfood completes or all live-runtime findings are explicitly
  triaged and none are Desktop release blockers.
- Security checks confirm the renderer has no raw host capability access.
- Manual QA checklist is complete for the target platform.
- Release notes include known limitations and the attach-first prerequisite.

Release evidence should include:

- Git SHA and package version/build identifier.
- OS and architecture.
- Node and pnpm versions.
- API `/health` identity envelope.
- Runtime path used: stub, sdk, or auto.
- Commands run and pass/fail output locations.
- Plan id, completion audit id, release artifact ids.
- Screenshots for Attach, Cockpit, Evidence/Release, and one failure state.

## Release-Blocking Failures

Block the MVP release for any of these:

- Desktop attaches to a foreign or legacy health response in normal mode.
- Renderer gains direct access to `fs`, `child_process`, raw IPC, environment
  variables, arbitrary external navigation, Postgres, Temporal, Docker, or git
  worktree operations.
- Desktop starts, stops, repairs, or supervises `pm-go`, Docker, Postgres,
  Temporal, the API, or worker processes in MVP normal operation.
- Any mutation claims durable success before the API confirms it.
- `409` action precondition failures crash the app, navigate away, or hide the
  server message.
- Release can be triggered without latest completion audit outcome `pass`.
- Release success is shown without durable release evidence or artifacts.
- Packaged app cannot launch, attach, persist settings, or complete the smoke
  path.
- Artifact rendering can execute script, raw HTML, remote resources, or unsafe
  links.
- Open/reveal accepts user-controlled shell strings or paths outside trusted
  roots.
- Restart recovery depends on cached Desktop copies of durable run state.

## Not Required For MVP Release

These are explicitly out of scope for the Desktop MVP release bar:

- Code signing.
- Auto-update.
- Desktop stack supervision or repair.
- Hosted collaboration or remote/team control planes.
- Executable Workflow Builder behavior.
- Bundling Docker, Postgres, Temporal, model runtimes, or the pm-go CLI.
- Direct database, Temporal, Docker, git worktree cleanup, commit, or merge
  controls from Desktop.
