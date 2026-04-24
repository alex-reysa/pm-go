# pm-go v0.8.1: Autopilot foundations + v0.8.0 process-runtime gap closers

## Objective

Turn pm-go from "semi-manual with frequent human unblocks" into a system that can drive a plan from `approved` → `completed` without a human operator doing database UPDATEs, while also closing the three v0.8.0 process-runtime gaps that shipped as known-good-but-incomplete under `v0.8.0`.

## Motivation

Today's v0.8.0 dogfood run required **five distinct manual interventions** to keep moving, each of which is a small, well-understood code change:

1. After a plan is approved, Phase 0's status stays `pending` — somebody has to flip it to `executing` by hand before any task can run.
2. When a task adds a new workspace package (or a root npm script), the implementer's commit picks up `pnpm-lock.yaml` / root `package.json`, which aren't in the declared fileScope, so the task gets `blocked` on a scope violation even though the change is benign.
3. The `evaluateApprovalGateActivity` creates a pending `approval_requests` row on every gate hit; with no auto-approver it sits there until a human approves. The integration workflow then polls `isApproved` on a 5-second timer for up to ~20 minutes before Temporal terminates it. On one of today's runs this drained 261 timer iterations before the gate unblocked.
4. The approval gate is polled, not signaled — even after a human approves, the workflow waits up to 5 seconds for the next tick.
5. Process runners created in v0.8.0 stub-throw on `.run()`; the Bash tool is advertised to every role through the policy bridge; and there's no unit test covering the `_runtimeKind` discriminant. The v0.8.0 audit flagged all three.

v0.8.1 ships the smallest coherent set of changes that kills items 1–4 and closes item 5.

## Scope — in

### 1. Auto-start Phase 0 on plan approval

`persistPlan` (or a small new `kickoffFirstPhase` activity called right after it in `SpecToPlanWorkflow`) must transition the phase with `index=0` from `pending` → `executing` in the same transaction that marks the plan `approved`. This mirrors what `PhaseAuditWorkflow` already does for subsequent phases ("set next phase to `executing`"); the missing piece is the initial hand-off at plan time.

### 2. Signal-driven approval gate

Replace the current timer-polling loop inside `phase-integration.ts` / `task-execution.ts` (anywhere `isApproved` is called in a `while` + `sleep` shape) with a workflow signal handler + condition:

```ts
let approvalResolved = false;
setHandler(approveSignal, () => { approvalResolved = true; });
// ...
await condition(() => approvalResolved, /* optional timeout */);
```

The API route `POST /tasks/:id/approve` (and `POST /plans/:id/approve`) must send a `workflowClient.getHandle(workflowId).signal('approve', ...)` to every workflow currently blocking on that subject in addition to writing the DB row. The workflow bundle exports the signal so the boundary stays type-safe.

On signal, the workflow resumes within seconds (no 5 s poll ceiling). On a long gap the workflow's `condition` timeout (set to the existing `scheduleToCloseTimeout` budget) still fires loud.

### 3. Policy-engine auto-approval for low-stakes requests

In `evaluateApprovalGateActivity` (policy.ts), when a new approval row would be inserted, consult an auto-approve predicate first. Grant the row at creation time (status=`approved`, `requested_by`=`policy-engine`, `approved_by`=`policy-engine:auto`) when **all** of:

- `task.requiresHumanApproval === false`
- `reviewer.outcome === "pass"` for the latest review cycle on this task (if any review has run)
- computed `risk_band ∈ {"low", "medium"}`
- plan has `autoApproveLowRisk: true` metadata (default `false` for safety — has to be opted in per plan)

Return the approved row's id so the workflow's `isApproved` / `condition` check passes instantly. When `autoApproveLowRisk` is absent or any predicate fails, fall through to today's behavior (pending row, human gate).

### 4. Auto-expand fileScope for known-benign root artifacts

`diffWorktreeAgainstScope` currently treats any changed file not in `fileScope.includes` as a violation. Add a narrow allowlist predicate for the specific shape we've hit repeatedly today:

- `pnpm-lock.yaml` — when the task's diff also touches at least one new workspace `package.json`
- Root `package.json` — **only** when the diff adds a single `scripts.*` key (no dep changes, no other structural edits); detected by parsing the pre/post JSON
- `packages/*/vitest.config.ts` — when the task also touches `packages/*/src/**` under its declared scope

When matched, the file is recorded as an auto-expanded scope entry in a new `scope_expansions` column on `agent_runs` (or a lightweight `scope_decisions` table if simpler) for durable audit, and NOT counted as a violation. Anything else remains a violation.

This feature is gated by the same `autoApproveLowRisk` plan metadata as §3 — it is strictly opt-in.

### 5. ProcessRuntime `.run()` spawn implementation

Complete the Claude CLI adapter shipped in v0.8.0's `packages/executor-process`. The `run()` method of every runner (planner, implementer, reviewer, phase-auditor, completion-auditor) must:

1. Build the `claude -p "<prompt>" --verbose --output-format stream-json --input-format stream-json --max-turns <n> --json-schema <json>` argv with the correct per-role flags (planner is read-only, implementer has write tools scoped by the policy bridge, etc.).
2. Spawn the child process with `cwd = input.worktreePath` (or `input.cwd` for the planner), inherit `stdout`/`stderr` pipes, drain both fully.
3. Parse the JSONL stream from stdout and translate each event to the `SDKMessage` shape the existing accumulator loop already consumes. Drop the first-chunk-discard bug flagged by the v0.8.0 reviewer (read _all_ bytes from stdout, not just chunks that arrive after the first `on('data')` call).
4. Return the same `{ plan, agentRun } | { report, agentRun } | { agentRun, finalCommitSha? }` shapes the SDK-backed runners return, with cost / tokens / turns / stopReason accumulated from the result message.

### 6. Bash tool restriction in the policy bridge

In `packages/executor-process/src/claude/policy-bridge.ts`, the MCP server currently advertises `Bash` as an allowed tool for every role. For **planner / reviewer / phase-auditor / completion-auditor**, drop `Bash` from the advertised tool list entirely — those roles are read-only and never need a shell. Only the implementer keeps `Bash` (gated by the existing `FORBIDDEN_BASH_PATTERNS` list).

### 7. `_runtimeKind` discriminant unit test

Add a test in `packages/executor-process/src/__tests__/runtime-kind.test.ts` that asserts `createProcessPlannerRunner(...)._runtimeKind === "process"` and that the SDK counterpart exposes `_runtimeKind === "sdk"` (add this field to the SDK runners if missing). Ensures consumers can discriminate without `instanceof` checks.

## Scope — out (defer)

- **Full autopilot plan mode.** A plan-level `autoMode: true` that auto-handles every gate end-to-end is tempting but too ambitious for `.1`. §3 already delivers the core "auto-approve when safe" behavior; a meta-flag can wait.
- **Codex / Gemini adapters.** Still deferred per v0.8.0's roadmap; v0.9.0 scope.
- **TUI runtime / plan-mode selector.** Env vars only.
- **Observability for scope-expansion events.** A durable record exists (§4); emitting a dedicated `workflow_events` row plus a Grafana-ready span can wait to v0.8.2.

## Constraints

- **No contract changes** to `Plan`, `AgentRun`, `ReviewReport`, `PhaseAuditReport`, `CompletionAuditReport`. A new `Plan.autoApproveLowRisk` optional boolean may be added (§3) — additive only.
- **No breaking changes** to any existing workflow's signal/query surface. The new `approve` signal is additive.
- **Autopilot features must be opt-in** per plan (`autoApproveLowRisk: true`). A plan submitted without the flag behaves identically to today.
- **Every auto-decision is durably logged.** `approval_requests.requested_by = 'policy-engine:auto'` makes auto-approvals grep-able; scope expansions land in a `scope_decisions` record; both are visible in existing audit trails.
- **Preserve today's OAuth fallthrough.** `PLANNER_RUNTIME=sdk` must continue to work for API-key users and for Claude Code subscription (OAuth) users.

## Acceptance criteria

1. A plan submitted via `POST /plans` with `{ autoApproveLowRisk: true }` runs end-to-end to `completed` against the existing Phase 5 smoke fixture **with zero human interventions** — no DB writes by the operator, no HTTP `/approve` calls, no status flips. Verified by a new integration test.
2. Submitting the same plan without `autoApproveLowRisk` (default) behaves identically to today — every gate creates a pending row, human approval still required.
3. `POST /tasks/:id/approve` against a workflow in the approval gate resumes the workflow within **2 seconds** of the POST returning (measured in the test), replacing the 5 s timer floor.
4. Running the Phase 5 smoke fixture with `IMPLEMENTER_RUNTIME=claude` (Claude CLI process path) completes without the "first stdout chunk discarded" symptom — the reviewer correctly observes every token emitted by the mock-claude fixture.
5. The v0.8.0 `pm-go doctor` output still works (regression guard).
6. Full `pnpm typecheck && pnpm test` green.
7. `scripts/phase7-process-runtime.sh` continues to pass against the mocked binary shipped in v0.8.0.

## Repo hints

- `apps/worker/src/activities/plan-persistence.ts` — `persistPlan` activity; add the Phase-0 kickoff here or adjacent.
- `apps/worker/src/workflows/phase-integration.ts` and `apps/worker/src/workflows/task-execution.ts` — current polling shape to replace with signal + `condition`.
- `apps/worker/src/activities/policy.ts` — `evaluateApprovalGateActivity`; add auto-approve predicate here.
- `apps/worker/src/activities/integration.ts` — `diffWorktreeAgainstScope`; add benign-expansion predicate.
- `packages/executor-process/src/claude/spawn.ts` and `stream-mapper.ts` — where the v0.8.0 adapter left off; fill in the `.run()` surface.
- `packages/executor-process/src/claude/policy-bridge.ts` — Bash advertisement fix.
- `apps/api/src/routes/tasks.ts`, `.../plans.ts` — `/approve` routes must signal the workflow in addition to writing the DB row.
- `packages/contracts/src/plan.ts` — add `autoApproveLowRisk?: boolean` to `Plan` shape.

## Risks

- **Auto-approval widens the trust boundary if a reviewer wrongly passes a risky change.** Mitigation: `autoApproveLowRisk` is per-plan opt-in, the `risk_band` cap is strict (only low + medium), and high-severity findings in reviewer reports must still cap `risk_band` to `high` in the policy engine.
- **Signal delivery failure.** If the API route successfully writes the DB row but signaling fails (e.g. Temporal is temporarily unreachable), the workflow stays blocked until a retry. Mitigation: send the signal inside the same `db.transaction` with an explicit `await handle.signal(...)` that rejects on error — the row-write becomes visible only when the signal is accepted.
- **Scope-expansion predicate missing an edge case.** A task that legitimately modifies `pnpm-lock.yaml` for an unrelated reason could have the change auto-approved when it should not be. Mitigation: the predicate requires the task to ALSO touch a `package.json` from a new package in the same commit — narrow enough that unrelated lockfile edits still fail as violations.
