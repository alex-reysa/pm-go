# Build the pm-go Desktop operator-action surfaces (M4)

## Objective

Let an operator drive every supported pm-go mutation through Desktop without
touching the TUI or curl, while keeping the API authoritative for state
transitions. After M3 the renderer reconstructs every read-only surface from
live HTTP; M4 adds the mutating side: per-row action availability, a
confirmation modal pattern, reason collection for overrides/bulk approval,
inline `409`/precondition-failure rendering, and post-success refresh.

This spec is M4 only. Task/review/evidence detail polish (M5), SSE live
updates (M6), the optional read-only Workflow Builder preview (M7), and
packaging (M8) are separate specs. Desktop must remain attach-first,
API-authoritative, and read-mostly outside the explicitly mutating actions
listed below.

## Scope

- **Action availability model.** A renderer-side `ActionAvailability` (per
  plan, phase, task, approval row) that maps current API state to:
  - the set of currently valid mutating actions
  - the disabled-reason string for each invalid action
  - whether a reason is required before submit (overrides, bulk approval)
  - whether the action requires human approval evidence already in flight

  The map must derive from API state only. Do not duplicate deep server
  policy logic; treat client-side gates as convenience and let the API
  produce the authoritative refusal when state has drifted.

- **Confirmation modal pattern.** A single shared confirmation modal
  component used by every mutating action. Modal renders the subject
  (task id/slug, phase id/title, plan id/title, approval id), the action
  label, the verbatim API endpoint and method, the disabled-reason if any,
  a reason textarea when required, and `Confirm` / `Cancel` controls. The
  modal does not optimistically advance durable state.

- **Mutating API clients** for the M4 action set, calling the routes that
  already exist in `apps/api`:
  - `POST /tasks/:taskId/run`
  - `POST /tasks/:taskId/review`
  - `POST /tasks/:taskId/fix`
  - `POST /tasks/:taskId/approve`
  - `POST /tasks/:taskId/override-review` (reason required)
  - `POST /phases/:phaseId/integrate`
  - `POST /phases/:phaseId/audit`
  - `POST /phases/:phaseId/override-audit` (reason required)
  - `POST /plans/:planId/approve`
  - `POST /plans/:planId/approve-all-pending` (reason required, skipped-row
    rendering required)
  - `POST /plans/:planId/complete`
  - `POST /plans/:planId/release`

- **Per-subject pending state.** Pending state must be scoped to the
  subject+action pair (e.g. `tasks/<id>/run`), not to a global "is anything
  in flight" flag. Two simultaneous in-flight actions on different rows
  must each render their own spinner without disabling the rest of the UI.

- **Inline `409` rendering.** `409 Conflict` responses must render the
  server's `error` body string next to the attempted control and trigger a
  refetch of the affected plan / phase / task / approval / budget surface
  on dismiss. `409` is operator-feedback, not a crash.

- **Reason collection for overrides and bulk approval.** `override-review`,
  `override-audit`, and `approve-all-pending` modals must require a
  non-empty trimmed reason before enabling submit. The reason is forwarded
  verbatim to the API.

- **Bulk approval skipped-row rendering.** `approve-all-pending` returns a
  list of approvals it skipped with reasons; Desktop must render that list
  inline after success and refresh approvals + plan state. Do not imply
  more rows were approved than the API actually approved.

- **Post-success refresh.** After every successful mutation, refetch the
  smallest set of route-scoped reads that could have changed:
  - Task actions → tasks + agent runs + review reports + events replay
    for the run
  - Phase actions → phases + tasks + events replay for the run
  - Plan actions → plan + phases + tasks + approvals + completion audit +
    artifacts (release case)
  - Approval actions → approvals + plan state when a plan gate flipped

- **Release gate.** `release` must stay disabled until the latest
  completion audit on the plan has `outcome === "pass"`. The disabled
  reason should point at the missing/blocked completion audit.

- **Tests** for each new mutation client, `ActionAvailability` mapping,
  modal reason validation, `409` body parsing, skipped-row rendering after
  bulk approve, and per-subject pending isolation. Mock `fetch`; do not
  require a real API.

- **README decisions** appended under an `M4 decisions` section in
  `apps/desktop/README.md`: action availability shape, modal pattern,
  pending-state scoping, refresh fanout per action class, and any
  recoverable-error surfaces added.

## Out of Scope

- New read-model endpoints. M4 consumes only the read models M3 already
  built; if a display needs a missing endpoint, record the gap and skip
  the action instead of adding a new client read.
- SSE subscription, reconnect, or cursor persistence. JSON event replay
  from M3 is reused as-is.
- Path opening, artifact reveal, host filesystem access, editor launch,
  or any preload-bridge expansion. M5 owns those.
- Direct Postgres, Temporal, Docker, or git access from Desktop code.
- Background auto-drive loops, retry loops, or any
  `run-to-completion`/autopilot client behavior.
- Workflow Builder, graph editing, or graph execution.
- Global Approvals or global Artifacts outside a selected run.
- Pixel-perfect final visual redesign.
- Optimistic UI that advances durable state ahead of the API response.

## Constraints

- **Desktop remains attach-first and API-authoritative.** Mutations may
  only be sent after `/health` has identified the API as
  `service: "pm-go-api"`, and server `409`/`403`/`404`/`5xx` must be
  rendered, not crashed-on.
- **No direct orchestration from Desktop.** Do not add Postgres clients,
  Temporal clients, Docker commands, worktree mutation, shell execution,
  or arbitrary filesystem access.
- **Use existing contracts where available.** Prefer `@pm-go/contracts`
  shapes and the M3 read-models. New narrow types are acceptable only
  when the API returns a shape not represented in contracts.
- **Server errors are first-class UI.** Every mutating control must have
  a place for the server's `error` message to render inline. Toast-only
  surfaces are not acceptable.
- **Artifact reads stay inert.** Release flows may show release evidence
  via `GET /artifacts/:id`; do not introduce `dangerouslySetInnerHTML`
  or remote-resource loading in M4.
- **Do not invent validation commands.** Use only the commands listed
  under Acceptance Criteria. The known-bad shape `pnpm test --filter
  <pkg>` must not appear in any task; use `pnpm --filter <pkg> test`.
- **Stop for API gaps.** If a required action cannot be implemented
  through an existing endpoint, record the gap in
  `apps/desktop/README.md` and hide the action behind a clear
  unavailable state. Do not bypass the API.

M4 stop-and-re-plan triggers from `docs/desktop/08-dogfood-plan.md`:

- An action requires a missing API endpoint.
- A Desktop action would need to call Temporal, write Postgres, or
  mutate a worktree directly.
- Repeated `409` responses show the client-side state machine is
  misleading rather than the server being authoritative.

Cross-milestone stop triggers:

- Plan contains direct Desktop access to Postgres, Temporal, Docker,
  worktree mutation, shell execution, or arbitrary filesystem reads.
- A task needs manual DB mutation to continue.
- Implementation introduces a second source of truth for plans, tasks,
  approvals, audits, events, or artifacts.
- A missing API endpoint is worked around in Desktop instead of captured
  as an API improvement.
- Generated task graph has overlapping file scopes for unrelated Desktop
  subsystems (e.g. both `tasks-actions` and `phases-actions` writing the
  same modal file without coordination).
- Validation commands are invented or use the known-bad
  `pnpm test --filter <pkg>` shape.

Task-count ceiling:

- Target **4-8 tasks** across **1-2 phases**. Reject plans above 10
  tasks unless the extra tasks are purely test/docs split-outs with
  disjoint file scopes. Per-action-class task boundaries (task actions /
  phase actions / plan actions / approvals + bulk) tend to slice
  cleanly.

## Acceptance Criteria

- `pnpm --filter @pm-go/desktop typecheck` passes.
- `pnpm --filter @pm-go/desktop test` passes, including new tests for:
  action availability mapping, the shared confirmation modal's reason
  validation, mutation client behavior on `2xx`/`4xx`/`5xx`, per-subject
  pending state isolation, `409` body rendering, and bulk-approval
  skipped-row display.
- `pnpm --filter @pm-go/desktop build` passes.
- `pnpm typecheck` passes.
- `pnpm test` passes, or any known flaky failure is rerun at the package
  level and documented with exact failing test names.
- Every mutating control routes through the shared confirmation modal,
  including override and bulk-approval surfaces.
- Override and bulk-approval submits are blocked client-side until a
  non-empty trimmed reason is provided; the reason is forwarded
  verbatim to the API.
- A successful mutation triggers a route-scoped refetch that updates
  only the surfaces that could have changed; the rest of the run
  cockpit does not flash or re-mount.
- A `409` response renders the server's `error` body inline next to the
  attempted control and the surrounding screen context is preserved.
- A `403`/`404`/`5xx` response on a mutation renders a recoverable state
  with a retry that re-issues only the failed mutation; the route stays
  mounted.
- Bulk approval shows the API's skipped-row list with reasons. The
  approved count rendered in the UI never exceeds the API's
  `approved` count.
- Two concurrent mutations on different rows do not block each other's
  controls; each row shows its own pending state.
- `release` is disabled until the plan's latest completion audit has
  `outcome === "pass"`; the disabled reason explains why.
- M4 decisions are recorded in `apps/desktop/README.md`.

Manual validation:

- Start a pm-go stack outside Desktop, drive a plan into a state where
  at least one task is `pending`, one is `in_review`, one phase is
  `executing` with `ready_to_merge` tasks, and the plan has at least one
  pending approval. Confirm every available action runs through the
  shared modal and refreshes the right surfaces.
- Stale-action smoke: trigger an action, then in another shell drive the
  underlying state via the TUI/CLI before Desktop submits. Confirm the
  `409` body renders inline and the affected surface refetches.
- Override-review smoke on a task with `ready_to_merge` reviewer
  history; confirm the reason is required and the override result is
  visible without leaving the screen.
- Bulk-approval smoke on a plan with mixed-risk pending approvals;
  confirm the skipped-row list is rendered.
- Release-gate smoke: open the run cockpit on a plan with a passing
  completion audit and confirm `release` is enabled; open it on a plan
  without one and confirm `release` is disabled with a clear reason.

## Repo Hints

Required source docs:

- `docs/desktop/02-mvp-scope.md` — MVP action set, server-authoritative
  rule, progressive-disclosure rule.
- `docs/desktop/03-information-architecture.md` — route ownership,
  drawer/inspector rules.
- `docs/desktop/04-desktop-architecture.md` — Electron boundaries,
  preload-bridge limits.
- `docs/desktop/05-api-integration.md` — endpoint contracts, error
  semantics, action gates.
- `docs/desktop/08-dogfood-plan.md` — M4 milestone definition and stop
  triggers.

Existing implementation context (from M0-M3):

- `apps/desktop/src/renderer/api/**` — M3 base URL normalization,
  `ApiError`, read clients. Extend here for mutating clients.
- `apps/desktop/src/renderer/read-models/**` — M3 view models; reuse for
  pre-action availability derivation.
- `apps/desktop/src/renderer/routes/**` — surfaces that need action
  affordances. Do not duplicate route shells; reuse the existing
  selected-run layout.
- `apps/desktop/src/renderer/layout/**` — confirmation modal pattern
  lives here.
- `apps/desktop/src/renderer/fixtures/**` — fixtures stay for tests and
  explicit disconnected states; do not regress M3 by binding mutating
  controls to fixture data.
- `apps/tui/src/lib/state-machines.ts` — existing TUI action gates;
  translate the spirit, do not copy raw.
- `apps/desktop/test/renderer/**` — extend with M4 tests.
- `apps/desktop/README.md` — append M4 decisions.

Likely files to create or modify:

- `apps/desktop/src/renderer/api/**` — new mutating clients.
- `apps/desktop/src/renderer/read-models/actionAvailability*` —
  per-subject availability mapping.
- `apps/desktop/src/renderer/layout/ConfirmationModal*` — shared modal
  component.
- `apps/desktop/src/renderer/routes/**` — wire actions into Runs List,
  Run Overview, Plan/Phases, Tasks, Task Detail, Approvals, Release.
- `apps/desktop/test/renderer/**` — new tests for each of the above.
- `apps/desktop/README.md` — append M4 decisions.
- `apps/desktop/package.json` — only if a single contained dependency
  is justified (e.g. a small form/validation helper); prefer no new
  deps.

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

- **ActionAvailability home.** A standalone module under
  `read-models/` versus per-route helper functions. Prefer one home so
  rules don't drift between routes.
- **Modal portal vs in-place.** Whether the shared confirmation modal
  is rendered via a portal at the app root or inline within the
  selected-run shell. Either is acceptable as long as the choice is
  consistent and accessible.
- **Pending-state container.** Whether per-subject pending lives in a
  small context, a query-library mutation key, or local component
  state. Prefer the smallest mechanism that survives unmount of the
  triggering control (so a follow-on confirmation can show success
  even if the row re-rendered).
- **Refresh fanout policy.** Whether the refetch list per action class
  is implemented as a static map or derived per call. Static map is
  preferred for inspectability.
- **Override evidence surfaces.** Whether the override-review and
  override-audit modals link to the most recent review/audit findings
  inline, or simply require the operator to have inspected the
  evidence drawer first. Either is acceptable; do not invent new
  endpoints to enrich the modal.
