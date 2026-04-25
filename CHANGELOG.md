# Changelog

All notable changes to this project are documented here.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once the public API stabilises.

## v0.8.2.1 — 2026-04-25

Reviewer-driven follow-up to v0.8.2. A 9-finding audit caught bugs that
the v0.8.2 unit tests didn't surface, plus pre-existing protocol gaps
that v0.8.2 made invisible by silencing `WorkflowNotFoundError`. Every
P1 finding is fixed; the P2 line-count, audit-scope, and strict-mode
gaps are also addressed.

### Fixed

- **`Task.sizeHint` now hydrates on worker reads.** v0.8.2 wrote
  `plan_tasks.size_hint` correctly but the `loadTask` activity in
  `apps/worker/src/activities/task-execution.ts` and the integration
  mapper in `apps/worker/src/activities/integration.ts` both dropped
  the column. So `TaskExecutionWorkflow` saw `task.sizeHint ===
  undefined` for every persisted task and the small-task fast path
  was unreachable in production. Added the field to both mappers and
  a regression test in `task-execution-activities.test.ts`. *(P1.3)*
- **Approval signal now targets the live workflow id.** Pre-v0.8.2 the
  signal sites used `phase-integration-${phaseId}` but the integrate
  route starts the workflow as `phase-integrate-${phaseId}-${N}`. The
  ID never matched. v0.8.2 swallowed the resulting
  `WorkflowNotFoundError` as a 200 no-op, so signals stopped reaching
  workflows entirely. v0.8.2.1 adds
  `apps/api/src/lib/integration-workflow-id.ts` to reconstruct the
  current id from `merge_runs` row count, used by `/tasks/:id/approve`,
  `/plans/:id/approve`, and `/plans/:id/approve-all-pending`.
  *(P1.1)*
- **Approval gate races signal vs DB poll.** Even with the right
  workflow id, a single dropped signal or a worker restart used to
  block `PhaseIntegrationWorkflow` for the full 24h timeout. v0.8.2.1
  adds `isApproved` to the workflow's activity interface and replaces
  the single `condition()` call with a 30-second poll race: the
  signal-driven path stays fast in the happy case; the DB row remains
  the source of truth in every other case. The rejected branch also
  exits promptly instead of waiting out the timeout. *(P1.2)*
- **`onSchemaValidationFailure` is now wired at worker boot.** v0.8.2
  shipped the runner-side surface but never supplied a sink at the
  factory call site, so live schema-validation failures still
  rethrew without persisting the diagnostic artifact. v0.8.2.1 adds
  a `persistRunnerDiagnostic` activity that writes the sanitized
  JSON to `<artifactDir>/runner-diagnostics/<id>.json` and inserts
  an `artifacts` row with the new `runner_diagnostic` enum value
  (DB migration `0017`). The sink is wired into the reviewer,
  phase-auditor, and completion-auditor Claude factories at
  `apps/worker/src/index.ts`. *(P1.4)*
- **`/tasks/:id/override-review` no longer bypasses budget or scope
  gates.** Pre-v0.8.2.1 the endpoint accepted any `blocked` or
  `fixing` task. But task-execution flips `blocked` for budget
  overruns and file-scope violations too, not just review failures.
  v0.8.2.1 inspects the latest task-scoped `policy_decisions` row
  and refuses (409) when the decision is `budget_exceeded` or
  `scope_violation`. *(P1.5)*
- **`/phases/:id/override-audit` requires an actual blocked audit.**
  Pre-v0.8.2.1 a phase blocked by partition / approval timeout /
  merge failure / test failure could be marked `completed` with no
  audit override trail. v0.8.2.1 requires a `phase_audit_reports`
  row whose `outcome` is `blocked` or `changes_requested`; refuses
  (409) otherwise with a message pointing operators at the actual
  blocker. *(P1.6)*

### Changed

- **Small fast-path now also enforces a line-count limit.** The
  `<25 lines` definition in the v0.8.2 roadmap was contract-only —
  the host guard checked file count alone, so a single 200-line
  `sizeHint="small"` file slipped through. v0.8.2.1 extends
  `DiffScopeResult` with `linesChanged: number`, computed via
  `git diff --numstat baseSha`, and adds
  `SMALL_FAST_PATH_MAX_CHANGED_LINES = 50` to the workflow guard.
  Stub diff results without `linesChanged` fall back to the existing
  file-count check. *(P2.1)*
- **Plan audit enforces fileScope disjointness for every phase.**
  Pre-v0.8.2.1 the check ran only against the foundation phase,
  contradicting `planner.v1.md §4`. v0.8.2.1 generalises the check
  with finding id `plan_audit.phases.fileScope.disjoint` (phase 0
  keeps the legacy `plan_audit.phase1.fileScope.disjoint` id for
  grep continuity). *(P2.2)*
- **`scripts/lib/poll-workflow.ts --strict` actually exits 3.** The
  documented strict-mode contract was a comment-only branch.
  v0.8.2.1 wires the missing return-and-exit so unknown
  observations fail immediately. *(P2.3)*

### Internal

- DB migration `0017_runner_diagnostic_artifact_kind.sql` —
  `ALTER TYPE artifact_kind ADD VALUE 'runner_diagnostic'`.
- New helper `apps/api/src/lib/integration-workflow-id.ts`.
- New activity `persistRunnerDiagnostic` in
  `apps/worker/src/activities/plan-persistence.ts`.
- 14+ new tests across worker, api, planner, and scripts/lib.
- Full workspace typecheck + sequential test run + live phase7-smoke
  + smoke:v082-features all green at tag time.

## v0.8.2 — 2026-04-25

Dogfood remediation: removes the recurring sharp edges from the v0.8.1
end-to-end run (see `docs/reports/2026-04-24-dogfood-observations.md`)
and adds the orchestration-tax-reducing primitives the next dogfood
cycle is going to need.

### Added

- **`Task.sizeHint: "small" | "medium" | "large"`** — planner-emitted
  intent that opts a task into the new fast path. Wired through
  contracts, validators, JSON schema, fixtures, DB migration `0015`,
  persistence, and the `GET /tasks/:id` / `GET /plans/:id` round
  trip.
- **Small-task fast path in `TaskExecutionWorkflow`** — when a task
  carries `sizeHint="small"`, `riskLevel="low"`,
  `requiresHumanApproval=false`, `reviewerPolicy.required=false`, and
  ≤6 changed files, the workflow short-circuits review and stamps the
  task `ready_to_merge` directly. Persists a `policy_decisions` row
  (`subjectType="task"`, `decision="approved"`, `actor="system"`,
  `reason="review_skipped_small_task:<guards>"`) for the audit trail.
- **`POST /plans/:planId/approve-all-pending`** — bulk approval API
  that replaces the operator-side "approval sniper" script. Strict
  filters: only `status="pending"` rows; never approves
  `riskBand="catastrophic"`; for task-scoped rows, requires
  passing review OR a `review_skipped_small_task` policy decision OR
  `task.status in ("ready_to_merge","merged")`. Returns counts +
  per-row skip reasons.
- **`POST /tasks/:taskId/override-review`** — operator-accepted
  review override. Requires a non-empty `reason`; flips a `blocked`
  or `fixing` task to `ready_to_merge`; persists a human
  `policy_decisions` row.
- **`POST /phases/:phaseId/override-audit`** — operator-accepted
  audit override. Requires a non-empty `reason`; flips a `blocked`
  phase to `completed`; stamps `override_reason`, `overridden_by`,
  `overridden_at` columns on the latest `phase_audit_reports` row
  (DB migration `0016`).
- **Structured-output diagnostic sink** — reviewer / phase-auditor /
  completion-auditor runners now invoke an optional
  `onSchemaValidationFailure` sink with a sanitized
  `RunnerDiagnosticArtifact` (role, schema ref, validation summary,
  redacted payload, SDK subtype, session id) before re-throwing the
  ValidationError. Sanitizer redacts API-key / system-prompt / auth
  fields and tolerates cycles + non-serializable values.
- **`pnpm smoke:bundle-freshness`** — static cross-check of every
  `proxyActivities` `startToCloseTimeout` literal in source vs the
  compiled worker `dist/` (F1 from the dogfood report). Detects the
  stale-bundle class of bug in under 3 seconds.
- **`pnpm smoke:v082-features`** — composite smoke that runs bundle
  freshness, the API-surface unit suites covering the new endpoints,
  and the live `phase7-smoke` workflow proof.
- **Shared workflow polling helper** at `scripts/lib/poll-workflow.ts`
  — pure poll loop with one HTTP read per tick, dotted-path field
  selector, terminal-state set, transient-error tolerance, and an
  overall timeout. Replaces the inline `while; do curl …; done`
  pattern that kept reinventing the same off-by-one bugs (F9).
- **Plan-audit hardening** — `auditPlan` now also rejects
  `pnpm test --filter <pkg>` shapes (F2), workspace-package tasks
  that omit root manifest / lockfile from `fileScope.includes`
  (F4), and inconsistent `sizeHint="small"` combos
  (high risk, human-approval gate, migration acceptance criteria).

### Changed

- **Reviewer prompt severity** — `reviewer.v1.md` now reserves
  `changes_requested` for correctness / security / acceptance / test
  defects. Polish-class findings must not block at `standard`
  strictness, and reviewers must verify before raising an
  "already-implemented" finding (F5 noise reduction).
- **Planner prompt** — explicitly forbids `pnpm test --filter`,
  enumerates the workspace-safe test command shapes, and requires
  workspace-package tasks to scope `package.json` + `pnpm-lock.yaml`
  alongside the new package's own manifest.
- **`/tasks/:id/approve`, `/plans/:id/approve`,
  `/plans/:id/approve-all-pending`** — `WorkflowNotFoundError`
  during the post-flip signal is now a logged no-op (the row flip is
  the source of truth and the next workflow run picks up the
  approved row from the durable ledger). Other signal failures still
  surface as 5xx so transient gRPC blips remain retryable.
- **Phase audit evidence** now loads task-scoped policy decisions in
  addition to review-scoped ones, so the auditor sees the small-task
  fast-path approval row alongside the integration-test evidence.

### Internal

- New planner modules: `test-command-hygiene.ts`,
  `file-scope-hygiene.ts`, `size-hint-hygiene.ts`. Each ships a pure
  audit fn plus a finding-emission path wired into `auditPlan`.
- New executor-claude module: `diagnostic-artifact.ts` (sanitizer +
  sink defensiveness).
- DB migrations: `0015_task_size_hint.sql` (additive, nullable
  column), `0016_phase_audit_overrides.sql` (additive, three
  nullable columns).
- Tests: 80+ new tests across planner, contracts, worker, api,
  executor-claude, and `scripts/lib`. All test suites green; full
  workspace typecheck clean.

## v0.8.1

End-to-end recursive dogfood proof. Shipped `autoApproveLowRisk`,
the signal-driven approval gate, and benign `fileScope` expansion;
exposed the gaps that v0.8.2 addresses (see
`docs/reports/2026-04-24-dogfood-observations.md`).

## Earlier releases

See `docs/phases/` for per-phase implementation reports and the git
log for granular history.
