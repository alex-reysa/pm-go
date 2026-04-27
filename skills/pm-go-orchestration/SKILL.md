---
name: pm-go-orchestration
description: Orchestrate software delivery with pm-go — turning a spec into a durable plan, running Claude implementers in isolated worktrees, managing the review loop, integrating phases, and releasing. Use whenever the user mentions pm-go, asks to plan/run a feature with pm-go, asks about the state of a plan, or wants to move a plan forward (run → review → fix → integrate → audit → release). Trigger even when the user just pastes a spec and says "use pm-go for this".
---

# pm-go Orchestration

pm-go pulls planning, retries, approvals, budgets, worktree lifecycle, merge order, and completion audit out of model context and into a durable control plane (Postgres + Temporal + git worktrees + typed contracts). Runs are resumable; "done" comes from evidence (diff-scope, reviewer findings, deterministic audit) rather than model claims.

## Activation Loop (start here)

When the user wants to use pm-go on a spec, default to **one command**:

```bash
pm-go implement --repo /path/to/target/repo --spec /path/to/spec.md
```

That single command boots Docker (Postgres + Temporal), applies migrations, starts the API + worker, submits the spec, and drives the resulting plan all the way to release. Stay in the foreground; `Ctrl+C` tears it down cleanly.

**Do not interrogate the user about env vars before running.** Trust `--runtime auto` (the default). It auto-detects, in priority order:

1. `ANTHROPIC_API_KEY` env var
2. Claude Code OAuth session at `~/.claude/.credentials.json` (i.e. the user is logged into Claude Code)
3. `claude` CLI on `PATH`

If none of those are present, the worker fails loudly at boot with an actionable error. You don't need to pre-check — the supervisor's first banner line tells you which auth source was selected.

If `pm-go` isn't on PATH, install it once:

```bash
curl -fsSL https://raw.githubusercontent.com/alex-reysa/pm-go/main/scripts/install.sh | bash
```

The installer is idempotent — re-running it upgrades.

## Visibility

Three commands cover most diagnostic needs without raw `tctl` or DB queries:

```bash
pm-go doctor             # env + CLIs + auth + infra (postgres/temporal/migrations/ports)
pm-go doctor --repair    # also auto-fix what it can (docker up, db:migrate, mkdir)
pm-go status             # worker config, API /health, open Temporal workflows
```

Use `pm-go status` first when something looks stuck — it tells you the configured task queue + namespace + open workflows. A "scheduled but never picked up" workflow is almost always one of: stale `dist/` from before a code change, mismatched `TEMPORAL_TASK_QUEUE`, or the worker pointing at the wrong Temporal cluster.

## Picking a Model

`pm-go` defaults to `claude-opus-4-7` for every role. Override per-role or globally with env vars:

```bash
PM_GO_MODEL=claude-sonnet-4-6 pm-go implement --spec ./feature.md   # all roles
PLANNER_MODEL=claude-opus-4-7 IMPLEMENTER_MODEL=claude-sonnet-4-6 pm-go implement ...
```

Recognized vars: `PLANNER_MODEL`, `IMPLEMENTER_MODEL`, `REVIEWER_MODEL`, `PHASE_AUDITOR_MODEL`, `COMPLETION_AUDITOR_MODEL`. `PM_GO_MODEL` is the shared fallback.

You should not need to edit `packages/planner/src/*.ts` — the env vars are the supported override.

## When to Use Sub-Commands Instead of `implement`

`pm-go implement` covers the common case. Reach for the lower-level commands when:

| Goal | Command |
|---|---|
| Boot the stack and stay attached to drive manually | `pm-go run --repo .` |
| Drive an already-submitted plan (e.g. after a crash) | `pm-go drive --plan <uuid>` |
| Resume after pause-for-approval | `pm-go drive --plan <uuid>` after approving |
| Pre-flight checks before committing to a long run | `pm-go doctor` then `pm-go implement` |

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

High-risk tasks/phases pause for explicit approval. `pm-go drive --approve all` (the default) auto-approves everything — fine for most agent-driven runs. `--approve interactive` prompts the operator. `--approve none` exits when an approval is needed; resume by approving and re-running drive.

When `pm-go implement` pauses for approval, it leaves the API + worker UP and prints the exact approval URL. Resolve the approval, then re-run `pm-go drive --plan <uuid>`.

## Common Failure Modes

- **Worker workflow stuck "scheduled but never picked up"** — almost always stale `dist/`. Run `pnpm -r build` from the pm-go repo, then restart the worker. `pm-go status` confirms task queue + namespace alignment.
- **Diff-scope violation** — the implementer wrote files outside the task's `fileScope`. Either widen the scope (requires a plan re-draft) or tighten the task description.
- **Content-filter rejection** — `agent_runs.error_reason="ContentFilterError"` and the task is `blocked`. Adjust the spec wording for the affected task and re-run.
- **Phase won't advance** — every task in the phase must be `ready_to_merge`. Find the laggards: `curl http://localhost:3001/plans/<id>` and look for tasks in `reviewing` / `fixing`.
- **Workflow-id collision on resume** — `drive` reports `WorkflowExecutionAlreadyStarted` after a supervisor restart. Run `pm-go recover --plan <id>` to attach to the existing audit/integration workflow instead of spawning a duplicate.

## API Surface (advanced)

`pm-go drive` orchestrates these for you. Use the raw API only when you need to override the default flow:

```bash
# Submit + plan (alternative to pm-go implement)
curl -X POST http://localhost:3001/spec-documents -H 'Content-Type: application/json' -d '{"content":"...","repoRoot":"/path","title":"..."}'
curl -X POST http://localhost:3001/plans         -H 'Content-Type: application/json' -d '{"specDocumentId":"<id>"}'

# Inspect
curl http://localhost:3001/plans/<id>
curl http://localhost:3001/tasks/<id>
curl http://localhost:3001/events            # SSE stream

# Manual transitions (drive does these automatically)
curl -X POST http://localhost:3001/tasks/<id>/run
curl -X POST http://localhost:3001/tasks/<id>/review
curl -X POST http://localhost:3001/tasks/<id>/fix
curl -X POST http://localhost:3001/phases/<id>/integrate
curl -X POST http://localhost:3001/phases/<id>/audit
curl -X POST http://localhost:3001/plans/<id>/complete
curl -X POST http://localhost:3001/plans/<id>/release
```

## Stub Mode (CI / fast smoke)

Set `--runtime stub` for fixture-driven runs that exercise the full pipeline without calling Claude:

```bash
pm-go implement --runtime stub --spec ./examples/golden-path/spec.md
```

Useful for smoke-testing pm-go itself, not for solving real specs. Stub fixtures live under `packages/sample-repos/` and `examples/`.

## Anti-Patterns

- **Don't pre-check `ANTHROPIC_API_KEY`.** OAuth alone is sufficient. Ask the supervisor instead — it prints which source it picked at boot.
- **Don't edit `packages/planner/src/*.ts` to swap models.** Use `PM_GO_MODEL` or per-role env vars.
- **Don't `pkill -f pm-go`** — it kills the operator's monitors too. Use `pm-go ps` to inspect the supervisor-owned process registry, then `pm-go stop` to shut them down cleanly. (Both commands target only pm-go's tracked PIDs, so editor and dev-server processes survive.)
- **Don't run two supervisors against the same Postgres + Temporal.** Port 3001 collides. `pm-go status` will tell you something is already on that port.

## Reference

- `examples/golden-path/` — full walkthrough of a stub-mode run
- `docs/getting-started.md` — manual API flow
- `docs/runbooks/` — operational recovery playbooks
- `packages/contracts/src/` — domain types (Plan, Task, AgentRun, ReviewReport)
- `artifacts/plans/` — generated plan Markdown after `SpecToPlanWorkflow` finishes
