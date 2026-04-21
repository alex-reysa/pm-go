# Phase 7 harness — matrix + chaos

The Phase 7 chaos/matrix harness proves two things:

1. The Phase 5 execution chain (planner → implementer → reviewer) survives
   four distinct TypeScript-repo shapes (the **matrix**).
2. The durable state machine correctly moves tasks to `blocked` (or stays
   in `running` for resume) under the three canonical failure classes the
   orchestrator has to tolerate in real operations (the **chaos** modes).

Both harness scripts are **stub-only**: they drive the stub executors
exported from `@pm-go/executor-claude` and never call the Anthropic API.
The full-stack assertion (budgets fire, approvals round-trip, traces
land) is Worker 4's `scripts/phase7-smoke.sh`.

## Matrix fixtures

Checked in under `packages/sample-repos/`:

| Fixture                 | Shape                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `single-package`        | Flat npm package, one `src/index.ts`                                   |
| `monorepo-workspaces`   | pnpm workspaces root + two workspace packages                          |
| `nested-packages`       | Outer package with a nested `lib/` sub-package (no workspaces)         |
| `ts-project-references` | Two packages wired through `references` in `tsconfig.json`             |

Each fixture carries its own `FIXTURE.md` describing what it exercises.
`scripts/phase7-matrix.sh` copies the fixture into a tmpdir, runs
`git init`, and drives the stub chain against it via
`scripts/lib/phase7-inprocess-smoke.ts`.

Run: `pnpm smoke:phase7-matrix`

## Failure modes

Failure injection is **env-var driven** — nothing in the real runners
changes. Modes live in new stub-only files:

- `packages/executor-claude/src/implementer-stub-failures.ts`
- `packages/executor-claude/src/reviewer-stub-failures.ts`

These are re-exported from `packages/executor-claude/src/index.ts` via an
append-only block. The chaos harness loads them directly, wraps the
existing stub runners, and observes durable effects (filesystem + state
machine) that the production runtime would persist.

### `IMPLEMENTER_STUB_FAILURE=merge_conflict`

What the stub does: writes a file whose contents collide with a
conflicting parallel commit on `main` that the harness commits first.
When the harness then asks the integration engine to fast-forward /
merge, `git merge` exits non-zero and the harness captures a conflict
summary equivalent to `{ status: "conflict", conflictedPaths: [...] }`.

Durable-state assertion: after retry exhaustion (the harness bounds this
at `IMPLEMENTER_STUB_FAILURE_RETRY_CAP=2`), the task record in the
harness's in-memory state machine flips to `status=blocked` with
`blockedReason=merge_conflict`. The harness asserts the task does NOT
silently advance past the conflict. In full-stack operation the
equivalent row is `plan_tasks.status='blocked'`; Worker 4 will assert
that directly from SQL.

### `REVIEWER_STUB_FAILURE=review_rejection`

What the stub does: the reviewer always returns `changes_requested` with
at least one `high`-severity finding, forcing fix-mode loops. The stub
does not vary by cycle number — every cycle fails the same way.

Durable-state assertion: after the fix-cycle cap
(`REVIEWER_STUB_FAILURE_CYCLE_CAP=2`) is exceeded, the task transitions
to `status=blocked` with `blockedReason=review_cycles_exceeded`. The
harness records a breadcrumb mimicking the `PolicyDecision` row that
Worker 4's integration will actually persist. Policy-engine itself is
Worker 1's code; our harness only proves the stub + cap-exhaustion
shape.

### `IMPLEMENTER_STUB_FAILURE=worker_kill`

What the stub does: writes a partial file, then exits the **sub-process**
with a non-zero code before committing, simulating a worker OOM or
SIGKILL mid-activity. The harness observes the non-zero exit, leaves
the task in `status=running`, then starts a fresh sub-process without
the failure env var set. On that second pass the stub completes
normally, writes the remaining file contents, commits, and the task
transitions to `ready_to_merge`.

Durable-state assertion: at the moment of the kill, the task is still
`running` (not `blocked`, not `failed`). After the restart the task
completes — i.e. the activity is replay-safe, which is the point of
Temporal. The harness ticks the same-shape state machine to prove this
without needing a Temporal worker running.

## Invocation pattern

```bash
# All four matrix fixtures.
pnpm smoke:phase7-matrix

# All three chaos modes sequentially.
pnpm smoke:phase7-chaos

# Single chaos mode (dev loop):
PHASE7_CHAOS_ONLY=merge_conflict bash scripts/phase7-chaos.sh
```

The harness scripts source `scripts/lib/phase7-harness.sh` for the
fixture list and the two tsx entry points
(`phase7-inprocess-smoke.ts`, `phase7-inprocess-chaos.ts`). The env-var
activation contract is stable — Worker 4 (integration) can call the
exported functions from `@pm-go/executor-claude` directly once the
policy engine lands:

```ts
import {
  wrapImplementerRunnerWithFailureMode,
  wrapReviewerRunnerWithFailureMode,
} from "@pm-go/executor-claude";

const impl = wrapImplementerRunnerWithFailureMode(
  createStubImplementerRunner(opts),
  process.env.IMPLEMENTER_STUB_FAILURE,
);
```

The wrapper is a no-op when the env var is unset, so production call
sites that import the wrapper are safe in non-chaos builds.
