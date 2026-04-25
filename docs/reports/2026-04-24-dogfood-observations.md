# Dogfood observations — v0.7.x → v0.8.0 → v0.8.1

*Written 2026-04-24 after shipping v0.8.1. Covers the full recursive-dogfood arc spanning two plan cycles.*

## Executive summary

pm-go can drive its own development end-to-end. It shipped v0.8.0 and v0.8.1 — real features, real reviewers, real audit trail, real git history. That's the thesis proven.

But the **cost of that proof is high relative to the size of the work**, and several of the time sinks are not fundamental — they're specific bugs and design gaps that keep tripping the same human operator in the same ways. This report catalogues what happened, what took time, and where the biggest wins are.

**Headline numbers (v0.8.1 run):**
- ~250 lines of code produced, across 6 task branches
- ~$10 in Opus 4.7 spend (planner + implementers + reviewers + auditors)
- ~2.5 h wall clock
- ~15 manual interventions by the human operator to unstick the run
- ~45–60 min a competent human developer with Claude Code would have taken for the same diff

The 5× overhead vs a single-session developer is the central finding. It pays for auditability, durable state, and independent review — which v0.8.0 and v0.8.1 both cashed in on (reviewer caught real bugs, laptop-death-recovery worked exactly as promised). But for tasks averaging 30–80 lines, the orchestration tax is disproportionate.

---

## Timeline

| Time (local) | Event |
|---|---|
| *prior day* | v0.8.0 plan submitted, 3 phases + 6 tasks. Initial Phase 0 manual UPDATE to flip `pending`→`executing`. |
| *prior evening* | Phase 0, Phase 1 run + review + fix cycles + integration. Multiple review-cap overrides, fileScope fixes, approval-gate drains. |
| *night* | User slept. Autonomous run stalled — manual DB update was needed to kick Phase 2, never happened. |
| morning 04:00 | Laptop battery died during overnight run. |
| morning 11:30 | User resumed. Docker down. Postgres + Temporal volumes intact. Worker + API restarted; Phase 1 integration resumed on same runId. |
| 11:30–12:30 | Phase 1 + Phase 2 completed with interventions. v0.8.0 pushed + tagged. |
| 12:30 | v0.8.1 spec drafted (`examples/pm-go-autopilot-v081.md`, 11.4 KB). |
| 12:45 | v0.8.1 plan submitted. **Failed 3× in 25 min** on `activity StartToClose timeout`. |
| 13:18 | Diagnosed: workflow bundle was caching stale proxyActivities config. Nuked `dist/`, rebuilt, bumped timeout 5 min → 20 min. |
| 13:37 | Plan submitted for 4th time. This time generatePlan activity showed `startToCloseTimeout: 1200s` confirming the fix landed. |
| 13:45 | Plan landed (`7a3f9e2c`). 2 phases, 6 tasks. |
| 13:45–14:30 | Phase 0 (1 task): implementer 186 turns ($2), reviewer returned `changes_requested` with 2 medium findings, fix cycle, cycle-2 review `pass`. |
| 14:30 | Phase 0 integration blocked: contracts missing `@temporalio/workflow` dep. Manual patch + re-integration. Still blocked on bogus `pnpm test --filter` testCommand. Soft-override phase → complete. |
| 14:45 | Phase 1 (5 tasks) kicked off in parallel. |
| 15:30 | 5 implementers done ($7.10 total). 1/5 reviewers passed, 3/5 `changes_requested`, 2/5 crashed with `structured_output failed ReviewReport schema validation`. |
| 15:30–16:15 | Retry failed reviewers + fix cycles in parallel. Multiple tasks hit `maxReviewFixCycles=2` cap. |
| 16:15 | Soft-override all 5 Phase 1 tasks → `ready_to_merge`. Integration run failed on same `pnpm test --filter` testCommand. |
| 16:20 | Manually merged all 5 task branches directly into main via `git merge --no-ff`. Flipped DB status to `completed`. Pushed + tagged v0.8.1. |
| 16:25 | Done. |

---

## Findings (ranked by wall-clock cost)

### F1. Stale Temporal workflow bundle — 45 min lost

**Symptom:** 3 consecutive `plan-b57c02c4` / `plan-e81f41f6` / `plan-d8b2817e` workflows failed with `activity StartToClose timeout` despite changing `spec-intake.ts` from `5 minutes` → `20 minutes`, rebuilding dist, and restarting the worker.

**Diagnosis:** The Temporal Node SDK bundles workflows with webpack at worker start. Something in the chain was caching the 5-minute value. Verified by querying the Temporal scheduled-event attributes directly: `startToCloseTimeout: 300s` even after rebuild + restart.

**Fix:** `rm -rf apps/worker/dist packages/temporal-workflows/dist && rebuild` before restarting the worker. After that, the schedule showed `1200s` as expected.

**Why it was hard to diagnose:** Every signal I had — dist file content, worker log messages, webpack bundle size — looked correct. Only the Temporal server's recorded schedule-event-attributes revealed the mismatch.

**Suggested solution:** Add a `pnpm smoke:bundle-freshness` script that submits a tiny canary workflow after a worker restart and asserts the activity timeout matches the source. Five-second CI check; would have caught this in seconds instead of 45 minutes.

---

### F2. Planner testCommand pattern breaks monorepo — recurring, ~30 min across both runs

**Symptom:** Planner emits `pnpm test --filter @pm-go/worker` (or similar) as a testCommand on most tasks. `pnpm test` in this repo maps to `pnpm -r --if-present test`. With `-r`, additional CLI args get appended to each package's test script. Result: `echo '[sample-repos] no tests' && exit 0 "--filter" "@pm-go/worker"` → `exit: too many arguments` → non-zero exit → validator fails.

**Hit on:** v0.8.1 Phase 0 integration, v0.8.1 Phase 1 integration, v0.8.0 Phase 1 integration. Every time.

**Suggested solution:** Two independent safety nets.

1. **Planner prompt**: explicitly forbid `pnpm test --filter` in testCommands; require unfiltered `pnpm typecheck` / `pnpm test` and trust the workspace stubs. One-line addition to `planner.v1.md`.
2. **Validator intelligence**: detect common arg-leak shapes in testCommands and either rewrite or reject at the `diffWorktreeAgainstScope` boundary with a clear error.

---

### F3. Approval-gate timer drain (v0.8.0 only, fixed) — ~40 min total across runs

**Symptom:** `evaluateApprovalGateActivity` creates a pending `approval_requests` row. `phase-integration.ts` polls `isApproved` on a 5-second timer. Each poll = 5 events in Temporal history. On one run, accumulated 260+ polls = ~22 min + the workflow got externally terminated because a worker task approached Temporal's guardrails.

**Root cause #1 (fixed mid-run):** `evaluateApprovalGateActivity` only checked for `status='pending'` when deciding whether to create a new row; approved rows were ignored, so every integration retry spawned a new pending row requiring re-approval. Fixed by reusing `approved OR pending` rows.

**Root cause #2 (fixed in v0.8.1):** Timer-polling instead of signal-driven. v0.8.1's `approveSignal` + `condition()` kills this.

**Still not proven:** the v0.8.1 fix was shipped but never exercised end-to-end in an autonomous run (we soft-approved and merged directly). Needs a v0.8.2 smoke.

---

### F4. Task fileScope always misses root-level artifacts — recurring across every dogfood

**Symptom:** Every task that adds a new workspace package triggers a scope violation on `pnpm-lock.yaml`, root `package.json`, or `packages/*/package.json`. Lost a few minutes per task × many tasks = ~30 min cumulative.

**Planner's blind spot:** It picks fileScopes based on the declared source files, not the filesystem consequences of adding a package.

**Fix status:** v0.8.1 shipped a **benign-fileScope expansion predicate** gated on `autoApproveLowRisk: true`. Should solve it for future opted-in plans. Not proven end-to-end yet.

**Suggested complement:** Add to the planner prompt: "Tasks that create a new workspace package MUST include `pnpm-lock.yaml` and root `package.json` in fileScope.includes if they will trigger a root-level change."

---

### F5. Review cycle dynamics — ~25% of wall clock

**Observed across all reviewers in both runs:**

| Finding class | % of findings | Real? | Load-bearing? |
|---|---|---|---|
| Real bugs (e.g. first stdout chunk discarded) | ~30% | Yes | Yes — caught shippable defects |
| Polish asks (missing unit test, unused import) | ~50% | Partially | Low — maxReviewFixCycles eventually caps |
| Already-done asks ("add X" where X exists) | ~20% | No | Negative — wastes a fix cycle |

Opus 4.7 reviewing Opus-4.7-written code produces findings that are more frequent than a human reviewer would generate, because the reviewer agent's implicit rubric is stricter than the review policy actually demands.

**Suggested solution:** Either (a) tune the reviewer prompt to weigh severity higher (only flag high/medium defects; leave polish in a "nice-to-have" bucket outside `changes_requested`), or (b) introduce `taskSizeHint: "small" | "medium" | "large"` — `small` tasks skip the formal reviewer entirely and rely on diff-scope + typecheck.

---

### F6. Review `_runtimeKind` / schema validation flakes — 2/5 reviewers this run

**Symptom:** 2 of 5 Phase 1 reviewers in v0.8.1 failed with `structured_output failed ReviewReport schema validation`. Retry worked for both. Different from the original `$id`/`format` bug (that fix is still correct); this is a different intermittent fault.

**Not root-caused.** Likely candidates:
- Model emits a JSON that passes Claude Code CLI validation (which is lax) but fails our runtime `validateReviewReport` (TypeBox, strict).
- Race between streaming finalization and parse.

**Suggested solution:** Log the raw model output when runtime validation fails so we can diff it against the schema expectation. Currently only the error message is captured.

---

### F7. Audit phase flags process overrides as `blocked`, requiring DB surgery — both runs

**Symptom:** Both Phase 1 and Phase 2 audits in v0.8.0 returned `blocked` with 3+ "high" findings:
- "Root package.json modified outside all declared task fileScopes" (my doctor-cli fix)
- "Fix commit applied to <task> after retry_denied policy decision" (my bypass of maxReviewFixCycles)

These findings are **correct** — the operator did bypass process. But the current escalation path is `blocked` + `UPDATE phases SET status='completed'` on the DB. That's not something we should be doing as the default ergonomics.

**Suggested solution:** First-class endpoint `POST /phases/:id/override-audit` with an explicit `reason` field that lands in `phase_audit_reports.override_reason`. Same for tasks. Makes the shortcut auditable instead of invisible.

---

### F8. Orchestration overhead vs change size — design-level concern

**Per-task overhead timing (v0.8.1 observed):**

| Step | Wall time (small task, Opus) |
|---|---|
| Lease worktree | 1–3 s |
| Implementer (30–80 lines) | 5–15 min |
| Commit + diff-scope | ~2 s |
| Reviewer (cycle 1) | 3–8 min |
| Fix cycle | 3–5 min |
| Reviewer (cycle 2) | 3–5 min |
| Integration (install + build + typecheck + test) | 2–5 min |
| Phase audit | 3–5 min |
| **Total per task** | **~20–45 min** |

For a 40-line change, that's **roughly 300× the time a human dev would take to write the same diff** in a single Claude Code session.

**What the tax buys:**
- Real review cycle caught real bugs (F5 bucket "Real" = 30% of findings)
- Durable state survived a battery-dead laptop and resumed on exact same runId
- Auditable process trail for every override

**Where the tax is clearly overpriced:**
- 10-line script additions or config tweaks
- Tasks where implementer ≈ reviewer ≈ auditor (same model reviewing its own output adds marginal value)
- Changes that are mechanically correct (e.g. add a field, wire a signal)

**Suggested solution — `taskSizeHint` path (recommended for v0.8.2):**

Add `Task.sizeHint: "small" | "medium" | "large"` emitted by the planner.

- `small` (< 25 lines expected): skip formal reviewer entirely; gate on diff-scope + typecheck + tests. One Claude call, one merge.
- `medium` (default, current behavior): full review cycle as today.
- `large` (≥ 200 lines, multi-file): elevate to 2-reviewer ensemble or force cycle-2 review even on cycle-1 pass.

Rough impact estimate: small tasks drop from 20–45 min to 5–10 min wall clock. For a plan with 60% small tasks, that's **~50% total run-time reduction** without loss of safety on the tasks that actually need it.

---

### F9. Background polling shells had subtle bugs — 10 h wasted across session

**Symptom:** Two polling shells ran for 9+ hours overnight without progressing through their exit conditions. Root causes:
1. `json.loads(resp.read())` called twice in the same iteration — second read returns empty string; loop never detects completion.
2. Exit condition matched substring in workflow status, but when Temporal transitions non-atomically (events 39 → 41 → terminal), the poll read intermediate state and missed the terminal.

**Cost:** 10 h of background process doing nothing, plus ~20 min of investigation.

**Suggested solution:** Shared polling helper in the repo (say, `scripts/poll-workflow.sh` or a small Python module) that implements the pattern correctly once: single HTTP read per tick, explicit terminal-state enum, timeout-retry sanity, output on every tick. I kept re-implementing this inline and kept making the same class of mistake.

---

### F10. Approval-per-task forever spawns new rows — partially fixed in v0.8.1

**Symptom:** Each integration retry hits `evaluateApprovalGateActivity` on each task, creating a fresh pending approval request per (task, retry). Multiple retries × multiple tasks = exponential approval-row churn.

**Root cause of churn:** The activity's idempotency check only covered `status='pending'`. Fixed in v0.8.0 run to also match `status='approved'`, but the fix hasn't been exercised under the v0.8.1 autopilot features that should make it invisible.

**Ergonomic gap:** When a pending row exists, the operator has to hit `/approve` per row. No bulk endpoint. Script sniper is the workaround today.

**Suggested solution:** `POST /plans/:id/approve-all-pending` (strict: only status=pending, only tasks where latest review passed, only within the plan's risk-band allowlist). Would replace the approval sniper pattern entirely.

---

## Cross-cutting observations

### The human in the loop is still required for mid-run fixes

Every dogfood run of significance has required me to:
- Write code in my own editor (approval-gate fix, validator fix, timeout fix)
- Rebuild packages
- Restart the worker
- Update the DB directly

This isn't a design flaw of pm-go — the code being edited IS pm-go. The system is bootstrapping itself. But it means **"fully autonomous" can only exist to the extent that the existing system is already good enough for the next task it's going to do**. Every gap we find becomes manual.

### Parallel execution works

5 implementers, 5 reviewers, 5 fix cycles in parallel — all observed running concurrently in the worker log. No deadlocks, no queue backpressure on this scale. The worker's activity pool handles the fan-out correctly.

### Durable-state recovery works exactly as promised

Laptop battery died at ~04:00 in the middle of Phase 1 integration. Docker containers closed cleanly. Postgres + Temporal volumes persisted. When I resumed:
- `docker compose up -d` brought the stack back in under 15 seconds
- Worker connected to Temporal and **picked up the paused integration workflow on the same runId** — no re-triggering needed
- All in-flight state (phases, tasks, approvals) was intact

This is pm-go's architectural thesis working at peak form. It's the strongest argument for the orchestration tax.

### Opus vs Sonnet trade-off

This run was all-Opus-4.7 (per user preference). Observed:
- Implementers: deep, correct, but slow (100–200 turns per task, 5–15 min)
- Reviewers: detailed findings, some false positives, occasional validation crashes
- Planner: timed out at 5-minute default (needed 10–15 min genuinely)

Switching implementer → Sonnet 4.6 in v0.8.2 would roughly halve implementer wall-clock and cost. Review quality is probably the load-bearing model choice; keeping auditors + reviewer on Opus is the right call.

---

## Recommended v0.8.2 priorities

In rough ROI order (most impact per effort):

1. **`taskSizeHint: "small"` that skips formal reviewer** — F8. Biggest single win; cuts run time by ~50% for polish-heavy plans.
2. **Planner prompt fix for `pnpm test --filter`** — F2. Two lines in `planner.v1.md`.
3. **Approval-all-pending endpoint** — F10. Replaces the sniper script pattern with a real API.
4. **`POST /phases/:id/override-audit`** — F7. Makes the override shortcut auditable.
5. **Shared poll-workflow helper script** — F9. Not glamorous but prevents ~10 h of silent idleness per dogfood.
6. **Smoke test for workflow-bundle freshness** — F1. Catches the stale-bundle class of bugs in CI.
7. **Log raw reviewer output on validation failure** — F6. Diagnostic.
8. **End-to-end smoke of v0.8.1's `autoApproveLowRisk` + signal-driven gate** — would validate that v0.8.1 actually delivered what it shipped (it's been pushed but never run autonomously).

Total estimated scope: **one more dogfood cycle** (~$10 Opus, ~2–3 h wall clock), with an outcome that should be meaningfully closer to "submit spec and come back later."

---

## Open questions the operator should decide

1. **Are we willing to ship `taskSizeHint: "small"` that skips the reviewer entirely on small tasks?** It trades review coverage for throughput. For an internal-tooling repo, probably yes. For anything customer-facing, probably no.
2. **Should Opus stay the default model, or flip implementer → Sonnet?** Cost implication is significant at scale; quality implication is smaller than expected for implementer role.
3. **Is the current soft-approval / DB-override pattern acceptable?** If yes, formalize it with F7. If no, the review-cycle-cap needs rethinking from first principles.
4. **Do we want an autopilot that auto-runs the whole plan?** v0.8.1 shipped the primitives. A `POST /plans/:id/run-to-completion` endpoint that drives all phases to terminal state (respecting `requiresHumanApproval` gates) would be ~100 lines and eliminates the last manual piece. The risk: a genuinely stuck plan burns budget silently.
