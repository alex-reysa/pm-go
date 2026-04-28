# Session analysis: Plan B recovery, local runtime conflicts, and release handoff

*Written 2026-04-27, expanded same day. Source material: the AXON Plan B provider-search transcript through recovery **and** the follow-on release work (PRs, endpoint and test wiring, dependency gating, handoff to a fresh AXON session). The first part analyzes operational failure modes while driving Plan B through pm-go; the second records what shipped and what must happen before merge.*

## Executive summary

Plan B was recoverable, but the session shows that pm-go still asks the operator and agent to act as infrastructure SREs too often. The run made real progress: Phase 0 completed, Phase 1 integrated, the MCP/CLI task was salvaged after a bad `node_modules` commit, and the Phase 1 audit eventually completed. But each recovery step required direct Docker, Temporal, Postgres, process, and git manipulation instead of a single pm-go-controlled workflow.

The most important product gap is not model quality. It is lifecycle ownership. pm-go should own ports, containers, worker/API processes, plan state, task retries, audit collisions, and local-project interference through CLI commands such as `pm-go status`, `pm-go recover`, `pm-go resume`, and `pm-go ps`.

After infra recovered, the run progressed to **open PRs** in two repositories (x402all “Plan A” and AXON “Plan B”) with a clear **publish-before-merge** gate for a shared npm package. The [Plan A and Plan B shipping](#plan-a-and-plan-b-shipping-cross-repo-prs-and-merge-order) section below captures URLs, commit references, and operator checklist for anyone continuing in the AXON tree.

## What happened

| Area | Observed behavior | Impact |
|---|---|---|
| Docker | Docker daemon hung during/after local project startup and required manual Docker Desktop restart. | pm-go API, worker, and drive loop died or stalled. |
| Port ownership | pm-go and x402all both attempted to use host Postgres on `5432`. | pm-go Postgres connection dropped, API crashed, phase audit stalled. |
| Process lifecycle | Supervisor/API/worker were down while Temporal workflows remained in-flight. | Recovery required manual process and workflow inspection. |
| Temporal | Phase audit workflow survived but `drive` retried into a workflow-id collision. | Agent had to wait for the existing audit, then re-drive. |
| Runtime limits | MCP+CLI implementer hit the 60-turn cap. | Agent patched planner defaults to 120 turns mid-run and rebuilt. |
| Artifact hygiene | Implementer committed `node_modules` as symlinks. | Task became blocked and required manual branch/worktree cleanup. |
| Shell robustness | Paths with spaces broke manual recovery commands. | First cleanup attempt failed when an unquoted path containing a space (e.g. `<workspace>/999. PROJECTS/...`) was word-split. |
| Status visibility | User repeatedly had to ask whether things were "on track." | pm-go did not provide a clear single source of truth. |

## Timeline

1. Plan B was being driven through pm-go after Plan A had already released and pushed.
2. Phase 0 completed. Phase 1 reached the MCP+CLI task.
3. The MCP+CLI implementer hit the 60-turn cap. The agent raised the default implementer cap to 120 turns and rebuilt `@pm-go/planner`.
4. Drive resumed. The MCP+CLI task later became `blocked` because `node_modules` was committed as symlink entries.
5. The agent manually inspected the agent branch and worktree, removed the `node_modules` symlinks, committed the cleanup, flipped the task to `ready_to_merge`, and re-drove.
6. Phase 1 integrated and entered audit.
7. The user started local x402all (`start.sh`) while pm-go was mid-flight. That local stack also wanted Postgres port `5432`.
8. pm-go API lost its Postgres connection and stopped responding on `:3001`. Docker commands started hanging.
9. Docker Desktop was restarted manually. pm-go containers did not auto-start after Docker came back.
10. The agent restarted pm-go infra and supervisor, confirmed DB state was intact, and resumed drive.
11. Drive crashed on a phase-audit workflow-id collision because the audit was already running. The agent waited for the existing audit to finish.
12. The user noticed another local stack (`gluerun-local`) and asked whether it conflicted. It did not: that stack used `543xx` ports, while pm-go used `5432`, `7233`, `8233`, and `3001`.
13. Phase 1 audit completed but left the phase `blocked`, requiring further diagnosis.

## Findings

### F1. pm-go does not fully own its local infrastructure

pm-go depends on Docker, Postgres, Temporal, worker, API, and a drive process. In this session, the operator had to reason about all of them separately. When Docker wedged, there was no pm-go command that could say:

- Docker daemon is unavailable.
- pm-go containers are down.
- API and worker are down.
- Temporal still has workflow X running.
- Last durable plan state is Phase 1 audit.
- Safe next command is Y.

Suggested changes:

- Add `pm-go status` as the primary health command for API, worker, Docker, Postgres, Temporal, open workflows, and drive processes.
- Add `pm-go recover --plan <id>` to restart infra, attach to existing workflows, and print the next safe action.
- Add `pm-go ps` to show only pm-go-owned processes and their PIDs.
- Record supervisor child PIDs in a run registry so shutdown/recovery does not rely on broad process matching.

### F2. Port collisions with target repos are too easy

The user ran x402all locally while pm-go was using host Postgres on `5432`. That collided with x402all's local startup path and destabilized Docker/Postgres. gluerun-local was not a conflict because it used `543xx`, but the user had no easy way to know that from pm-go.

Suggested changes:

- Let pm-go choose non-default host ports by default, or reserve a documented range, for example:
  - Postgres: `15432`
  - Temporal: `17233`
  - Temporal UI: `18233`
  - API: `13001`
- Add `pm-go doctor ports` or include port ownership in `pm-go status`.
- Detect target-repo startup scripts that likely bind the same ports before launching long pm-go runs.
- Support `pm-go run --port-profile isolated` to avoid common app ports.

### F3. Docker Desktop failure mode is outside pm-go's control, but not outside pm-go's UX

Docker daemon commands hung or failed while Docker.app appeared partly launched. The agent had to use `open`, `osascript`, `docker info`, `docker ps`, and manual user confirmation.

Suggested changes:

- Teach `pm-go doctor --repair` to distinguish:
  - Docker Desktop app not running.
  - App running but daemon socket unavailable.
  - Daemon available but compose project stopped.
  - Containers running but unhealthy.
- When daemon socket is unavailable for more than a threshold, print a precise manual instruction and pause instead of launching many hanging probes.
- Use short timeouts for Docker probes so one hung Docker command does not stall the whole session.

### F4. Temporal workflow recovery is too manual

The phase audit was still running when drive was restarted. A later drive attempt collided on the workflow id, so the agent had to inspect Temporal directly and wait for the existing audit.

Suggested changes:

- Make phase audit and completion audit start idempotent:
  - If workflow already exists and is running, attach/wait instead of failing.
  - If workflow exists and completed, read its result and advance.
  - If workflow exists and failed, surface the failure and offer retry.
- Add a durable `workflow_runs` table or extend existing records with Temporal workflow IDs/run IDs for every plan, task, phase audit, completion audit, and release.
- Add `pm-go workflow status --plan <id>` and `pm-go workflow wait --id <workflow-id>`.

### F5. Drive loop should survive API downtime better

Drive timed out waiting for Phase 1 audit while the API was down for part of the time. Once the API returned, the state was recoverable, but drive did not clearly distinguish "audit still running" from "API unavailable" from "workflow collision."

Suggested changes:

- Drive should classify wait failures:
  - API unavailable.
  - Worker unavailable.
  - Workflow running.
  - Workflow completed but DB not projected.
  - Workflow failed.
- Drive should persist its own run state so `pm-go drive --plan <id>` can continue without operator memory.
- Drive should not treat transient API outages during long audits as terminal without checking Temporal state.

### F6. Runtime budget/turn limits were changed by editing source

The MCP+CLI task exceeded the implementer 60-turn cap. The agent changed the default in `packages/planner/src/implementer.ts` to 120 and rebuilt. That was effective, but it is the wrong operator surface.

Suggested changes:

- Move all role caps to supported config:
  - `IMPLEMENTER_MAX_TURNS`
  - `IMPLEMENTER_BUDGET_USD`
  - `REVIEWER_MAX_TURNS`
  - `PHASE_AUDITOR_MAX_TURNS`
  - shared defaults via `PM_GO_MAX_TURNS` and `PM_GO_BUDGET_USD`
- Make the active caps visible in the worker startup banner and `pm-go status`.
- Let `pm-go drive --retry-task <id> --max-turns 120 --budget-usd 15` override a single retry without rebuilding.
- Teach planner to assign size-based caps for tasks: small, medium, large, extra-large.

### F7. Agent output hygiene failed on `node_modules`

The implementer committed `node_modules` symlink entries. pm-go blocked the task, which is good, but cleanup required manual branch discovery, manual worktree path discovery, manual git surgery, and direct DB/task flipping.

Suggested changes:

- Add a hard pre-commit guard in worktrees that rejects:
  - `node_modules`
  - `.venv`
  - build artifacts
  - large binary files
  - common cache directories
- Add `pm-go task repair --task <id> --remove-ignored-artifacts` to automatically remove ignored artifacts and re-run diff-scope.
- Add repo-level ignore policy to the planner prompt and implementer policy bridge.
- Never require DB updates to move a repaired task; provide an API/CLI transition with audit reason.

### F8. Direct DB state mutation remains a recurring escape hatch

The transcript includes "flipping task to ready_to_merge" after manual cleanup. That might have been correct in context, but the mechanism should be auditable and typed, not an ad hoc DB update.

Suggested changes:

- Add `pm-go task override --task <id> --status ready_to_merge --reason <text>`.
- Add `pm-go phase override --phase <id> --status completed --reason <text>`.
- Persist override actor, reason, timestamp, previous state, and linked evidence.
- Surface overrides in final release notes and completion audit.

### F9. Shell commands were fragile around paths with spaces

Manual recovery failed when a worktree path under a directory whose name contains a space (e.g. `<workspace>/999. PROJECTS/...`) was word-split by the shell. This has happened in multiple sessions.

Suggested changes:

- Avoid shell-string APIs inside pm-go for paths; use structured process args everywhere.
- Ensure generated recovery commands quote paths with spaces.
- Add tests with repo roots containing spaces.
- Add `pm-go task worktree --task <id>` to print a machine-safe JSON object, not shell fragments.

### F10. User-facing status was insufficient

The user repeatedly asked "status?", "all good?", and "are containers interfering?" The agent answered by running many low-level checks. pm-go should answer this itself.

Suggested changes:

- `pm-go status` should output:
  - active plan IDs and titles
  - current phase/task statuses
  - active agent run role/model/elapsed time
  - worker/API health
  - Docker/port ownership
  - open Temporal workflows
  - whether it is safe to run the target app locally
- Add `pm-go conflicts --repo <path>` to detect port/container conflicts with a target repo's known dev stack.
- Add `pm-go logs --plan <id>` to tail the relevant supervisor, worker, API, and drive logs together.

## Reliability improvements by priority

### P0: Stop making operators recover by hand

- Implement `pm-go status`.
- Implement `pm-go recover --plan <id>`.
- Make `drive` attach to existing audit workflows instead of colliding.
- Add a pm-go-owned process registry and scoped shutdown.

### P1: Prevent environment conflicts

- Move pm-go dev infra off common host ports or support isolated port profiles.
- Detect port conflicts before run/drive.
- Add Docker probe timeouts.
- Document whether target repo dev servers can run concurrently.

### P2: Make task retries configurable without code edits

- Add env/CLI support for per-role model, budget, and turn caps.
- Show active runtime/caps in `pm-go status`.
- Support retrying one task with adjusted caps.

### P3: Improve artifact and scope safety

- Hard-block `node_modules` and common generated artifacts before commit.
- Add repair commands for blocked tasks.
- Replace manual DB flips with auditable override endpoints.

### P4: Improve docs and operator runbooks

- Add runbooks for:
  - Docker daemon wedged.
  - API down but Temporal workflow running.
  - Audit workflow ID collision.
  - Target repo port conflict.
  - Blocked task due to committed ignored artifacts.

## Proposed CLI shape

```bash
pm-go status
pm-go status --plan 7f3a1d2c-5b8e-4c91-a8f4-2e6d9b0c1f3a

pm-go recover --plan 7f3a1d2c-5b8e-4c91-a8f4-2e6d9b0c1f3a
pm-go drive --plan 7f3a1d2c-5b8e-4c91-a8f4-2e6d9b0c1f3a --attach-existing

pm-go task retry 7a8b9c0d-1e2f-4345-8678-6e7f8091a2b3 \
  --max-turns 120 \
  --budget-usd 15

pm-go task repair 7a8b9c0d-1e2f-4345-8678-6e7f8091a2b3 \
  --remove-ignored-artifacts

pm-go conflicts --repo "<path-to-other-repo>"
pm-go logs --plan 7f3a1d2c-5b8e-4c91-a8f4-2e6d9b0c1f3a
```

## What worked

- Durable state preserved the plan across Docker crashes and supervisor restarts.
- The task/phase state machine made it possible to identify the last known good state.
- The phase audit continued independently enough that waiting for the existing workflow was viable.
- Diff/scope checks caught an important artifact hygiene issue (`node_modules`).
- After Docker recovered, the agent could restart pm-go and continue from the persisted DB state.

## What should be considered unacceptable in future runs

- Editing source defaults to change runtime caps during an active run.
- Manual DB state updates to unblock tasks/phases.
- Broad process killing.
- Raw Temporal CLI as the normal recovery path.
- Running target repo dev stacks on the same ports as pm-go without a conflict warning.
- Agent-authored shell snippets that break on paths with spaces.

## Plan A and Plan B shipping: cross-repo PRs and merge order

Work split across **x402all** (contract package + Plan A) and **AXON** (wallet-aware provider search + Plan B). The transcript treated them as a single delivery with an explicit sequence constraint.

| Repo | PR | Branch | Notes |
|------|-----|--------|--------|
| x402all (Plan A) | [alex-reysa/x402all#1](https://github.com/alex-reysa/x402all/pull/1) | `plan-a-complete` | Publishes the contracts package from this branch; merge **first** in the happy path. |
| AXON (Plan B) | [alex-reysa/AXON#36](https://github.com/alex-reysa/AXON/pull/36) | `plan-b-complete` | Large Plan B feature set; depends on contracts being resolvable from npm. |

`gh pr create` reported uncommitted changes in the working tree at PR creation time for one or both PRs; anyone landing these should confirm a clean `git status` and no stray artifacts before re-running or amending.

### Merge and publish sequence (do not skip)

1. **Merge Plan A** ([x402all#1](https://github.com/alex-reysa/x402all/pull/1)) so the canonical `@x402all/provider-search-contracts` source is on the intended mainline branch.
2. **Publish** `@x402all/provider-search-contracts@0.1.0` (or the version you align on) to the npm registry from the Plan A tree. Package path in the transcript: `x402all/packages/provider-search-contracts/`.
3. **Only then** in AXON, **promote** the dependency from `optionalDependencies` to `dependencies` in the root `package.json`, run `npm install`, commit `package.json` and lockfile, and push to `plan-b-complete` (or main after merge) so install fails loudly if the package is missing, matching runtime imports.

Rationale: moving the package to `dependencies` before it exists on the registry made `npm install` fail with **E404** for the scoped package. Keeping it optional avoided broken installs in that window but also risks **silent non-install** of a logical hard dependency. The transcript’s resolution: optional until published, then promote; document the gate in the PR body.

## AXON follow-up commit: endpoint alignment, UI routes, test wiring

A **follow-up commit** (referenced in the transcript as `81e286b` on `plan-b-complete`) addressed small but PR-blocking inconsistencies:

### HTTP path: `/v1/providers/search` → `/v1/provider-search`

The Decision API and clients were aligned on **`POST /v1/provider-search`**. Files touched in the session included:

- `axon-cli-operator/src/commands/providers/search.ts` (dispatch path and docstring)
- `axon-cli-operator/tests/commands/providers-search.test.ts` (expected URL)
- `axon-402-mcp/src/mcp-tools/provider-search/search.ts` (MCP `search_x402_services` dispatch and docstring)
- `axon-402-mcp/tests/mcp-tools/provider-search.test.ts` (asserted URL)

### Platform router: `FindServices` and `UseService`

Dashboard routes were mounted in **`platform/App.tsx`**, with imports from `./src/pages/FindServices` and `./src/pages/UseService`:

- `/find-services` → `<FindServices variant="find" />` inside `RequireAuth` + `DashboardLayout`
- `/use-service` → `<UseService />` same layout

### `axon-402-mcp` tests: seven files added to the harness

The new tests were registered in two places in the session:

- **`vitest.config.ts`**: `include` gained seven paths, for example `tests/eval/provider-search.test.ts`, `tests/mcp-tools/no-local-ranking.test.ts`, `tests/mcp-tools/provider-search.test.ts`, `tests/routes/provider-search.test.ts`, `tests/services/feedback-privacy.test.ts`, `tests/services/provider-search-service.test.ts`, `tests/workers/feedback-publisher.test.ts`.
- **`package.json` `test` script**: the same files were also appended to the long explicit `tsx --test …` file list so `npm test` runs them.

**Maintainability note:** duplicating the file list in both Vitest and a long shell `tsx --test` list is error-prone; a follow-up in AXON or pm-go conventions might consolidate (glob, or one runner).

### Typecheck and verification

The transcript ran `npx tsc --noEmit` under `axon-402-mcp` and saw **pre-existing** errors (e.g. missing type definition files for libraries such as `cors` / `mime` / `uuid` — exact set may differ by branch). That was not attributed to the provider-search edits. A commit in the log used `git commit --no-verify` to land the follow-up despite hooks; for merge hygiene, rerun checks with hooks enabled once the repo’s baseline is clean.

## Optional pm-go and orchestration notes from the same transcript

The extended session mentioned several items; treat as **context for pm-go** unless independently verified in this repo:

- **Override-bypassed task reviews** with rationale stored in Postgres (e.g. `policy_decisions`); final release/audit artifacts should be consulted for the authoritative record.
- **Completion audit** completed via a **manual** pass when a structured-output validation path failed several times; not necessarily a product bug in AXON, but a signal that audit tooling and model output need tighter alignment.
- A **reported** worker behavior: honoring a **global** `--repo` (or similar) in a way that could diverge from per-plan `repoSnapshot.repoRoot` in multi-repo work — if still present, it increases risk of the wrong target repo. Worth a product issue with repro against pm-go.

**Worktree noise:** the transcript noted pm-go (or editor) worktree directories under the AXON path that are not part of the shipped tree. Operators can `git worktree prune` and remove stale agent directories when safe, after confirming nothing uncommitted lives only there.

## Handoff: working inside AXON for merge and cleanup

Paste this checklist into a new session in the AXON working copy:

1. **Branch state:** you may be on `plan-b-complete` rather than `main`; `git switch main` or stay on the PR branch as needed.
2. **Stash:** stashes like `pre-plan-b-merge` / `pre-plan-a-merge` may exist; review with `git stash list` and pop when appropriate.
3. **Stale worktree dirs:** e.g. `.worktrees/<uuid>/` (names vary); prune and delete after confirming they are not needed.
4. **Before merge of AXON#36:** complete Plan A merge, publish `provider-search-contracts`, promote dependency in root `package.json`, reinstall, commit lockfile, push.
5. **Migrations and smoke test:** apply `platform/supabase/migrations/20260427_provider_search.sql` (or current filename on branch) in the target environment; exercise `axon-op providers search` and the new dashboard routes.
6. **CI:** ensure `npm test` / `npm test -w axon-402-mcp` and Vitest pick up the new tests; fix any failures that are not pre-existing.
7. **Backlog:** optional issue for `@types/*` gaps and for consolidating the duplicated `tsx --test` test list.

**Useful references from the session:** plan id `7f3a1d2c-5b8e-4c91-a8f4-2e6d9b0c1f3a`; follow-up commit `81e286b` on `plan-b-complete`.

## pm-go product gaps suggested by the release phase

In addition to recovery lifecycle ownership (above), the release segment suggests:

- **Sequenced multi-repo handoff** in the UI or CLI: “Plan A PR merged + package published + AXON dep promoted” as a check before marking Plan B releasable.
- **First-class contract publishing** as a documented step (version bump, registry, and verification), not only ad hoc `gh` and npm.
- **Less manual duplication** of test file lists and fewer opportunities for an implementer to wire Vitest but miss `npm test` or vice versa.

## Bottom line

pm-go proved its core durability thesis again: the work was not lost. But it also showed that recovery is still too dependent on an expert operator. The next reliability push should focus on turning the manual recovery transcript into first-class CLI behavior. The ideal future session should not contain `docker exec`, `tctl`, raw SQL, `lsof`, `pgrep`, or manual git surgery except as debugging tools; `pm-go status`, `pm-go recover`, `pm-go task repair`, and `pm-go drive --attach-existing` should cover the normal path.

Once recovery is over, **cross-repo release hygiene** (merge order, npm publish, dependency promotion, router and URL consistency, and a single test harness source of truth) is just as important for “done” as green workflows. The AXON Plan B thread closed with two open PRs and a **publish gating** step that pm-go can eventually encode as a first-class checklist, not a PR comment and operator memory.
