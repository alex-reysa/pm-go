# Build the pm-go Desktop mocked operator routes + progressive-disclosure layout

## Objective

Prove the Desktop information architecture with mocked, fixture-driven data before introducing live API complexity. After this milestone, an operator can navigate the full MVP route map (Attach, Runs List, New Spec, Run-scoped sections, Settings) and see realistic empty/loading/error states for each screen — without any real pm-go API beyond `/health`.

This spec is M2 only. M3 (live read-only API data) is a separate spec.

## Scope

- **Top-level routes** in the renderer: `Attach`, `Runs` (list), `New Spec`, `Settings`, and a selected-run shell that hosts the run-scoped sub-routes below.
- **Selected-run sub-routes**: `Run Overview`, `Plan / Phases`, `Tasks`, `Task Detail`, `Approvals`, `Budget`, `Evidence`, `Artifact Detail`, `Release`.
- **Mock fixtures**: a local fixture module under `apps/desktop/src/renderer/fixtures/` that exports realistic-shape mock data for every route. Fixture shapes track `docs/desktop/05-api-integration.md` so M3 can drop them in for live calls with minimal re-wiring. Each fixture exports a banner-labeled non-authoritative warning visible in the UI (`fixture: mocked — replace in M3`).
- **Cockpit pattern** on `Run Overview`: prototype-informed timeline / phase summary that surfaces *current state*, *next action / blocker*, and *release readiness* up top. Detail panes (per-phase task list, per-task evidence) open via drawer, modal, or right inspector — not all expanded at once.
- **Collapsed event drawer** on run-related routes only (`Run Overview`, `Plan / Phases`, `Tasks`, `Task Detail`, `Approvals`, `Budget`, `Evidence`, `Artifact Detail`, `Release`). Drawer is collapsed by default; toggle button reveals it. Drawer renders a placeholder "events stream wires up in M6" affordance — no SSE wiring yet.
- **Right inspector** is *optional* and present only on allowed run-related routes per `docs/desktop/03-information-architecture.md`. It is NOT permanent on Runs List, New Spec, Settings, or Attach.
- **Confirmation modal pattern** for any mutating action button in the mock UI — every button labels its action and disabled reason; clicking opens a modal that explains "M4 will wire this to the API" and closes without effect.
- **Loading / empty / error states** for every mock-backed screen: a route never blanks on error, always preserves the surrounding context.
- **Routing layer**: choose React Router or wouter (or equivalent already in the desktop package's stack). Whatever is chosen, document the choice in `apps/desktop/README.md` under a new "M2 decisions" section.
- **Renderer tests**: extend `apps/desktop/test/renderer/` with route-level smoke tests asserting every top-level route mounts without throwing, the event drawer is absent from Attach/Runs/NewSpec/Settings, and the run-overview cockpit renders next-action / blocker / release-readiness sections.

## Out of Scope

- Live API reads of any endpoint other than `GET /health` (which already lives in M1's main-process probe — do not change it).
- `POST /spec-documents`, `POST /plans` — no real spec submission. The `New Spec` route renders a mock form that opens the confirmation modal explaining M3/M4 deferral.
- All operator mutations (`POST /tasks/.../run`, `/review`, `/fix`, `/approve`, `/approve-all-pending`, `/phases/.../integrate`, `/audit`, `/override-audit`, `/plans/.../complete`, `/release`). M4.
- Real `GET /artifacts/:id` fetching. Artifact Detail renders fixture content.
- SSE / event stream subscription. M6.
- Pixel-perfect final visual design (typography refinements, dark mode polish, animation choreography). Functional IA only.
- Workflow graph preview. M7 (optional).
- Dashboard-first navigation patterns copied from the `front-end/` prototype — `front-end/` is reference-only for IA ideas, not the source of truth.
- Global Approvals / Artifacts list outside a selected run.
- Editable Workflow Builder (M7 territory).
- Settings categories beyond Desktop-local preferences (API base URL, opener allowlist if added). No runtime / sandbox / notification settings copied from the prototype.

## Constraints

- **No direct Postgres, Temporal, Docker, worktree mutation, or arbitrary filesystem reads from Desktop.** Only `/health` is consulted; no other API call lands in this milestone.
- **Do not invent validation commands.** Use only the commands listed under Acceptance Criteria. The known-bad shape `pnpm test --filter <pkg>` must not appear in any task — use `pnpm --filter <pkg> test`.
- **If a missing API endpoint blocks a mock surface, stop the run and file an API-improvement spec.** Do not work around it in Desktop. Since M2 is mock-only, this should not arise — but if a fixture shape can't be designed without API speculation that 05-api-integration.md doesn't cover, surface it.
- **Electron security defaults are non-negotiable** (already on HEAD from M1): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Do not loosen them. No `shell.openExternal`, no `file://` navigation, no remote module loading. Path opening (revealing repo/worktree) is M5 — do not add it here.
- **Renderer reaches the host only through the preload bridge.** Adding new bridge channels for M2 is allowed ONLY if absolutely necessary; the existing `getConfig`, `setApiBaseUrl`, `probeHealth` should be sufficient since this is mocked.
- **Mock data is rendered inertly.** No `dangerouslySetInnerHTML`, no Markdown rendering that allows raw HTML or remote resources. If artifact-detail fixtures show Markdown, render with a safe-by-default Markdown library or preformatted text.

M2 stop-and-re-plan triggers (quoted from `docs/desktop/08-dogfood-plan.md` lines 366-370):

- The main run screen requires every subsystem to be visible at once.
- The dashboard grows a permanent inspector.
- Workflow Builder becomes required to operate the MVP.

Plus the cross-milestone triggers (lines 873-892):

- Plan contains direct Desktop access to Postgres, Temporal, Docker, worktree mutation, shell execution, or arbitrary filesystem reads.
- A task needs manual DB mutation to continue.
- Implementation introduces a second source of truth for plans, tasks, approvals, audits, events, or artifacts.
- A missing API endpoint is worked around in Desktop instead of captured as an API improvement.
- Generated task graph has overlapping file scopes for unrelated Desktop subsystems.
- Validation commands invented or using the known-bad `pnpm test --filter <pkg>` shape.

Additional dogfood-plan ceilings:

- Task count: this spec is larger than M0+M1 but should stay in the **4–8 task range** across phases. Reject any plan above 10 tasks.
- 1–2 phases preferred (e.g. phase 0: router + shared layout + fixtures; phase 1: per-route surfaces). Three phases is acceptable if naturally partitioned; more is too granular.

## Acceptance Criteria

- `pnpm --filter @pm-go/desktop typecheck` passes.
- `pnpm --filter @pm-go/desktop test` passes including the new route-level smoke tests.
- `pnpm --filter @pm-go/desktop build` passes (main + preload + renderer Vite outputs).
- `pnpm typecheck` (root) passes — no regressions in other workspace packages.
- `pnpm test` (root) passes — no regressions.
- `pnpm smoke:bundle-freshness` passes.
- `pnpm smoke:v082-features` passes.
- Manual route validation: with the Desktop dev server running, every top-level route AND every selected-run sub-route renders without errors against fixtures. Confirmed by the renderer tests.
- Manual progressive-disclosure validation: Runs List has no permanent right inspector and no event drawer. Run Overview shows current state + blocker/next action + release readiness *before* any per-phase detail.
- Manual IA validation: post-attach landing route is Runs (or a route-shell placeholder that leads to Runs), NOT a prototype-style Dashboard.
- Manual error-state validation: simulated fixture errors do not blank routes — the surrounding navigation + context remains visible.
- M2 decisions recorded in `apps/desktop/README.md`: router choice, fixture-module location, drawer toggle implementation, inspector-allowed-routes list, confirmation-modal component name.

## Repo Hints

Required source docs for the planner (in addition to this spec):

- `docs/desktop/01-product-brief.md` — product purpose and non-goals.
- `docs/desktop/02-mvp-scope.md` — MVP flows, screens, actions, out-of-scope boundaries.
- `docs/desktop/03-information-architecture.md` — route ownership, progressive disclosure, event drawer rules, inspector rules.
- `docs/desktop/05-api-integration.md` — endpoint contracts (for fixture shapes).
- `docs/desktop/08-dogfood-plan.md` — milestone M2 (lines 295-370), including stop-and-replan triggers.

Existing patterns / files (M0+M1 work now on HEAD):

- `apps/desktop/src/renderer/App.tsx` — current root component, gated on `connected` attach state.
- `apps/desktop/src/renderer/AttachScreen.tsx` — the Attach screen built in M1.
- `apps/desktop/src/renderer/attachMachine.ts` — state machine for attach states.
- `apps/desktop/src/renderer/bridge.ts` — typed preload-bridge exposure.
- `apps/desktop/src/shared/*` — typed contracts (`HealthEnvelope`, `AttachState`, `Config`, URL normalizer).
- `apps/desktop/test/renderer/App.test.tsx` — existing tests; extend with route-level smokes.
- `front-end/` — reference-only IA exploration; do NOT import or copy code; consult only for IA pattern ideas.

Files the planner is expected to create or modify (under `apps/desktop/`):

- `apps/desktop/src/renderer/routes/**` (new) — one file per top-level route + selected-run sub-route.
- `apps/desktop/src/renderer/fixtures/**` (new) — typed mock data; one file per domain (runs, plan, phases, tasks, approvals, budget, events, artifacts, release).
- `apps/desktop/src/renderer/layout/**` (new) — shared layout: nav, optional drawer, optional inspector, confirmation modal wrapper.
- `apps/desktop/src/renderer/index.tsx` — wire the router; replace M1 placeholder.
- `apps/desktop/src/renderer/App.tsx` — extend to host the route tree post-attach.
- `apps/desktop/test/renderer/routes/**` (new) — route-level smoke tests.
- `apps/desktop/package.json` — add router + Markdown-safe deps if needed.
- `apps/desktop/README.md` — append "M2 decisions" section.

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

These do not block planning, but the plan must record a decision for each in `apps/desktop/README.md`:

- **Router library**: react-router-dom v6+ vs wouter vs hand-rolled hash router. Recommended: react-router-dom v6+ for ecosystem familiarity and ergonomic nested routes. The planner picks; record rationale.
- **Markdown rendering** for artifact-detail fixtures: `react-markdown` with `rehype-sanitize`, or pre-formatted text only. Default: pre-formatted text in M2; revisit in M5 when real artifacts land.
- **Drawer implementation**: native `<dialog>` element vs a controlled component vs a third-party drawer (e.g. `vaul`). Default: a small controlled component — no new third-party dep. Confirm during planning.
- **State management beyond useState**: this spec is mock-only so global state is minimal — Context + useState is fine. Avoid pulling in Redux / Zustand here. M3 will add TanStack Query for live API.
- **Styling approach**: continue with the M1 styling pattern (CSS modules, plain CSS, or whatever shipped in M1). Do not add Tailwind or a UI kit in this milestone.
