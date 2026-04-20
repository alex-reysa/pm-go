# Phase 6 Hyper-Prompt — Operator UI And Visibility Layer

## 1. Phase identity

- **Phase:** `6 — Operator UI And Control Plane`
- **Phase type:** visibility + control layer over the verified Phase 5 execution backend
- **Exact goal:** an operator can drive a complete plan — spec submission → phase integration → audit → completion → release — from a browser UI plus read-only API, without reading worker logs or touching `psql`. Phase 5's backend is the source of truth; Phase 6 adds **list endpoints, a durable event stream, artifact HTTP serving, and a Next.js app** that renders the state machine live.
- **In-scope outcomes:**
  - **API** gets `GET /plans`, `GET /phases?planId=…`, `GET /tasks?phaseId=…`, `GET /agent-runs?taskId=…`, `GET /events` (SSE), and `GET /artifacts/:id` (streams the file-URI contents with the right content-type).
  - **Events table** (`workflow_events`) writing a minimal durable audit trail of every phase + task state transition, auditor verdict, and main-advance. Workflow activities emit events; the API streams them via SSE.
  - **Next.js 15 + React 18 app** (`apps/web`) scaffolded with three real routes: `/` (plan list), `/plans/:id` (phase + task dashboard with live event tail), `/plans/:id/release` (completion audit + PR summary viewer with artifact download links).
  - **Operator controls** — buttons for every `POST` the API already exposes (plan audit, phase integrate, phase audit, plan complete, plan release, task run, task review, task fix). No new workflows; Phase 6 is pure wiring.
  - **`scripts/phase6-smoke.sh`** — drives Phase 5's flow through the **web** API (listing + SSE + artifact serving, not just the orchestration routes). Fails non-retroactively if events or artifacts aren't reachable over HTTP.
- **Explicitly out of scope:**
  - Auth / multi-user / role-based access. V1 is single-operator, localhost-only.
  - Human-approval policy gates as first-class UI (Phase 7 territory).
  - Editing plans in the UI (planner is not re-invoked from the web).
  - Real-time graph visualization of the merge DAG.
  - Mobile responsive design.
  - E2E browser tests (Playwright). Phase 6 ships unit + integration, not browser-driven.

## 2. Preconditions

- `main` at `51192a0` or later. Phase 5 smoke exits 0 on clean stack.
- API routes from Phase 5 are stable: `/plans`, `/phases`, `/tasks`, `/merge-runs`, `/phase-audit-reports`, `/completion-audit-reports`.
- `apps/web` exists but is a stub (`package.json` only). No Next.js yet. That's fine — Phase 6 bootstraps it.

## 3. Operating model

Four lanes — two parallel after foundation, then reconciliation:

| Lane | Purpose | Runs after |
|---|---|---|
| **1. Events + list APIs** (foundation) | Durable `workflow_events` table, activity emit points, SSE endpoint, list/filter routes, artifact streaming | — |
| **2. Web scaffold** (parallel A, after 1) | Next.js 15 app skeleton, routing, shared data-access layer over the API | Lane 1 |
| **3. Web views + controls** (parallel B, after 1) | Plan dashboard, phase card, task card, release view, action buttons | Lane 1 |
| **4. Smoke + verification** (reconciliation) | `scripts/phase6-smoke.sh`, README walkthrough, CI-friendly list-endpoint + SSE tests | Lanes 2 + 3 |

Lane 1 must land first because Lanes 2 + 3 consume its API surface. Lanes 2 and 3 can overlap (different file paths) but share the data layer from Lane 2, so Lane 2 lands first.

## 4. Worker plan

### Worker 1 — Events + list/stream APIs (foundation)

- **Branch:** `codex/pm-go-phase6-foundation`
- **Scope:** new table `workflow_events` (migration 0008), event-emission helpers, SSE endpoint, list/filter routes on plans/phases/tasks/agent-runs, artifact streaming.
- **Deliverables:**
  1. **Migration 0008** — `workflow_events` table:
     ```
     id UUID PK
     plan_id UUID NOT NULL FK→plans(cascade)
     phase_id UUID NULL FK→phases(cascade)
     task_id UUID NULL FK→plan_tasks(cascade)
     kind TEXT NOT NULL   -- enum: 'plan_status_changed' | 'phase_status_changed' | 'task_status_changed' | 'agent_run_started' | 'agent_run_completed' | 'review_report_persisted' | 'policy_decision_persisted' | 'merge_run_completed' | 'phase_audit_persisted' | 'completion_audit_persisted' | 'main_advanced' | 'artifact_persisted'
     payload JSONB NOT NULL DEFAULT '{}'   -- kind-specific ({from, to} for status, {reportId, outcome} for audits, {newSha, expectedSha} for main_advance, {artifactId, kind, uri} for artifacts, etc.)
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     ```
     With a pgEnum `workflow_event_kind`. Two indexes: `(plan_id, created_at)` and `(created_at)` (for the firehose tail).
  2. **`@pm-go/db` schema** — Drizzle table file + re-export.
  3. **`persistWorkflowEvent(event)` activity** — thin wrapper in `apps/worker/src/activities/events.ts`, `ON CONFLICT (id) DO NOTHING` insert.
  4. **Workflow emit points** — every `updatePhaseStatus`, `updateTaskStatus`, `persistAgentRun`, `persistReviewReport`, `persistPolicyDecision`, `persistMergeRun` (completed), `persistPhaseAuditReport`, `persistCompletionAuditReport`, `fastForwardMainViaUpdateRef`, `persistArtifact` followed by a `persistWorkflowEvent` call inside the same workflow. Event id generated via `uuid4()` so retries are idempotent.
  5. **List routes:**
     - `GET /plans` → array of `{id, title, summary, status, createdAt, updatedAt, phaseCount, taskCount, latestCompletionAudit?}`. Optional `?status=executing,completed` filter.
     - `GET /phases?planId=<uuid>` → array of `{id, planId, index, title, status, integrationBranch, startedAt, completedAt}`. Ordered by `index`.
     - `GET /tasks?phaseId=<uuid>&planId=<uuid>` → array of task summaries. Either filter is optional but at least one is required (400 otherwise — avoid full-table scans).
     - `GET /agent-runs?taskId=<uuid>` → chronological list of agent runs for a task.
  6. **SSE route** — `GET /events?planId=<uuid>&sinceEventId=<uuid>?`. Server-Sent Events stream. Initial replay of historical events newer than `sinceEventId` (or last 100 if unspecified), then live tail via a polling SELECT at 1s interval (pg LISTEN/NOTIFY is a future optimization). Each event is JSON-encoded in the `data: …\n\n` payload. Heartbeat comment `:ping` every 15s to keep intermediaries from timing out.
  7. **Artifact streaming** — `GET /artifacts/:id`. Loads the `artifacts` row, resolves `uri` (file://...). If the URI's path is outside `PLAN_ARTIFACT_DIR`, return 403 (path-traversal guard). Stream the file with `Content-Type` inferred from `kind` (`pr_summary`→`text/markdown`, `completion_evidence_bundle`→`application/json`, etc.). `Content-Disposition: inline`.
- **Constraints:**
  - Every workflow that emits events keeps its existing contract (no new required params; events are best-effort, wrapped in `.catch(() => undefined)`).
  - SSE endpoint stays under the Hono stack; don't introduce a separate websocket server.
  - Artifact streaming MUST NOT follow symlinks (use `fs.stat` + realpath check).
- **Tests:**
  - Drizzle fixture round-trip for `workflow_events`.
  - Activity test for `persistWorkflowEvent` idempotency.
  - API unit tests for each list endpoint (happy + filter validation).
  - SSE endpoint test with a mock db producing 2 events, assert event framing + heartbeat interval.
  - Artifact path-traversal test (URI outside `PLAN_ARTIFACT_DIR` → 403).
- **Invariant check:** `rg '@anthropic-ai/claude-agent-sdk' apps/api/src/` returns 0 matches.

### Worker 2 — Next.js 15 scaffold + shared data layer

- **Branch:** `codex/pm-go-phase6-web-scaffold`
- **Scope:** Next.js 15 (app router) + React 18 + Tailwind in `apps/web`. Shared TanStack Query hooks wrapping the API, typed against the contracts package. No page bodies yet — Lane 3 fills those.
- **Deliverables:**
  1. `apps/web/package.json` — deps: `next@^15`, `react@^18`, `react-dom@^18`, `@tanstack/react-query@^5`, `@tanstack/react-query-devtools@^5`, `tailwindcss@^3`, `@pm-go/contracts` workspace dep. Scripts: `dev`, `build`, `typecheck`, `test`, `lint`.
  2. `next.config.mjs` — `output: 'standalone'`, `transpilePackages: ['@pm-go/contracts']`, proxy `/api/*` → `http://localhost:3001/*` for dev.
  3. `tsconfig.json` — extends root base, `moduleResolution: 'bundler'`.
  4. `app/layout.tsx`, `app/providers.tsx` — `QueryClientProvider` + dev tools, Tailwind base.
  5. `lib/api.ts` — typed fetch wrappers for every Phase 5 + Worker-1 endpoint. Pure functions returning `Plan | Phase | Task | MergeRun | PhaseAuditReport | CompletionAuditReport | WorkflowEvent` (imported from `@pm-go/contracts` where possible, inline types for list-response shapes that don't belong in contracts).
  6. `lib/hooks.ts` — TanStack Query hooks: `usePlans()`, `usePlan(id)`, `usePhase(id)`, `useTask(id)`, `useTasksForPhase(phaseId)`, `useMergeRun(id)`, `usePhaseAuditReport(id)`, `useCompletionAuditReport(id)`, `useLatestPlanEvents(planId)` (backed by SSE — falls back to polling every 3s if `EventSource` unavailable).
  7. `lib/events.ts` — thin SSE reader that yields `WorkflowEvent` objects and auto-reconnects.
  8. `app/page.tsx` — placeholder "/" route that imports `usePlans()` and displays a raw JSON dump. Proves the data-layer wiring end-to-end; Lane 3 replaces the body.
  9. `apps/web/test/` — vitest config, one smoke test asserting `QueryClient` boots and `api.fetchPlans()` dispatches the right URL when given a mock `fetch`.
- **Constraints:**
  - **Single source for contract types** — `@pm-go/contracts` is the canonical import; no duplicated `interface Plan { … }` in web code.
  - No `getServerSideProps`-era patterns; use the app router throughout.
  - Tailwind classes only — no CSS modules, no styled-components.
- **Tests:** one smoke for the hook wiring; Worker 3 adds view-level tests.
- **Invariant check:** `pnpm --filter @pm-go/web typecheck && pnpm --filter @pm-go/web build` both green.

### Worker 3 — Web views + operator controls

- **Branch:** `codex/pm-go-phase6-web-views`
- **Scope:** three real pages + action components. Read-only state rendering is the majority of the work; control buttons are thin wrappers over `POST` endpoints.
- **Deliverables:**
  1. **`/` — Plan list** (`app/page.tsx`):
     - Calls `usePlans()`. Renders a table: title, status, phase count, task count, latest completion-audit outcome (badge), updated-at. Clicking a row navigates to `/plans/:id`.
     - "New plan" button (V1 stub — opens a modal, prompts for `specDocumentId` + `repoSnapshotId`, POSTs `/plans`, redirects to the new plan's page).
  2. **`/plans/[planId]` — Plan dashboard** (`app/plans/[planId]/page.tsx`):
     - Top: plan header (title, summary, status badge, release-readiness badge driven by `latestCompletionAudit?.outcome === 'pass'`).
     - Middle: phase strip — one card per phase, left-to-right in `index` order. Each card shows: phase title, status badge, integration branch, merge-run summary (merged task count / failed task), phase-audit outcome, action buttons (integrate / audit / view report).
     - Right column: task list, grouped by phase. Each row: slug, title, status badge, risk level, "latest review outcome" badge. Row click expands into a detail drawer with full task + findings + agent-run history.
     - Footer: live event tail (last 20), auto-scrolling. Sourced from `useLatestPlanEvents(planId)`. Each event is a one-liner: timestamp + kind + payload summary.
  3. **`/plans/[planId]/release` — Release view** (`app/plans/[planId]/release/page.tsx`):
     - Shows `completionAuditReport` details: outcome, checklist breakdown, acceptance criteria passed/missing, unresolved policy decisions, findings grouped by severity.
     - Artifact links: PR summary (`GET /artifacts/:id` serves it as markdown; web renders via `react-markdown`), evidence bundle (served as JSON, shown with a syntax-highlighted code viewer).
     - "Start release" button if `completion_audit_report_id` set + outcome='pass' + no prior release artifact for this plan. Disabled otherwise with a tooltip explaining why.
  4. **Action components** (`components/actions/`):
     - `<RunTaskButton taskId />` — posts `/tasks/:id/run`, shows toast + workflow-run-id, invalidates the task query.
     - `<ReviewTaskButton taskId />` — posts `/tasks/:id/review`.
     - `<FixTaskButton taskId />` — posts `/tasks/:id/fix`.
     - `<IntegratePhaseButton phaseId />`, `<AuditPhaseButton phaseId />`.
     - `<CompletePlanButton planId />`, `<ReleasePlanButton planId />`.
     - Every button checks the relevant precondition client-side first (phase.status, task.status, completionAuditReportId) and greys out with a tooltip when not allowed. Server still enforces 409 as the source of truth.
  5. **Components** (`components/`):
     - `<PhaseCard phase />`, `<TaskRow task />`, `<EventRow event />`, `<FindingCard finding />`, `<StatusBadge status kind />`.
     - `<Drawer />` for task detail (radix primitives or plain tailwind-slideover).
     - `<ReportChecklist checklist />` for phase + completion audits.
- **Constraints:**
  - **No direct `fetch` in components** — every data read goes through a `use*` hook; every write goes through a `<*Button>` component that owns its mutation + toast + invalidation.
  - All badges/tooltips/buttons pull their allowed-transitions from a single `lib/stateMachines.ts` (plan, phase, task) so UI + server stay in lockstep.
  - Accessibility: every status badge has an `aria-label`; buttons have visible `:focus` rings.
- **Tests:**
  - Per-component renderer tests (vitest + happy-dom): each card renders every status variant, each action button fires the right fetch with the right body, preconditions disable correctly.
  - One integration test: mock the API list endpoints, mount `/plans/:id`, assert the phase strip + task list populate; advance mock events on the SSE stream and assert the event tail updates.

### Worker 4 — Smoke + verification tail

- **Branch:** continues on `codex/pm-go-phase6-web-views`
- **Scope:** real smoke that drives Phase 5's flow **through the web-adjacent API** (list + SSE + artifact serving), not just the orchestration routes.
- **Deliverables:**
  1. `scripts/phase6-smoke.sh` — extends `scripts/phase5-smoke.sh`. Runs to `plan.status=completed + release artifacts landed`, then asserts:
     - `GET /plans` returns ≥ 1 row and includes our plan with `status='completed'` and `latestCompletionAudit.outcome='pass'`.
     - `GET /phases?planId=$PLAN_ID` returns exactly 2 rows in `index` order.
     - `GET /tasks?phaseId=$PHASE_0_ID` returns 2 rows; for `$PHASE_1_ID` returns 1.
     - `GET /events?planId=$PLAN_ID&sinceEventId=00000000-0000-0000-0000-000000000000` returns at least 10 events covering `phase_status_changed` and `merge_run_completed` kinds.
     - `GET /artifacts/$PR_SUMMARY_ID` returns 200, `Content-Type: text/markdown`, body contains both phase titles (same assertion as Phase 5 but via HTTP).
     - `GET /artifacts/$EVIDENCE_BUNDLE_ID` returns 200, valid JSON with 2 phase audit ids + 2 merge run ids.
  2. **`scripts/phase6-web-smoke.sh`** (optional, behind env flag `PHASE6_WEB_SMOKE=1`) — starts `pnpm --filter @pm-go/web dev`, runs a tiny curl-script that `curl http://localhost:3000/` gets 200. No browser automation — this just proves the dev server boots.
  3. **README walkthrough** — `docs/phases/phase6.md`: how to start the stack, navigate to the UI, what each page shows, known limitations.
- **Tests covered via smoke:** end-to-end flow with UI endpoints exercised.

## 5. Mandatory invariants

- **`apps/api` MUST NOT import `@anthropic-ai/claude-agent-sdk`.** SSE + list endpoints stay on the existing Hono stack.
- **`apps/web` MUST NOT import any package under `apps/worker/` or `packages/temporal-workflows/`.** The UI reads only the HTTP surface + contracts types. (`rg -l "from ['\"]@pm-go/(temporal-workflows|worktree-manager|executor-claude|repo-intelligence)['\"]" apps/web` returns 0.)
- **`apps/web` imports `@pm-go/contracts` as its single source for domain types.** No duplicate `interface Plan` declarations.
- **Path-traversal guard on `/artifacts/:id`** — any URI resolving outside `PLAN_ARTIFACT_DIR` (after realpath) returns 403.
- **SSE endpoint heartbeats** `:ping\n\n` at ≤ 15s intervals so load balancers and proxies don't drop idle streams.
- **Precondition parity** — every action button's disabled state must match the server's 409 rules (plan/phase/task state-machine transitions). The `lib/stateMachines.ts` module is the contract.
- **Workflow emits events best-effort** — `persistWorkflowEvent` failures must not break the workflow they report on (`.catch(() => undefined)`).
- **No breaking changes to Phase 5 endpoints.** New list + SSE + artifact routes are additive; existing routes keep their shape.

## 6. Success criteria

- `pnpm typecheck && pnpm test` green across all 12 packages (adds `apps/web`).
- `pnpm smoke:phase5` still exits 0 on a clean stack (regression check).
- `pnpm smoke:phase6` exits 0 — drives the same flow, plus list/SSE/artifact assertions.
- `pnpm --filter @pm-go/web build` produces a deployable Next.js bundle.
- Manual check: operator navigates through `/ → /plans/:id → /plans/:id/release`, clicks every action button, watches the event tail update live.

## 7. Stop conditions

- Drizzle migration 0008 fails to apply against a DB that has Phase 5 data (should be purely additive — no schema changes to existing tables).
- SSE endpoint can't keep a connection alive across a 60s idle period in manual testing.
- Artifact path-traversal guard accepts a URI resolving outside `PLAN_ARTIFACT_DIR` (penetration-style test must pass).
- Web app's bundle size exceeds 1 MB gzipped for a single page — that signals bloat worth investigating before Phase 7.
- Action button's disabled state disagrees with the server's 409 response for any state-machine transition (parity violation).

## 8. Follow-ups punted from Phase 6

- **Auth** — basic-auth middleware or JWT (Phase 7).
- **Human-approval gating** — structured approval requests, UI surface, policy-engine integration (Phase 7).
- **CI-friendly smoke** — `pnpm smoke:phase5:ci` that doesn't need Docker (stubs Temporal + Postgres). Currently flagged as "next leverage point" after UI lands.
- **Playwright E2E** — adds a real browser harness. Worth it once the UI shape stabilizes.
- **Repartitioning planner** — replaces `PhasePartitionWorkflow`'s deterministic re-validator with a Claude-backed re-partitioner (Phase 8+).
- **Policy engine rewrite** — current inline `evaluateReviewPolicy` stays; a policy DSL / config file is Phase 7.

## 9. First concrete commit shape

The very first PR for Phase 6 (Worker 1 part 1) should land:

- Migration 0008: `workflow_events` table + pgEnum.
- Drizzle schema file + re-export.
- `apps/worker/src/activities/events.ts` with `persistWorkflowEvent`.
- One workflow emit point wired up (`updatePhaseStatus` → emits `phase_status_changed`) to prove the pattern.
- `GET /events?planId=<uuid>` SSE endpoint returning initial replay only (live tail deferred to commit 2).
- Unit tests for the activity + the SSE endpoint's replay phase.

That's the minimum end-to-end proof the events plumbing works. Everything else in Lane 1 follows the same shape.
