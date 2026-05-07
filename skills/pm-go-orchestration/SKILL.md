---
name: pm-go-orchestration
description: Orchestrate software delivery with pm-go: choose the right agent-first, Layer-A decomposition, manual drive, resume, recovery, approval, audit, and release flow; start and inspect the local Docker/Postgres/Temporal control plane; and diagnose stuck plans with status/why before touching internals. Use whenever the user mentions pm-go, asks to run/decompose/drive/resume/recover/audit/release a spec or plan, asks about pm-go approvals/worktrees/Temporal/Postgres failures, or pastes a spec and says "use pm-go" even if they do not name this skill.
---

# pm-go Orchestration

pm-go pulls planning, retries, approvals, budgets, worktree lifecycle, merge order, and completion audit out of model context and into a durable control plane (Postgres + Temporal + git worktrees + typed contracts). Runs are resumable; "done" comes from evidence (diff-scope, reviewer findings, deterministic audit) rather than model claims.

## Operating Defaults

Prefer the CLI and typed operator tools over raw API calls. They preserve path containment, approval policy, process cleanup, and plan provenance. Use raw API only for manual recovery or when the user is explicitly working at the API layer; the current endpoint cheatsheet lives in `references/api-surface.md`.

When state is unclear, inspect first with `pm-go status` or `pm-go why <id>`. When command syntax is unclear, run `pm-go <command> --help` rather than inventing flags.

## Activation Loop (start here)

`pm-go` is **agent-first as of v0.9.x**. The default invocation is the agentic operator: it ensures Docker + Postgres + Temporal + worker + API are reachable, then drives the control plane through typed MCP tools.

| Goal | Command |
|---|---|
| Default — agent drives a spec | `pm-go --repo <repo> --spec <spec.md>` (or `pm-go agent ...`) |
| Larger / multi-milestone spec | `pm-go run --repo <repo>` in one terminal, then `pm-go decompose --repo <repo> --spec <spec.md> --edit` |
| Interactive operator (no spec) | `pm-go --repo <repo>` |
| Resume an operator session | `pm-go --resume <session-id>` |
| Legacy one-shot drive | `pm-go implement --legacy-drive --repo <repo> --spec <spec.md>` |
| Manual stack control | `pm-go run --repo <repo>` (keep attached) + `pm-go drive --plan <id>` from another shell |

`pm-go implement` without `--legacy-drive` also defaults to agent mode since v0.9. The pre-v0.9 "boot + submit + drive in one process" semantics live behind `--legacy-drive`, including its 20-minute plan-persistence ceiling.

Stay in the foreground; `Ctrl+C` tears it down cleanly. For the default agent, `--approve interactive` is the default; `--yes` changes the default approval policy to `all`; an explicit `--approve all|none|interactive` always wins. The legacy `implement` and low-level `drive` commands default to `--approve all`.

**Do not interrogate the user about env vars before running.** Trust `--runtime auto` (the default). It auto-detects, in priority order:

1. `ANTHROPIC_API_KEY` env var
2. Claude Code OAuth session at `~/.claude/.credentials.json` (i.e. the user is logged into Claude Code)
3. `claude` CLI on `PATH`

If none of those are present, the worker fails loudly at boot with an actionable error. You don't need to pre-check — the supervisor's first banner line tells you which auth source was selected.

If `pm-go` isn't on PATH, install it once (idempotent — re-running upgrades):

```bash
curl -fsSL https://raw.githubusercontent.com/alex-reysa/pm-go/main/scripts/install.sh | bash
```

## Agentic Operator (default)

The operator runs inside the Claude Agent SDK and exposes a typed MCP tool surface so the model can drive pm-go without raw curl. Every tool call lands on `agent_tool_calls` (with FK to `agent_runs.plan_id`) for full replay.

Tool surface (13 tools):

- **Lifecycle** — `pmgo_ensure_stack`, `pmgo_recover`, `pmgo_stop`, `pmgo_doctor`, `pmgo_status`
- **Submission** — `pmgo_submit_spec` (rejects model-supplied `specPath` / `repoRoot` outside operator scope)
- **Planning** — `pmgo_decompose_spec` (despite the name, this starts the normal full-spec planning workflow via `POST /plans`)
- **Manifest hooks** — `pmgo_update_manifest`, `pmgo_plan_first` (handler-backed hooks; use the CLI Layer-A flow unless production handlers are present)
- **Drive** — `pmgo_drive_plan` (rejects `approve` override; only operator's `--approve` policy wins)
- **Approve** — `pmgo_approve_pending` (returns `requires_confirmation` when operator chose `--approve none`)
- **Inspect** — `pmgo_why`, `pmgo_tail_events`

Path containment, approval-policy enforcement, and FK-safe `planId` extraction are wired into the tool wrappers. `pmgo_decompose_spec` intentionally does NOT record `planId` on the tool-call row: `POST /plans` returns the id synchronously, but the plans row is async-inserted by `persistPlan`, so recording the FK immediately would race.

## Layer-A: Decompose Large Specs

For specs > ~100 lines or scoping multiple milestones, use the Layer-A CLI to split the spec into an ordered `MilestoneManifest` before driving implementation. The command talks to a running API, so start the stack first:

```bash
# Step 1 — start the control plane and keep it running in one terminal
pm-go run --repo .

# Step 2 — from another shell, decompose, optionally edit, then plan the first milestone
pm-go decompose --repo . --spec ./feature.md --edit

# Step 3 — drive the plan id printed by decompose
pm-go drive --plan <plan-id>
```

`pm-go decompose` submits the spec, waits for the manifest, prints it, and unless `--manifest-only` is set, starts `plan-first` for the first milestone and prints the resulting plan id. Add `--edit` when the operator should review or adjust the manifest in `$VISUAL` / `$EDITOR` / `vi` before `plan-first`. Use `--manifest-only` when the next step is human review rather than immediate planning.

Provenance (`decompositionId`, `milestoneId`) flows through to the `plans` row so a downstream operator can trace the plan back to the manifest entry that scoped it. Current Layer-A behavior plans the first milestone only; it does not expose `--plan-first` or `--milestone-id` CLI flags, and it does not auto-chain later milestones.

## Visibility

Four commands cover most diagnostic needs without raw `tctl` or DB queries:

```bash
pm-go doctor             # env + CLIs + auth + infra (postgres/temporal/migrations/ports)
pm-go doctor --repair    # also auto-fix what it can (docker up, db:migrate, mkdir)
pm-go status             # worker config, API /health, open Temporal workflows
pm-go why <id>           # one-sentence state + next action for any plan/phase/task/spec id
```

Use `pm-go status` first when something looks stuck — it tells you the configured task queue + namespace + open workflows. A "scheduled but never picked up" workflow is almost always one of: stale `dist/` from before a code change, mismatched `TEMPORAL_TASK_QUEUE`, or the worker pointing at the wrong Temporal cluster.

## Picking a Model

`pm-go` defaults to `claude-opus-4-7` for every role. Override per-role or globally with env vars:

```bash
PM_GO_MODEL=claude-sonnet-4-6 pm-go --repo . --spec ./feature.md   # all worker roles
PLANNER_MODEL=claude-opus-4-7 IMPLEMENTER_MODEL=claude-sonnet-4-6 pm-go --repo . --spec ./feature.md
```

Recognized vars: `PLANNER_MODEL`, `IMPLEMENTER_MODEL`, `REVIEWER_MODEL`, `PHASE_AUDITOR_MODEL`, `COMPLETION_AUDITOR_MODEL`. `PM_GO_MODEL` is the shared fallback.

You should not need to edit `packages/planner/src/*.ts` — the env vars are the supported override.

## When to Use Sub-Commands Instead of the Default Agent

The default `pm-go` (agent) covers the common case. Reach for sub-commands when:

| Goal | Command |
|---|---|
| Boot the stack and stay attached to drive manually | `pm-go run --repo .` |
| Drive an already-submitted plan (e.g. after a crash) | `pm-go drive --plan <uuid>` |
| Resume after pause-for-approval | `pm-go drive --plan <uuid>` after approving |
| Pre-flight checks before committing to a long run | `pm-go doctor` then `pm-go --repo . --spec ...` |
| Layer-A: split a multi-milestone spec first | `pm-go run --repo .` then `pm-go decompose --repo . --spec ./feature.md --edit` |
| Legacy one-shot (pre-v0.9 `implement` semantics) | `pm-go implement --legacy-drive --spec ./feature.md` |

`pm-go run` is the supervisor without the auto-drive. `pm-go drive` assumes the API is already up on `:3001` and a plan exists in Postgres.

## Spec Format

The spec is a Markdown file. Key sections:

- **Objective** — one-paragraph scope
- **Scope** — what's in / out
- **Constraints** — technical bounds (no new dependencies, must preserve API X, etc.)
- **Acceptance Criteria** — bullet list, each becomes a test target the reviewer enforces
- **Repo Hints** — files and directories the planner should focus on

See `examples/spec-input-template.md` and `examples/golden-path/spec.md` in the pm-go repo for canonical examples.

One spec → one plan → one repo. If the work spans multiple repos (e.g. a candidate API in repo A and a router in repo B), file two specs. Specs accept an explicit `repoRoot` per submission, so a single API can host plans for multiple repos.

## State Machine

```
spec → plan → [for each phase] execute tasks → review → fix? → integrate → audit → complete → release
```

- **Tasks** within a phase run in parallel where dependencies allow.
- **Review** produces a `ReviewReport` with `pass | changes_requested | blocked`. `changes_requested` triggers up to `maxReviewFixCycles` repair cycles before escalation.
- **Phase audit** runs after task integration; `completion audit` runs after all phases complete.
- **Release** is gated on a passing completion audit.

`pm-go drive` runs all of this for you. The TUI (`pnpm tui` from the pm-go repo) is useful for human inspection but is not required.

## Approval Gates

High-risk tasks/phases pause for explicit approval. In the default agent, `--approve interactive` is the default and prompts the operator; `--yes` defaults the agent to `--approve all` for autonomous runs. In `pm-go drive` and legacy `pm-go implement --legacy-drive`, `--approve all` is the default. `--approve none` exits when an approval is needed; resume by approving and re-running drive.

When legacy `pm-go implement --legacy-drive` pauses for approval, it leaves the API + worker up and prints the exact approval URL. Resolve the approval, then re-run `pm-go drive --plan <uuid>`.

## Recovery

If the supervisor died mid-flight, or you don't know what state a plan/phase/task is in, run:

```bash
pm-go why <id>          # id can be plan, phase, task, or spec-document UUID
```

It returns one sentence with the current state and the exact next action. This is the single best diagnostic — reach for it before grepping source, opening the TUI, or hitting Postgres directly. If `why` says the plan is mid-phase, follow up with `pm-go drive --plan <uuid>` to resume from where the supervisor left off.

## Common Failure Modes

- **Worker workflow stuck "scheduled but never picked up"** — almost always stale `dist/`. Run `pnpm -r build` from the pm-go repo, then restart the worker. `pm-go status` confirms task queue + namespace alignment.
- **Diff-scope violation** — the implementer wrote files outside the task's `fileScope`. Either widen the scope (requires a plan re-draft) or tighten the task description.
- **Content-filter rejection** — `agent_runs.error_reason="ContentFilterError"` and the task is `blocked`. Adjust the spec wording for the affected task and re-run.
- **Phase won't advance** — every task in the phase must be `ready_to_merge`. Find the laggards: `curl http://localhost:3001/plans/<id>` and look for tasks in `reviewing` / `fixing`.
- **Workflow-id collision on resume** — `drive` reports `WorkflowExecutionAlreadyStarted` after a supervisor restart. Run `pm-go why <id>` and `pm-go status` first, sweep stale process state with `pm-go recover` if needed, then re-run `pm-go drive --plan <id>`.
- **Legacy `pm-go implement --legacy-drive` exits but plan exists in DB** — the supervisor's plan-persistence poll has a 20-minute ceiling. If hit, the API + worker stay up (post-v0.8.7 fail-open). Run `pm-go why <spec-id>` to find the actual plan UUID, then `pm-go drive --plan <real-id>` to pick up where it bailed.

### `[pm-go] port <port> is held by another service`

Phase-1 commands (`status`, `drive`, `why`, `recover`, `run`, `implement`, `decompose`) probe the API's identity endpoint before driving against it. When the probe gets HTTP back but the response isn't a pm-go identity envelope (`{"service":"pm-go-api",...}`), the CLI bails with a `PmGoIdentityMismatchError` whose first line is the stable, greppable prefix:

```
[pm-go] port 3001 is held by another service
```

**Cause.** Something other than the pm-go API is bound to the configured port — most often another `tsx`-loaded server squatting on `3001` (a stale `apps/api` process from a prior dev session, an unrelated local service, or a second pm-go instance that claimed the port first).

**Remediation (two options).**

1. Re-run the command with `--port <other>` to point pm-go at a free port.
2. Stop the conflicting process (`pm-go ps` then `pm-go stop` if it's a tracked pm-go supervisor; otherwise `lsof -i :3001` and shut down the offending service yourself).

## API Surface (advanced)

`pm-go drive` orchestrates the API for you. If the user is explicitly debugging API behavior or writing tests, read `references/api-surface.md` for the current raw endpoints. Do not copy old snippets from memory: `POST /spec-documents` uses `body`, and `POST /plans` needs both `specDocumentId` and `repoSnapshotId`.

## Stub Mode (CI / fast smoke)

Set `--runtime stub` for fixture-driven runs that exercise the full pipeline without calling Claude:

```bash
pm-go --repo . --runtime stub --spec ./examples/golden-path/spec.md
```

Useful for smoke-testing pm-go itself, not for solving real specs. Stub fixtures live under `packages/sample-repos/` and `examples/`.

## Anti-Patterns

- **Don't pre-check `ANTHROPIC_API_KEY`.** OAuth alone is sufficient. Ask the supervisor instead — it prints which source it picked at boot.
- **Don't edit `packages/planner/src/*.ts` to swap models.** Use `PM_GO_MODEL` or per-role env vars.
- **Don't invent Layer-A milestone-selection flags.** The public CLI plans the first milestone only; verify `pm-go decompose --help` before documenting new flags.
- **Don't `pkill -f pm-go`** — it kills the operator's monitors too. Use `pm-go ps` to inspect the supervisor-owned process registry, then `pm-go stop` to shut them down cleanly. (Both commands target only pm-go's tracked PIDs, so editor and dev-server processes survive.)
- **Don't run two supervisors against the same Postgres + Temporal.** Port 3001 collides. `pm-go status` will tell you something is already on that port.
- **Don't push to `main` of the pm-go repo while running pm-go on its own repo.** Baseline drift causes false phase-audit scope violations on every phase. See `docs/dogfood/v0.8.6-run.md` for the cautionary tale.

## Reference

- `examples/golden-path/` — full walkthrough of a stub-mode run
- `docs/getting-started.md` — manual API flow
- `docs/runbooks/` — operational recovery playbooks
- `references/api-surface.md` — raw API fallback for advanced/manual flows
- `packages/contracts/src/` — domain types (Plan, Task, AgentRun, ReviewReport)
- `artifacts/plans/` — generated plan Markdown after `SpecToPlanWorkflow` finishes
