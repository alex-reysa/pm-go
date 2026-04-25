# v0.8.2 Dogfood Remediation Dev Plan

Source report: [`docs/reports/2026-04-24-dogfood-observations.md`](../reports/2026-04-24-dogfood-observations.md)

## Goal

Make the next dogfood cycle feel like "submit spec, monitor progress, intervene only when the product has a real ambiguity." The v0.8.1 run proved the architecture, but it also exposed avoidable orchestration tax: stale workflow bundles, invalid test commands, scope misses, repeated approval friction, review over-processing, and DB surgery as an operator path.

The v0.8.2 target is not more autonomy by assertion. It is fewer known sharp edges:

- No direct `psql UPDATE` needed for normal override or approval flows.
- No recurring failure from `pnpm test --filter` or missing root package artifacts in `fileScope`.
- Small low-risk tasks can skip the formal reviewer through a host-enforced fast path.
- Reviewer/auditor structured-output failures leave enough raw evidence to debug.
- Bundle freshness is checked by a smoke before expensive live planner runs.
- The v0.8.1 `autoApproveLowRisk` and signal-driven approval gate are exercised end-to-end.

## Success Metrics

- Manual interventions on a 5-6 task internal dogfood plan: `<= 3`, down from about `15`.
- Direct DB mutations during dogfood: `0`.
- Repeated known failures from F1/F2/F4/F10: `0`.
- Small-task wall time: `5-10 min` from task start to merge-ready, down from `20-45 min`.
- Full comparable dogfood wall time: under `90 min`, down from about `2.5 h`.
- Every override, approval, review skip, and failed structured output is visible through durable rows or artifacts.

## Product Decisions

1. Use `Task.sizeHint` as planner intent, not as sole authority.
   The host must enforce the fast path with risk, approval, diff size, and command guards.

2. Use existing `reviewerPolicy.required` as the behavior switch.
   `sizeHint="small"` explains why review can be skipped; `reviewerPolicy.required=false` tells the workflow it may skip. The host should reject inconsistent combinations such as `sizeHint="small"` with `riskLevel="high"`.

3. Keep independent review for medium and large work.
   The reviewer loop caught real bugs. The improvement is to avoid spending it on 10-line scripts, prompt tweaks, and mechanical config changes.

4. Formalize operator shortcuts instead of pretending they do not exist.
   Soft overrides are a valid internal-tooling reality. They need API endpoints, required reasons, and durable audit trails.

5. Prioritize diagnosis over automatic recovery for structured-output flakes.
   First capture raw malformed payloads. Only add repair/retry logic once the failure shapes are known.

## Phase 0: Remove Repeatable Plan Failures

Objective: prevent the failures that are already understood and deterministic.

### Task 0.1: Planner command hygiene

Problem solved: F2.

Implementation:

- Update `packages/planner/prompts/planner.v1.md` to explicitly forbid `pnpm test --filter ...`.
- Require task `testCommands` to use workspace-safe commands from repo root:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm --filter <pkg> test`
  - `pnpm --filter <pkg> typecheck`
- Add a host-side command normalizer/validator before task persistence or before `validatePostMergeState`.
- Reject or rewrite the known bad shape: `pnpm test --filter <pkg>`.
- Surface a precise error: "Use `pnpm --filter <pkg> test`; do not append `--filter` after `pnpm test`."

Acceptance:

- Unit test covers `pnpm test --filter @pm-go/worker` rejection/rewrite.
- Integration validation no longer invokes package test scripts with leaked `--filter` args.
- Planner prompt test asserts the command guidance is present.

### Task 0.2: Planner fileScope hygiene for package creation

Problem solved: F4.

Implementation:

- Update `packages/planner/prompts/planner.v1.md` with a hard rule:
  - Any task creating or modifying a workspace package must include the package manifest and any root-level files it will affect.
  - For this repo, that means `package.json`, `pnpm-lock.yaml`, and the relevant `packages/*/package.json` or `apps/*/package.json`.
- Add an audit or persistence-time check that warns or rejects when a task summary indicates package creation but `fileScope.includes` omits root package artifacts.
- Keep the v0.8.1 benign expansion predicate as a fallback, not the primary behavior.

Acceptance:

- Planner tests or prompt-registry tests cover the new guidance.
- A fixture plan that adds a new workspace package passes file-scope audit without manual widening.

### Task 0.3: Workflow bundle freshness smoke

Problem solved: F1.

Implementation:

- Add `pnpm smoke:bundle-freshness`.
- The smoke should:
  - remove stale `apps/worker/dist` and `packages/temporal-workflows/dist`;
  - rebuild;
  - start or assume a worker is running;
  - submit a tiny canary workflow or inspect a scheduled event;
  - assert the activity `startToCloseTimeout` matches source expectations, especially `SpecToPlanWorkflow` planner timeout.
- Print the observed timeout and source-expected timeout in the failure message.

Acceptance:

- The smoke fails if a stale bundle still schedules `300s` after source says `1200s`.
- The smoke runs in under 30 seconds on a warm local stack.

## Phase 1: Reduce Orchestration Tax

Objective: make small low-risk tasks cheap while preserving review for work that benefits from it.

### Task 1.1: Add `Task.sizeHint`

Problems solved: F5 and F8 foundation.

Implementation:

- Add `Task.sizeHint: "small" | "medium" | "large"` to contracts, validators, JSON schemas, fixtures, DB persistence, and API reconstruction.
- Add `size_hint` to `plan_tasks` via migration.
- Planner emits:
  - `small`: expected under 25 changed lines, low risk, no schema migration, no auth/security surface, no public API contract change.
  - `medium`: default.
  - `large`: 200+ lines expected, cross-package behavior, or high uncertainty.
- Plan audit rejects:
  - `small` with `riskLevel="high"`;
  - `small` with `requiresHumanApproval=true`;
  - `small` with destructive or migration-related acceptance criteria.

Acceptance:

- `validateTask` accepts fixtures with `sizeHint`.
- API `GET /tasks/:id` and `GET /plans/:id` round-trip `sizeHint`.
- Existing fixtures are migrated to default `medium` unless intentionally small.

### Task 1.2: Implement small-task fast path

Problems solved: F5 and F8.

Implementation:

- Honor `task.reviewerPolicy.required === false` in `TaskExecutionWorkflow`.
- After implementer commit and diff-scope pass:
  - if `sizeHint="small"`;
  - and `riskLevel="low"`;
  - and `requiresHumanApproval=false`;
  - and `reviewerPolicy.required=false`;
  - and changed files/line count stay below host limits;
  - then set task status directly to `ready_to_merge`.
- Persist a `policy_decisions` row with:
  - `subjectType="task"`;
  - `decision="approved"`;
  - `actor="system"`;
  - `reason="review_skipped_small_task:<guard summary>"`.
- If any guard fails, route to normal `in_review`.
- Update TUI/API state-machine copy so skipped review is visible as a deliberate policy decision, not a missing review.

Acceptance:

- Unit test proves small low-risk no-review tasks become `ready_to_merge` after diff-scope pass.
- Unit test proves medium/high/human-approval tasks still go to review.
- Phase audit accepts a small skipped-review task only when the policy decision exists and integration tests pass.

### Task 1.3: Tune reviewer prompt severity

Problem solved: F5 false positives and polish churn.

Implementation:

- Update `packages/planner/prompts/reviewer.v1.md`:
  - `changes_requested` should be reserved for correctness, security, data, acceptance, and meaningful test gaps.
  - Low-severity polish should not block a `standard` review.
  - "Already implemented" findings are worse than no finding; the reviewer must verify before asking.
- Keep medium/high behavior strict for real defects.

Acceptance:

- Prompt tests assert the new blocking threshold language exists.
- Live dogfood tracks review outcomes by severity bucket.

## Phase 2: Replace Manual Operator Scripts With APIs

Objective: make every common intervention auditable and repeatable.

### Task 2.1: Add `POST /plans/:planId/approve-all-pending`

Problem solved: F10.

Implementation:

- Add a plan-scoped bulk approval endpoint.
- Request body:
  - `approvedBy?: string`
  - `reason: string`
- Strict filters:
  - only rows with `status="pending"`;
  - only rows for the requested plan;
  - only task approvals where latest review passed, review was intentionally skipped by policy, or the task is already merge-ready;
  - never auto-approve catastrophic or explicit human-approval rows unless a future endpoint names that separately.
- Signal the relevant `PhaseIntegrationWorkflow` after flipping rows.
- Return counts and row ids.

Acceptance:

- Unit tests cover no-op, partial approval, invalid plan id, and signal failure.
- Approval rows retain `approvedBy`, `decidedAt`, and `reason`.
- Dogfood no longer needs approval sniper scripts.

### Task 2.2: Add review and audit override endpoints

Problem solved: F7 and the "soft-override all tasks" path in the timeline.

Implementation:

- Add `POST /tasks/:taskId/override-review`.
  - Requires `reason`.
  - Allows `blocked` or `fixing` task to move to `ready_to_merge` only when caller accepts responsibility.
  - Persists a human `policy_decisions` row with `decision="approved"` and the override reason.
- Add `POST /phases/:phaseId/override-audit`.
  - Requires `reason`.
  - Allows a blocked audit to mark the phase `completed`.
  - Persists override metadata. Preferred: add nullable `override_reason`, `overridden_by`, and `overridden_at` columns to `phase_audit_reports`; fallback: policy decision linked to the phase.
- Surface overrides in `GET /tasks/:id`, `GET /phases/:id`, and the TUI.

Acceptance:

- No direct DB updates are needed to continue after a known false-positive review or operator-accepted audit block.
- Overrides are impossible without a non-empty reason.
- Phase/completion auditors can see override evidence.

### Task 2.3: Shared workflow polling helper

Problem solved: F9.

Implementation:

- Add `scripts/lib/poll-workflow` as a small TypeScript or shell helper.
- It should:
  - perform one HTTP read per tick;
  - parse the response once;
  - use explicit terminal-state enums;
  - print current state each tick;
  - enforce an overall timeout;
  - exit non-zero on unknown state or timeout.
- Replace ad hoc polling loops in dogfood scripts and smoke scripts where practical.

Acceptance:

- Unit or shell smoke covers completed, failed, timeout, and transient API failure cases.
- Long-running dogfood commands use the shared helper instead of inline polling.

## Phase 3: Improve Diagnostics And Prove v0.8.1

Objective: make intermittent failures debuggable and verify the features already shipped.

### Task 3.1: Capture raw structured-output failures

Problem solved: F6.

Implementation:

- For reviewer, phase-auditor, and completion-auditor runners, persist a sanitized diagnostic artifact when runtime schema validation fails.
- Include:
  - role;
  - schema ref;
  - validation error summary;
  - sanitized structured output when available;
  - SDK result subtype and session id.
- Do not include API keys, full prompts, or sensitive environment data.
- Link the artifact id from the failed `agent_runs` row if the schema supports it; otherwise include the artifact id in `error_reason`.

Acceptance:

- Tests simulate malformed `structured_output` and assert an artifact/sink payload is produced.
- The dogfood operator can inspect the raw payload without rerunning the reviewer blind.

### Task 3.2: End-to-end v0.8.1 feature smoke

Problems solved: F3, F4, F10 proof gap.

Implementation:

- Add or extend a smoke that exercises:
  - `autoApproveLowRisk=true`;
  - signal-driven approval gate;
  - benign fileScope expansion for root package artifacts;
  - bulk approval endpoint;
  - small-task review skip.
- Run against stub mode first, then one live low-risk dogfood task if budget allows.

Acceptance:

- Smoke exits 0 on a clean stack.
- Workflow history shows signal-driven approval, not timer-drain polling.
- No duplicate pending approval rows are created across integration retries.

## Suggested v0.8.2 Task Partition

If this plan is fed back into pm-go, keep it to six tasks:

1. `planner-command-and-filescope-hygiene`
   Files: planner prompt, planner tests, plan audit helpers.

2. `task-size-hint-contract`
   Files: contracts, JSON schema, fixtures, DB migration, persistence round trips.

3. `small-task-fast-path`
   Files: task execution workflow, review policy, phase audit evidence, tests.

4. `approval-and-override-api`
   Files: API routes, DB schema/migration if override columns are added, TUI client/state display.

5. `polling-and-bundle-smokes`
   Files: scripts, package scripts, smoke tests.

6. `structured-output-diagnostics-and-proof-smoke`
   Files: executor-claude runners, failure sink tests, v0.8.1/v0.8.2 smoke.

## Verification Plan

Local checks:

```sh
pnpm typecheck
pnpm test
pnpm smoke:bundle-freshness
pnpm smoke:phase7
pnpm smoke:phase7-process-runtime
```

Dogfood proof:

1. Submit a v0.8.2 spec that includes one small prompt-only task, one small script task, one medium API task, and one approval-gated task.
2. Run with implementer on Sonnet if cost is the priority, reviewer/auditor on Opus if quality is the priority.
3. Record:
   - total wall time;
   - model spend;
   - number of manual interventions;
   - number of direct DB edits;
   - review cycles by task size;
   - approval rows created and approved;
   - any structured-output diagnostics.
4. Pass criteria:
   - no direct DB edits;
   - no recurrent F1/F2/F4/F10 failures;
   - small tasks skip review only when policy says so;
   - all overrides and approvals are visible in API/TUI.

## Deferred To v0.8.3

- `POST /plans/:id/run-to-completion`.
  This should wait until v0.8.2 removes the recurring manual unblockers; otherwise autopilot will just burn budget on known stuck states.

- Reviewer ensemble for large tasks.
  Add only after small-task skip reduces the baseline cost.

- Automatic malformed-output repair.
  First collect real malformed payloads from F6, then decide whether to repair, re-prompt, or tighten schemas.

- Browser UI.
  The current pain is workflow/product mechanics, not lack of a richer UI.
