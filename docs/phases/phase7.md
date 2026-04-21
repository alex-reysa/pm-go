# Phase 7 — Policy, Observability, and Operator Approvals

Phase 7 layers the Phase 5 + Phase 6 stack with four pure-function
policy evaluators, an activity-scoped tracing library, two new
durable tables, four additive HTTP endpoints, a TUI approvals screen +
budget panel, and a chaos / matrix / smoke harness that proves the
whole stack end-to-end.

## What shipped

Phase 7 landed across four workers; Worker 4 (this commit) is the
integration lane.

| Worker | Scope |
|---|---|
| 1 — Policy engine | `packages/policy-engine/` pure-function evaluators (`evaluateBudgetGate`, `evaluateApprovalGate`, `evaluateRetryDecision`, `evaluateStopCondition`); contract types in `packages/contracts/src/policy.ts`; migrations 0010 (`approval_requests`), 0011 (`budget_reports`); Drizzle schema modules. |
| 2 — Observability | `packages/observability/` (`withSpan`, `startTrace`, `writeSpan`, `createSpanWriter`); `Span` / `SpanContext` / `TraceContext` contracts; migration 0012 (workflow_events `trace_id` + `span_id` columns + `span_emitted` enum value); proof-of-wire on `apps/worker/src/activities/events.ts`. |
| 3 — Sample fixtures + harnesses | `packages/sample-repos/` (4 fixtures); chaos failure-injection stubs (`packages/executor-claude/src/{implementer,reviewer}-stub-failures.ts`); `scripts/phase7-matrix.sh`, `scripts/phase7-chaos.sh`. |
| 4 — Integration (this lane) | Wire policy + observability into the runtime; ship the API + TUI surfaces; add `scripts/phase7-smoke.sh`; reconcile `packages/contracts/src/index.ts`; write runbooks + this doc. |

## The four pure evaluators (Worker 1)

Pure functions live in `packages/policy-engine/src/`:

- **`evaluateBudgetGate(task, runs) → BudgetDecision`** — sums cost +
  prompt tokens + wall-clock minutes across the task's `agent_runs`,
  compares against the task's `budget`. Returns `{ ok: false, reason:
  "budget_exceeded", over: { usd?, tokens?, wallClockMinutes? } }` on
  any cap overrun.
- **`evaluateApprovalGate(risk, task) → ApprovalDecision`** — maps a
  task's `riskLevel` (and the plan-level `Risk.humanApprovalRequired`
  flag) to an `{ required: true, band: "high" | "catastrophic" }`
  decision. The `band` is a Phase 7 label; the underlying `RiskLevel`
  enum stays at `low | medium | high` for backward compat.
- **`evaluateRetryDecision(workflowName, attempt, lastError, limits) → RetryDecision`**
  — looks up the named workflow's `RetryPolicyConfig`, applies
  exponential backoff, returns `{ retry: true, delayMs }` or
  `{ retry: false, reason }`. Non-retryable error names short-circuit.
- **`evaluateStopCondition(plan, cycles, findings, limits) → StopDecision`**
  — three priority-ordered stop reasons: `high_severity_findings`,
  `review_cycles_exceeded`, `phase_rerun_exhausted`.

Worker 4 wraps each of these in a Temporal activity
(`apps/worker/src/activities/policy.ts`) that loads the durable inputs,
invokes the pure evaluator, and writes the side-effect row when one is
needed (`approval_requests` insert on the approval gate;
`budget_reports` insert via `persistBudgetReport`). This separation
keeps the workflow sandbox deterministic — workflows only call
proxy-activities.

## Observability wiring (Worker 2 + Worker 4)

`@pm-go/observability` exports a single `withSpan(name, attrs, fn,
{ sink })` wrapper plus a DB-backed sink (`createSpanWriter({ db,
planId }).writeSpan`). Spans land as `workflow_events` rows with
`kind='span_emitted'`, `trace_id` + `span_id` populated, and the full
`Span` JSONB payload.

**Worker 2's proof-of-wire** wraps a single activity
(`emitWorkflowEvent` in `apps/worker/src/activities/events.ts`). **Worker 4
went broad** and wrapped every durable-write activity in the worker
package: `persistMergeRun`, `updatePhaseStatus`, `markTaskMerged`,
`stampPhaseAuditReportId`, `stampPhaseBaseSnapshotId`, `persistPlan`,
`persistAgentRun`, `persistArtifact`, `persistReviewReport`,
`persistPolicyDecision`, `persistPhaseAuditReport`,
`persistCompletionAuditReport`, `stampPlanCompletionAudit`,
`renderAndPersistPrSummary`, `persistCompletionEvidenceBundle`,
`leaseWorktree`, `releaseLease`, `revokeExpiredLease`,
`updateTaskStatus`, plus the four new policy activities themselves.

The pattern (per `packages/observability/README.md`):

```ts
const sink = createSpanWriter({ db, planId }).writeSpan;
return withSpan(
  "worker.activities.<module>.<fn>",
  { planId, ...correlationKeys },
  async () => doTheWork(),
  { sink },
);
```

Span-emission is best-effort: a failed insert logs and swallows; the
wrapped activity's return value and error semantics pass through
verbatim. **No workflow-level interceptor in Phase 7** — that's Phase 8
(the package depends on `@opentelemetry/api` for forward compat but
uses Node's `AsyncLocalStorage` for ambient context propagation today).

### Centralized retry policies

`packages/temporal-workflows/src/definitions.ts` exports
`PHASE7_RETRY_POLICIES` plus a `temporalRetryFromConfig` /
`retryPolicyFor` translator pair. Every workflow now consumes its
policy through this surface — ad-hoc `retry: { ... }` blocks were
deleted from each `proxyActivities` call. Tuning a workflow's retry
budget is a one-line edit to the catalog; no per-workflow file churn.

## Workflow policy gates

| Workflow | Gate | Action on trip |
|---|---|---|
| `TaskExecutionWorkflow` | `evaluateBudgetGateActivity` (pre-flight) | Transition task to `blocked`, persist `policy_decisions` row with `decision='budget_exceeded'`, return blocked-shaped result. |
| `PhaseIntegrationWorkflow` | per-task `evaluateApprovalGateActivity` (after partition check, before `integrating` flip) | Insert `approval_requests` row with `status='pending'`, poll `isApproved` every 5 s up to a 24 h cap. `approved` → continue. `rejected` → `ApprovalRejectedError`. Timeout → `ApprovalTimeoutError`. |
| `PhaseIntegrationWorkflow` | `persistBudgetReport` (post-merge, pre-`auditing`) | Snapshots plan-wide spend onto `budget_reports`. Best-effort. |
| `CompletionAuditWorkflow` | `evaluateStopConditionActivity` (before `runCompletionAuditor`) | `ApplicationFailure.nonRetryable("StopConditionMet")` → workflow fails fast; operator re-drives via `/plans/:id/complete`. |
| `CompletionAuditWorkflow` | `persistBudgetReport` (post-stamp) | Same shape as the integration snapshot. Best-effort. |

The approval poll pattern uses `condition(() => false, intervalMs)` +
`sleep(0)` so Temporal sees a real timer — the workflow stays
deterministic across replay. The `isApproved` activity is the only
side-effecting check.

## API surface

Four additive endpoints, no reshape of existing routes:

| Endpoint | Purpose |
|---|---|
| `GET /approvals?planId=<uuid>` | Lists `approval_requests` rows for the plan ordered by `requestedAt` desc. Backs the TUI approvals screen + the per-task `canApprove` gate. |
| `POST /tasks/:taskId/approve` | Idempotent flip of the latest pending row to `status='approved'`. Body: optional `{ approvedBy }`. 404 if no row exists, 409 if no row is pending. |
| `POST /plans/:planId/approve` | Plan-scoped variant of the above. |
| `GET /plans/:planId/budget-report` | Aggregates `agent_runs` joined to `plan_tasks` for the plan. Returns the `BudgetReport` contract shape. Persists each computed report onto `budget_reports` for the audit trail (best-effort). |

The `approveSubject` helper in `apps/api/src/routes/approvals.ts` is
shared by `tasks.ts` + `plans.ts` so both subject scopes flip through
the same idempotent primitive. **`apps/api` does not import
`@pm-go/policy-engine` for the budget endpoint** — the math lives
locally so the §10 invariant ("API must not import the policy engine")
stays clean. The worker activity has the parallel implementation.

## TUI surfaces

- **Budget panel** (`apps/tui/src/components/budget-panel.tsx`) — mounted
  inline on plan-detail. Renders the rolled-up totals (USD / tokens /
  wall-clock) plus the first five per-task breakdown rows. Loading +
  error states render dim and never block the parent.
- **Approvals screen** (`apps/tui/src/screens/approvals.tsx`) — lists
  pending then decided approvals; `j`/`k` navigates the pending
  section; `enter` (or `g A`) dispatches an `approve-task` /
  `approve-plan` `PendingAction` through the standard confirm-modal
  pipeline.
- **Keybind: `g A`** — capital A deliberately distinct from lowercase
  `a` (audit) so a typo doesn't fire the wrong action mid-merge. From
  plan-detail: dispatches approve when the cursor sits on a task with
  a pending approval; otherwise navigates into the approvals screen.
- **State-machine gate**: `canApprove(taskId, approvals)` mirrors the
  server's primary 409 rule.

The TUI invariants from Phase 6 hold: `apps/tui` does not import from
`apps/worker`, `packages/temporal-workflows`, or
`packages/executor-claude`. The `g A` chord dispatches a `POST` via
`apps/tui/src/lib/api.ts` exactly the way Phase 6's other operator
chords do.

## Smoke + harness

| Script | What it covers |
|---|---|
| `pnpm smoke:phase7` | The Phase 7-specific assertion bar: trace correlation (`workflow_events.trace_id` + `span_id` populated on real activity emits), approval round-trip via `POST /tasks/:id/approve`, budget gate firing (synthetic over-budget `agent_run` row → re-driven workflow → `blocked` + `policy_decisions` row), bonus checks for `/budget-report` + `/approvals`. |
| `pnpm smoke:phase7-matrix` | Worker 3's matrix harness — drives the four sample-repo fixtures through plan → review → integrate → audit → complete with stub executors. Confirms the workflow shapes survive across the matrix. |
| `pnpm smoke:phase7-chaos` | Worker 3's chaos harness — fault-injects implementer / reviewer stubs to exercise the retry + stop-condition gates. |

`pnpm smoke:phase5` and `pnpm smoke:phase6` remain the back-compat
gates and exit `0` after the Phase 7 changes.

## Operator runbooks

`docs/runbooks/` (new):

- [`blocked-tasks.md`](../runbooks/blocked-tasks.md) — diagnosing
  `task.status='blocked'`; budget vs review-cycle vs scope-violation vs
  lease-loss vs approval rejection, with diagnostic queries against
  `policy_decisions` + `agent_runs` + `merge_runs`.
- [`stale-worktrees.md`](../runbooks/stale-worktrees.md) — identifying
  worktree leases past `maxWorktreeLifetimeHours`; safe vs dirty
  release; bulk cleanup patterns.
- [`failed-completion-audit.md`](../runbooks/failed-completion-audit.md)
  — interpreting `completion_audit_reports` with negative verdicts;
  retry vs escalate decision tree; replaying the audit verbatim.

## Deferred / post-MVP

Per the hyper-prompt's §1 out-of-scope list and the constraints
section:

- **Workflow-level OTel interceptor.** Phase 7's spans are
  activity-scoped only. Phase 8 may lift `withSpan` into a Temporal
  workflow-context interceptor + emit to an external exporter
  (Jaeger / Honeycomb / OTLP).
- **External OTel exporter.** No Jaeger / OTLP / etc. The
  `workflow_events` row IS the sink; the TUI event tail shows spans
  alongside the rest of the operator timeline.
- **Python sample-repo support.** Worker 3 shipped four TypeScript /
  general fixtures. A Python repo fixture is deferred to Phase 8
  alongside multi-language file-scope detection.
- **Pre-flight budget cap inside the SDK.** The Claude Agent SDK's
  `maxBudgetUsd` already triggers the activity to exit before our
  pre-flight gate can short-circuit cleanly when a single run blows
  the budget. Phase 7 accepts post-hoc enforcement: the gate trips on
  the NEXT workflow re-entry. Documented here so a future Phase 8 can
  push the cap down into the SDK call site once Anthropic's API
  surfaces a "soft cap with reason" hook.
- **Operator-driven approval rejection** from the TUI. The `g A` chord
  only flips to `approved` in V1; rejections are SQL-only
  (`UPDATE approval_requests SET status='rejected'`).
- **Re-issuing a rejected approval** — the workflow surfaces a
  non-retryable `ApprovalRejectedError`. Re-driving requires a fresh
  `pending` row inserted manually (the `evaluateApprovalGateActivity`
  insert is idempotent on `pending` rows but doesn't reopen `rejected`).

## Pointers

- Hyper-prompt: `docs/roadmap/phase7-hyper-prompt.md` (in main; the
  worktree's local copy was elided in the W3 merge).
- Policy engine: [`packages/policy-engine/src/`](../../packages/policy-engine/src)
- Observability: [`packages/observability/src/`](../../packages/observability/src) +
  [`packages/observability/README.md`](../../packages/observability/README.md)
- Phase 6 read-model: [`docs/phases/phase6.md`](./phase6.md)
- Phase 7 harness doc: [`docs/phases/phase7-harness.md`](./phase7-harness.md)
- Smoke script: [`scripts/phase7-smoke.sh`](../../scripts/phase7-smoke.sh)
- Runbooks: [`docs/runbooks/`](../runbooks)
