# Action Plan

This is the working delivery plan for `pm-go`.

Use this document as the execution guide. The milestone document stays useful as
the high-level roadmap, but this file should be the day-to-day source for what
to build next, in what order, and what "done" means for each phase.

## Current Status

- `Phase 0` is effectively complete: repository scaffold, architecture docs,
  core workflow specs, and initial shared contracts exist.
- `Phase 1` is the active next phase.
- Do not start UI-first work before the planner and worker runtime can run a
  minimal end-to-end slice.

## Delivery Rules

- Build vertical slices, not isolated libraries.
- Every phase should end with a demoable flow, not just more abstractions.
- Durable state wins over prompt memory.
- Release readiness is not claimed by agents; it is verified by the completion
  audit flow.

## Phase 0: Bootstrap

Status:

- complete

Goals:

- establish repository structure
- document core architecture and operating limits
- define shared control-plane contracts

Outputs already present:

- monorepo layout
- initial docs under `docs/specs`
- initial contract stubs under `packages/contracts`
- workflow definitions and activity boundaries

Exit criteria:

- the team can implement against stable package boundaries without re-laying the
  repo

## Phase 1a: Executable Contracts

Status:

- next

Goals:

- make the contracts package compile, validate, and serve as the authoritative
  types for the rest of the system.

Work items:

1. Add real package manifests and `tsconfig.json` files for
   `packages/contracts`, `apps/api`, `apps/worker`, and `apps/web` so the
   typecheck task runs green on an empty implementation.
2. Choose the runtime schema validator. Candidates: Zod with
   `zod-to-json-schema`, or TypeBox (native JSON Schema). Requirement: the
   chosen library must emit JSON Schema, because the executor adapter passes
   these schemas to the SDK `outputFormat` option. Decision recorded in
   ADR 0002.
3. Add validators and JSON-Schema exports for `SpecDocument`, `RepoSnapshot`,
   `Plan`, `Task`, `ReviewReport`, `CompletionAuditReport`, and `AgentRun`.
4. Add JSON fixtures for each of the above under
   `packages/contracts/src/fixtures/`.
5. Add repo-wide `build`, `typecheck`, and `test` scripts that pass on empty
   implementations.

Deliverables:

- contracts compile, validators round-trip against fixtures, JSON Schema
  artifacts are exported from `packages/contracts`.

Exit criteria:

- `pnpm typecheck && pnpm test` passes against the fixture suite.

## Phase 1b: Local Runtime Up

Status:

- pending

Goals:

- stand up the durable substrate that every later phase depends on.

Work items:

1. Choose the Postgres migration toolchain. Candidates: Drizzle, Prisma, Kysely
   with `node-pg-migrate`. Recommendation: Drizzle (schema-first fits the
   project ethos). Decision recorded in ADR 0003.
2. Create initial migrations for `spec_documents` and `repo_snapshots` only.
   Other tables land in later phases as they become needed.
3. Add a local `docker-compose.yml` for Postgres and Temporal. Temporal UI
   optional.
4. Implement one smoke-test Temporal activity that reads a `SpecDocument` from
   the API payload and writes it to the `spec_documents` table. Prove
   end-to-end contracts -> Postgres -> Temporal path works.
5. OpenTelemetry collector is deferred to Phase 7.

Deliverables:

- one-command `docker compose up`, a working smoke-test workflow, two durable
  tables.

Exit criteria:

- posting a spec document results in a row in Postgres written by a Temporal
  activity, verifiable in Temporal UI and `psql`.

## Phase 2: Planner Vertical Slice

Status:

- pending

Goals:

- go from spec input to persisted, auditable plan

Work items:

1. Implement repo snapshot collection in `packages/repo-intelligence`.
2. Implement spec intake persistence and API endpoints.
3. Implement a first planner service that produces typed `Plan` objects.
4. Implement plan markdown rendering as a secondary artifact, not the source of
   truth.
5. Implement `SpecToPlanWorkflow`.
6. Implement `PlanAuditWorkflow` checks for phase ordering, phase boundaries,
   risk gates, and phase 1 task size, dependency validity, and ownership
   conflicts only.
7. Persist plans, tasks, dependencies, risks, and artifacts.
8. Add one golden-path example spec that can be run repeatedly during
   development.

Deliverables:

- `POST /spec-documents`
- `POST /plans`
- persisted plan and plan audit result
- rendered plan artifact

Exit criteria:

- one example spec plus one local repo path reliably produces an audited plan

## Phase 3: Task Execution Slice

Status:

- pending

Goals:

- execute one bounded task in an isolated worktree with durable run metadata

Work items:

1. Implement deterministic branch naming and worktree lease creation in
   `packages/worktree-manager`.
2. Implement dirty-worktree detection and lease expiration. Add
   `WorktreeLeaseSweeperWorkflow` (hourly) that revokes expired leases.
3. Implement the executor adapter in `packages/executor-claude` per
   `docs/specs/executor-adapter.md`. The adapter is the only place that imports
   `@anthropic-ai/claude-agent-sdk`.
4. Implement the control-plane-to-SDK option mapping: `fileScope` ->
   `additionalDirectories` + `canUseTool` denial; `ReviewPolicy` ->
   `disallowedTools`; `TaskBudget.maxModelCostUsd` -> `maxBudgetUsd`;
   `WorktreeLease.worktreePath` -> `cwd`.
5. Implement `TaskExecutionWorkflow` as a Temporal workflow that invokes the
   adapter only through activities.
6. Persist `AgentRun` fields from the SDK response: `sessionId`, `usage.*`,
   `total_cost_usd`, `turns`, `stopReason`.
7. Implement the `task_review.fileScope.diff` check as a post-execution
   activity; tasks that touched files outside `fileScope.includes` transition
   to `blocked`.
8. Emit durable execution events per message and per tool call via the SDK
   `onMessage` and `hooks` callbacks.

Deliverables:

- worktree lease creation
- task branch creation
- implementer run metadata
- ready-for-review handoff state

Exit criteria:

- a task can run inside its own worktree and finish in a durable
  `readyForReview` state

## Phase 4: Review And Fix Loop

Status:

- pending

Goals:

- review completed work independently and support one bounded repair cycle

Work items:

1. Implement reviewer launch and `ReviewReport` persistence.
2. Implement `TaskReviewWorkflow`.
3. Implement `TaskFixWorkflow`.
4. Add policy checks for review strictness by risk level.
5. Stop or escalate when review-cycle limits or high-severity finding limits are
   exceeded.
6. Attach findings to task state and expose them through the API.

Deliverables:

- structured review reports
- fix-loop workflow
- task state transitions through review and fixing

Exit criteria:

- a task can be reviewed, repaired once or twice, and either pass or block with
  durable findings

## Phase 5: Phase Integration And Completion Audit

Status:

- pending

Goals:

- execute phase-scoped integration deterministically
- run a phase audit before advancing to the next phase
- close the plan with a single plan-scoped completion audit after the final
  phase

Work items:

1. Implement `PhasePartitionWorkflow` that reads the post-merge repo snapshot
   and partitions only the next phase, not the whole plan.
2. Implement `PhaseIntegrationWorkflow`: merge the foundational lane first,
   then parallel lanes in dependency order, with targeted validation after
   each merge.
3. Track merge retries and conflict handling at phase scope.
4. Implement `PhaseAuditWorkflow` that emits a durable `PhaseAuditReport` and
   gates advancement to phase N+1.
5. Enforce the phase-level retry bound (one automatic re-run before human
   escalation).
6. Build the plan-wide completion evidence bundle across all phase audits,
   all merged tasks, findings, tests, and policy decisions.
7. Implement `CompletionAuditWorkflow` that runs once after the final phase
   passes its phase audit.
8. Implement `FinalReleaseWorkflow` so release artifacts require a passing
   completion audit.
9. Generate a PR summary tied to the cumulative audited merged state across
   all phases.

Deliverables:

- per-phase integration flow
- per-phase merge run records
- per-phase audit reports
- plan-wide completion audit report
- release-readiness verdict
- PR-ready summary artifact

Exit criteria:

- a plan with two phases can execute sequentially, advance only after each
  phase audit passes, and finish with a passing plan-wide completion audit

## Phase 6: Operator UI And Control Plane

Status:

- pending

Goals:

- make the system operable without reading raw worker logs

Work items:

1. Build plan and task dashboards in `apps/web`.
2. Add task detail views for scope, branch/worktree, review findings, and test
   evidence.
3. Add approvals and retry controls.
4. Add merge queue and integration status views.
5. Add completion audit and release-readiness views.
6. Add SSE or equivalent event streaming from the API.

Deliverables:

- plan overview
- task detail screens
- findings UI
- approval controls
- release-readiness view

Exit criteria:

- an operator can monitor and control a run from UI plus API alone

## Phase 7: Policy And Reliability Hardening

Status:

- pending

Goals:

- make the system safe enough for wider internal use

Work items:

1. Implement explicit budget enforcement and reporting.
2. Implement human-approval gates by risk band.
3. Implement retry and stop-condition policies centrally in
   `packages/policy-engine`.
4. Add observability standards, traces, and durable event correlation.
5. Add sample-repo test matrix for TypeScript and Python repos.
6. Add failure-injection cases for worker restart, merge conflict, and review
   rejection.
7. Write operator runbooks for blocked tasks, stale worktrees, and failed
   completion audits.

Deliverables:

- enforced policy engine
- internal reliability checks
- runbooks and operational guidance

Exit criteria:

- the system behaves predictably under expected failure modes and policy gates

## Immediate Next Sprint

This is the recommended next slice of work. It is intentionally narrow: it ends
at a demoable checkpoint where the agent is still stubbed.

1. Make `packages/contracts` executable with the chosen schema validator and
   fixture coverage (Phase 1a exit).
2. Write ADR 0002 (schema validator) and ADR 0003 (Postgres toolchain) before
   implementation starts.
3. Stand up local Postgres plus Temporal via docker-compose. Create the
   `spec_documents` and `repo_snapshots` migrations (Phase 1b).
4. Implement repo snapshot collection as a Temporal activity.
5. Implement `POST /spec-documents` and `POST /plans` endpoints.
   `SpecToPlanWorkflow` runs a stub planner activity that returns a fixture
   `Plan` row. No Claude call yet.

Checkpoint: "post a spec plus a local repo path -> receive a persisted fixture
`Plan` + `RepoSnapshot` and render a markdown artifact from them." Wiring the
real planner agent is the first item in the sprint that follows.

## Sequencing Notes

- Do not start `CompletionAuditWorkflow` implementation before integration data
  and review reports are already durable.
- Do not invest heavily in UI before Phase 2 and Phase 3 can produce real state.
- Do not broaden executor abstraction before Claude-first execution works.
- Keep the first end-to-end path narrow: one repo, one spec, one plan, one or
  two tasks.
- Workflow code in `packages/temporal-workflows` never imports the Anthropic
  SDK or performs I/O directly. LLM calls, file I/O, Postgres, and git are all
  activities in `packages/temporal-activities`. Violating this produces
  non-deterministic workflow bugs.
- Planner, plan-auditor, reviewer, and completion-auditor runs must use the
  SDK `outputFormat: { type: 'json_schema', schema }` option. Free-form text
  responses are rejected by the adapter.
- The single runtime permission boundary is `canUseTool` in the executor
  adapter. `permissionMode` is always `'default'`.
  `allowDangerouslySkipPermissions` is never set.

## Suggested Ownership Split

If multiple engineers are working in parallel, split by seams that minimize
merge conflict:

- Engineer 1: contracts, persistence, and workflow definitions
- Engineer 2: repo intelligence, planner, and plan audit
- Engineer 3: worktree manager and executor adapter
- Engineer 4: API surface starting in Phase 1b; UI deferred until Phase 6 when
  durable state is real.

That split should only be used once Phase 1 foundations are stable enough to
avoid churn across the shared contract layer.

## Language Scope

V1 targets TypeScript repos only. Python support is deferred to V1.1 because
repo intelligence, test-runner parsing, and framework hints need language-
specific implementations that were not sized into any V1 phase. The existing
`mvp-boundaries.md` has been amended to reflect this.
