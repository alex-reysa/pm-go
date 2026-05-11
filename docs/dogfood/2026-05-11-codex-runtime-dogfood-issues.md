# 2026-05-11 Codex Runtime Dogfood Issues

This note records reliability issues found while switching the Desktop MVP
dogfood run from Claude Code quota to Codex CLI auth.

Run context:

- Branch: `dogfood/desktop-mvp`
- Runtime path used successfully: `pm-go run --repo . --runtime codex` plus
  `pm-go drive --plan <plan-id> --approve all`
- Plan under active dogfood: M3 Desktop read-only API data,
  `73bd9a65-4304-4d13-9807-68c4f27a047c`
- Status when this note was last updated: M3 Phase 0 completed with passing
  phase audit; Phase 1 is paused at a clean handoff point with
  `live-runs-cockpit` and `live-task-artifact-detail` both `ready_to_merge`,
  and `renderer-live-data-tests` still `pending`.

## Summary

Codex-backed execution is viable, but it is not yet hands-off reliable. pm-go
can spawn Codex implementers, reviewers, fixers, phase integration, and phase
auditors. The session still required operator recovery for runtime adapter
gaps, plan/schema drift, branch/base recovery, audit retry behavior, and
planner file scopes that did not match the repo.

The most important distinction:

- pm-go is doing real orchestration work through Temporal and the Codex runtime.
- A human/operator is still acting as the recovery layer when pm-go hits
  missing recovery affordances or stale generated assumptions.

## Claude Code Handoff Point

Paused at 2026-05-11 23:52 CEST so the next driver can switch back to Claude
Code.

Current state:

- Stack: `supervisor`, `worker`, and `api` are alive; `/health` returns `ok`.
- Active Codex/drive processes: none.
- Plan `73bd9a65-4304-4d13-9807-68c4f27a047c`:
  - `desktop-api-client`: `merged`
  - `desktop-read-models`: `merged`
  - `m3-decisions-docs`: `merged`
  - `live-runs-cockpit`: `ready_to_merge`
  - `live-task-artifact-detail`: `ready_to_merge`
  - `renderer-live-data-tests`: `pending`
- Latest operator task-branch fixes for `live-task-artifact-detail`:
  - `863a512 fix(live-task-artifact-detail): type task detail live metadata`
  - `5413f97 fix(live-task-artifact-detail): gate live route request state`
- Validation for `live-task-artifact-detail` after the operator patch:
  - `pnpm --filter @pm-go/desktop typecheck`
  - `pnpm --filter @pm-go/desktop test` (`25` files, `175` tests)
  - `pnpm --filter @pm-go/desktop build`

Recommended Claude resume command:

```sh
pm-go drive --plan 73bd9a65-4304-4d13-9807-68c4f27a047c --approve all
```

## Issues Found

### 1. `pm-go agent` is still effectively Claude-rooted

Symptom: launching M3 with `pm-go agent --runtime codex` still failed through
Claude Code quota/extra-usage messaging.

Impact: Codex auth cannot yet fully "take over" through the same high-level
operator command. The working path was to run the stack with Codex and drive an
existing/submitted plan via the lower-level drive loop.

Recovery used: switched to `pm-go run --repo . --runtime codex` and
`pm-go drive --plan ... --approve all`.

Recommended fix: split the root agent/orchestrator runtime from Claude-native
session assumptions. `pm-go agent --runtime codex` should either use the same
process-runtime path as implementer/reviewer roles or fail fast with a clear
message that Codex is supported only through `run` plus `drive`.

### 2. Planner accepted untrusted milestone provenance

Symptom: the Codex planner produced a plan with `milestoneId: "M3"` but no
trusted `decompositionId`, causing the DB check constraint
`plans_decomposition_milestone_pair_check` to reject plan persistence.

Impact: Codex planning could complete but fail during persistence.

Recovery used: patched planner runner to strip model-supplied
`decompositionId`/`milestoneId` unless a trusted milestone context exists.

Recommended fix: keep provenance fields server-owned. Add a regression test for
every runtime path that can create plans.

### 3. Codex planner emitted optional `null` fields

Symptom: Codex returned `null` for optional plan fields where the contract
expects omission, failing PlanSchema validation.

Impact: planner output was structurally reasonable but rejected before durable
execution.

Recovery used: normalized optional nulls in the Codex process runner and
updated the prompt to ask Codex to omit optional null values.

Recommended fix: keep a runtime-normalization layer for all CLI runtimes, and
report schema repairs as explicit telemetry so they can be tracked.

### 4. Codex subprocesses needed noninteractive approval config

Symptom: Codex subprocesses could sit idle waiting for approval behavior.

Impact: workflows looked "running" while no useful work progressed.

Recovery used: added `-c 'approval_policy="never"'` to spawned `codex exec`
commands.

Recommended fix: make noninteractive runtime settings part of runtime
capability registration and expose them in `pm-go status` or agent-run metadata.

### 5. Main-branch advancement assumes `main`, not the active dogfood branch

Symptom: phase audit pass tried to advance local `main`; dogfood work was on
`dogfood/desktop-mvp`, with local commits beyond the phase base. This produced
`main-advance-conflict` or would have dropped local Codex runtime fixes if used
naively.

Impact: successful phase work can block after audit, even when the integration
head is correct.

Recovery used: manually merged audited integration heads into
`dogfood/desktop-mvp`, advanced local `main` when safe, and in one case
rewrote the merge-run head to the combined commit containing both M3 work and
operator runtime fixes.

Recommended fix: make target branch explicit per run/plan. Phase audit should
advance the plan target branch, not hard-code `main`. Recovery should support
"rebase/recreate merge-run from current target branch" without direct DB edits.

### 6. No public retry path for integration-validation blocks

Symptom: Phase 0 integration blocked after validation failed on the first task
because that task imported `@pm-go/contracts` without declaring the desktop
workspace dependency. After fixing the task branch, `/integrate` refused because
the phase was already `blocked`.

Impact: a recoverable integration-validation failure required manual phase
status surgery before retrying integration.

Recovery used: committed dependency fixes on the task branch, changed the phase
row back to `executing`, and retried `/integrate`.

Recommended fix: add an explicit recovery endpoint, for example
`POST /phases/:id/retry-integration`, that records the operator reason,
preserves the failed merge-run, and starts a new integration attempt.

### 7. Re-auditing the same merge-run fails uniqueness

Symptom: after correcting durable state, rerunning `/audit` against the same
merge-run failed at `persistPhaseAuditReport` with duplicate key
`phase_audit_reports_phase_merge_unique`.

Impact: the workflow completed the Codex audit but failed during persistence,
leaving the phase stuck in `auditing`.

Recovery used: inserted a new merge-run row pointing at the corrected head, then
audited that new merge-run.

Recommended fix: model audit attempts explicitly. Either include `attempt` in
the uniqueness constraint or make `persistPhaseAuditReport` idempotent/upsert
by `(phase_id, merge_run_id, workflow_id)`.

### 8. Phase audit read-only sandbox cannot be the only test verifier

Symptom: phase auditor reported missing Desktop test evidence because Vitest
attempted to write temp/cache files in the read-only audit sandbox.

Impact: code could be correct and locally verified, while phase audit still
blocked because it could not collect evidence itself.

Recovery used: ran `pnpm --filter @pm-go/desktop typecheck` and
`pnpm --filter @pm-go/desktop test` in the writable repo, documented results,
and reran/overrode via corrected evidence.

Recommended fix: feed integration validation logs into phase-audit evidence.
The model should audit durable command results, not rerun write-needing tests in
a read-only sandbox.

### 9. Planner file scopes missed package manifests and lockfile updates

Symptom: tasks that imported `@pm-go/contracts` changed
`apps/desktop/package.json` and `pnpm-lock.yaml`, but their scopes only allowed
renderer API/read-model paths.

Impact: reviewers and phase auditors correctly flagged out-of-scope changes,
even though the dependency updates were necessary.

Recovery used: amended durable task scopes for the affected Phase 0 tasks to
include `apps/desktop/package.json` and `pnpm-lock.yaml`.

Recommended fix: when a task scope includes a workspace package and code may
add imports/dependencies, automatically include that package manifest and the
lockfile or require the planner to state a no-dependency-change constraint.

### 10. Planner scopes used non-existent route directory globs

Symptom: Phase 1 scopes included paths such as
`apps/desktop/src/renderer/routes/runs/**` and
`apps/desktop/src/renderer/routes/run/**`, but the existing M2 route layout is
flat files such as `RunsList.tsx`, `RunOverview.tsx`, and `PlanPhases.tsx`.

Impact: the first Phase 1 implementer created new wrong route directories,
which would have increased UI duplication and likely failed later reviews.

Recovery used: terminated the stale task workflow, removed its worktree/branch,
updated durable Phase 1 scopes to actual files, and restarted the task.

Recommended fix: plan audit should verify every fileScope glob against the
current repo tree. A glob that matches nothing should be a planning finding
unless it is explicitly marked as "new path allowed".

### 11. Stale task prompts do not pick up corrected durable scopes

Symptom: changing file scopes in the database did not affect an already-running
Codex implementer, which kept following the stale prompt and stale worktree.

Impact: operator had to terminate the Temporal workflow, kill the subprocess,
remove the worktree, release the lease, reset task state, and rerun.

Recovery used: manual termination plus worktree/branch cleanup.

Recommended fix: expose an operator-safe "cancel and rerun task with current
durable task row" endpoint that handles Temporal termination, process cleanup,
lease release, task reset, and audit trail in one command.

### 12. Long-running Codex subprocesses have poor progress visibility

Symptom: Codex implementers/reviewers often ran 5-17 minutes with no drive
output until the task state changed.

Impact: difficult to distinguish healthy long-running work from a stuck
subprocess without inspecting `ps`, worktree status, DB rows, and worker logs.

Recovery used: manual polling of process table, task API, worktree diffs, and
agent-run rows.

Recommended fix: stream Codex JSON events into `agent_tool_calls` or a runtime
heartbeat table and surface "last event at" in `pm-go drive` and `pm-go status`.

### 13. Review/fix cycle can expose real product bugs, but escalation is clumsy

Symptom: Codex reviewer found real issues such as:

- empty live `tasks: []` / `phases: []` being treated as unavailable instead of
  zero attention counts;
- stale README decision text contradicting the actual renderer-owned client;
- live empty state showing while `/plans` was still loading;
- event drawer receiving aggregate errors and labelling them event replay
  failures;
- partial refresh potentially overwriting last-known live cockpit data.
- failed non-release artifact content reads losing available evidence metadata
  and falling back to generic "Other" grouping;
- live Task Detail / Evidence / Artifact Detail route behavior being wired
  without tests for successful live reads and recoverable API failures.
- live routes briefly painting fixture data before the first API read, or
  keeping stale data visible while route params change, because request state
  was not keyed to the selected task/artifact/run.

Impact: the review system is useful, but when it blocks after max cycles or
needs operator changes outside the original scope, recovery requires manual
commits and override calls.

Recovery used: applied targeted operator fixes, added regression tests where
appropriate, and used review override for a task that exhausted cycles after the
operator verified the fix.

Recommended fix: add a first-class "operator patch attached to task" path that
can expand scope with reason, run validation, and re-enter review without
manual DB/state changes.

## Fixes Already Landed During This Session

- `fix(planner): strip untrusted milestone provenance from full-spec plans`
- `fix(runtime): normalize codex plan optional fields`
- `fix(runtime): run codex subprocesses without approvals`
- M3 Phase 0 Desktop API/read-model work integrated and audited pass
- README M3 decisions aligned with renderer-owned API client
- Read-model regression fix for supplied-empty collections versus omitted data

## Recommended Near-Term Product Work

1. Make Codex a supported root runtime path or clearly document the supported
   `run` plus `drive` workflow.
2. Add explicit recovery endpoints for retrying integration, retrying audit, and
   cancelling/rerunning a task with current durable state.
3. Make plan target branch explicit and stop hard-coding `main`.
4. Teach plan audit to reject file scopes that match no existing files unless
   they are explicitly new paths.
5. Feed validation command logs into phase-audit evidence.
6. Add runtime heartbeat/progress events for Codex subprocesses.
7. Treat workspace manifest and lockfile changes as first-class scope
   expansions when task code changes dependencies.

## 2026-05-12 Claude Code Runtime Dogfood Session

Resumed the same plan (`73bd9a65-4304-4d13-9807-68c4f27a047c`, M3 Phase 1 in
progress) but with Claude Code as both driver and model. Recorded here so the
runtime-comparison story stays in one place.

### Claude runtime selector confusion

- `pm-go run --runtime claude` exists in CLI help but the worker boots with a
  stub Claude CLI process runner and crashes on the first activity:
  `WARN: PLANNER_RUNTIME=claude selected the Claude CLI process runner, which
  is a stub and will throw on first activity invocation`. The crash takes the
  supervisor down.
- `pm-go doctor` reports `--runtime auto → anthropic-sdk (Claude Code OAuth
  session found ~/.claude/.credentials.json)`. The working knob is
  `--runtime sdk` (uses the Claude Code OAuth credentials via the Anthropic
  SDK). `claude` is reserved for a future CLI-process executor.
- Fix idea: until the CLI-process runner ships, `--runtime claude` should
  either route to the SDK or refuse at startup with a clear error, not boot
  and crash on first dispatch.

### `pm-go ps` does not track `pm-go drive` when launched standalone

- `nohup pm-go drive --plan <id> --approve all > log &` runs the drive
  process, but `pm-go ps` only lists `supervisor / worker / api`, even
  though CLI help advertises `drive pids`. Operators have no built-in way
  to see drive status, lifetime, or exit; you must shell-ps by hand.

### Per-task review missed an integration-only contract drift

- `live-task-artifact-detail` changed `ArtifactDetail` to anchor its
  back-link on the URL `planId` (always non-null when on the route), via
  `planId !== null ? <Link/> : null`.
- `renderer-live-data-tests` was authored against the pre-merge route
  (which suppressed the back-link when `artifact === null`) and asserted
  `expect(html).not.toContain('data-testid="artifact-detail-back-link"')`
  for the error envelope.
- Both tasks were reviewed in isolation against their respective
  worktrees and passed. The contract drift only surfaced when both
  changes landed on the phase-1 integration branch: post-merge
  validation failed on
  `test/renderer/routes/liveDataFallback.test.tsx > Artifact Detail
  renders the error envelope safely with no executable markup and no
  broken back-link`.
- Phase moved to `blocked`. `merge_runs.failed_task_id` was set to the
  renderer task, even though all three task merge commits had landed on
  the integration branch (`f1fc2b5`).
- Fix idea: the per-task reviewer needs a "look at sibling-task
  HEADs in the same phase" pass — or the phase integrator needs a
  pre-merge dry-run that runs `pnpm test` against the cumulative
  integration head before stamping any task as `merged`.

### `merge_runs.failure_reason` was NULL despite post-merge test failure

- bug #14's instrumentation promised "we now persist the trailing chunk
  of the captured validation logs ... on failure, and leave NULL on
  success." On this failure, `failure_reason` was NULL — the operator
  had no in-DB signal of what broke. Recovery required reproducing
  `pnpm --filter @pm-go/desktop test` by hand inside the integration
  worktree.
- Fix idea: re-check the post-merge validation activity — either the
  capture path didn't fire, or the `passed: false` branch didn't write
  the column.

### Operator recovery still requires raw DB surgery

- `/phases/:id/integrate` rejects `status='blocked'` (`409`,
  "/integrate requires 'executing' or 'integrating'").
- `/phases/:id/override-audit` only applies to phases blocked by an
  audit report; merge-run failures aren't covered (`override-audit
  refused`).
- There is no `/phases/:id/recover` or `/merge-runs/:id/clear-failure`
  endpoint. Recovery sequence used:

      UPDATE merge_runs
      SET failed_task_id = NULL,
          merged_task_ids = ['...all three task ids...']::jsonb,
          integration_head_sha = '<new fixup commit>'
      WHERE id = '<merge-run-id>';
      UPDATE plan_tasks
      SET status = 'merged'
      WHERE id = '<recovered-task-id>';
      UPDATE phases
      SET status = 'auditing'
      WHERE id = '<phase-id>';

      curl -X POST /phases/<phase-id>/audit

- Fix idea: ship the "operator patch attached to task / phase" path
  listed in the codex-runtime section. The Claude-runtime session
  proves this gap is runtime-agnostic.

### Phase audit fast-forwards `main`, not the dogfood branch

- Confirmed again: after phase 1 audit pass, `main` advanced to the
  integration head (the corrective fix commit `e70c754`), but
  `dogfood/desktop-mvp` stayed at its pre-phase-1 baseline (`3bfd853`).
  The dogfood branch ends every plan behind `main` by exactly the
  phase work.
- This is item #3 in the codex-runtime "Recommended Near-Term Product
  Work" list (make plan target branch explicit). Repeated here so the
  Claude session has it on the record too.

### Recovery commit landed in this session

- `e70c754 fix(renderer-live-data-tests): align artifact back-link
  expectation with live route` — sits on top of `f1fc2b5` on the phase-1
  integration branch and now on `main` via the audit fast-forward.

### Plan status at handoff

- Plan `73bd9a65-...` status: `approved`. Final `/plans/:id/release`
  step has not been called; both phases are `completed`, all six tasks
  are `merged`. Drive process exited at the integration block and was
  not relaunched because the next action would be a plan release, not
  new phase work — held for explicit operator/user direction per the
  "stop at next stable boundary" rule.
