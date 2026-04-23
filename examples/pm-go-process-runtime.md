# pm-go v0.8.0: Process-based runtime adapters + `doctor`

## Objective

Let pm-go drive any locally-authenticated LLM CLI — Claude Code, Codex, Gemini — through its existing planner / implementer / reviewer / auditor pipeline, without requiring a separate funded `ANTHROPIC_API_KEY` or duplicating auth setup. Inspired by PwnKit's process-runtime pattern: **let each vendor's CLI handle its own auth and subscription state; pm-go just spawns the CLI, streams JSON, and maps the output back to its existing contracts.**

Today (v0.7.x) the only supported executor is `@anthropic-ai/claude-agent-sdk`, which — after the OAuth fallthrough fix — works for Claude Code subscription users but leaves Codex and Gemini users with no path to run pm-go on their codebases.

## Motivation (why this ships in v0.8.0)

1. **Adoption gate.** The PwnKit product pattern (`--runtime auto`, then `claude | codex | gemini`) is what made PwnKit accessible; pm-go needs the same surface area to pick up users who've already spent time configuring one of the non-Anthropic CLIs.
2. **No Docker, no separate key.** A user with `claude login` / `codex login` / `gemini` already authenticated should be able to `pnpm pm-go plan <spec>` and have it work. Today they still need an Anthropic API key to even smoke the system.
3. **Observability.** A `pm-go doctor` command that prints what's installed, what's authenticated, and which runtime `--runtime auto` would pick eliminates the most common "why isn't it working?" support loop.

## Scope — in

### 1. Runtime detector

A new package `packages/runtime-detector` (or a module under `packages/executor-claude` if splitting is too disruptive) that exposes:

```ts
interface RuntimeAdapter {
  name: "claude" | "codex" | "gemini";
  cliCommand: string;                       // "claude", "codex", "gemini"
  detectAvailable(): Promise<boolean>;      // runs `<cmd> --version`
  detectVersion(): Promise<string | null>;  // semver-or-null
  capabilities: {
    streamJson: boolean;
    structuredOutput: boolean;              // native --json-schema support?
    mcpTools: boolean;                      // can accept an MCP server?
  };
}

function detectAvailableRuntimes(): Promise<Array<{adapter: RuntimeAdapter; version: string}>>;
```

Results are cached in-process for 60 s so `pm-go doctor` followed by `pnpm start:worker` doesn't re-shell three CLIs.

### 2. `pm-go doctor` CLI

Add a `doctor` subcommand to the existing CLI surface (`apps/tui` entrypoint, or a new `apps/cli`). Output:

```
pm-go doctor
============

Environment:
  ANTHROPIC_API_KEY    set (unused under OAuth)
  OPENROUTER_API_KEY   not set
  OPENAI_API_KEY       not set

Local CLIs:
  claude   2.x.y ✓
  codex    not found
  gemini   0.x.y ✓

Runtime resolution:
  --runtime auto  → claude (CLI)
  Override per role with PLANNER_RUNTIME=codex etc.

Infrastructure:
  Temporal  localhost:7233 ✓
  Postgres  localhost:5432 ✓
```

Exits non-zero if NO runtime is available (no env key AND no installed CLI).

### 3. `ProcessRuntime` executor

A new executor-adjacent package `packages/executor-process` that implements the existing runner interfaces (`PlannerRunner`, `ImplementerRunner`, `ReviewerRunner`, `PhaseAuditorRunner`, `CompletionAuditorRunner`) but delegates the model call to a spawned CLI instead of the Claude Agent SDK.

Per-runtime command shape (approximate, confirm at implementation time):

```
claude:   claude -p "<prompt>" --verbose --output-format stream-json --json-schema <file>
codex:    codex exec --full-auto --skip-git-repo-check --json -c schema=<file> "<prompt>"
gemini:   gemini -p "<prompt>" --output-format stream-json
```

The runtime adapter must translate the streamed JSONL into the same `SDKMessage`-shaped events the existing runners consume so the accumulator loop (token counts, cost, stop reason, structured output capture) stays byte-identical across runtimes.

### 4. Claude CLI adapter (first concrete implementation)

Ship the claude adapter in this release because (a) it reuses the most code paths we already debug today and (b) it's the strict MVP — if the `ProcessRuntime` scaffolding only covers the claude CLI, the release is still unblocking.

**Explicit non-goal for v0.8.0:** MCP server for `canUseTool` gate enforcement. The claude CLI supports MCP, and PwnKit passes an MCP server back to itself, but wiring that through pm-go's scope / diff-scope invariants needs design work. For v0.8.0 we accept that `ProcessRuntime` runs without per-tool gates; pm-go's post-commit `diffWorktreeAgainstScope` still catches any write violations. The `canUseTool` gap is a tracked risk (see below), NOT a silent regression.

### 5. Factory wiring

`apps/worker/src/index.ts` picks between `createClaudeSdkRunner(...)` and `createProcessRunner({ cli, ... })` per role, driven by env vars:

```
PLANNER_RUNTIME=sdk|claude|codex|gemini    (default: auto)
IMPLEMENTER_RUNTIME=...
REVIEWER_RUNTIME=...
PHASE_AUDITOR_RUNTIME=...
COMPLETION_AUDITOR_RUNTIME=...
```

`auto` resolution order:
1. If the role's `*_MODEL` env is set and an API key is present → `sdk` runtime with that model.
2. Else if `claude --version` succeeds → `claude` CLI runtime.
3. Else `codex` → `gemini` — in that preference order.
4. Else throw at worker boot with an actionable error that quotes the `pm-go doctor` output.

### 6. Docs update

- `README.md` — update the Quick Start to say "you need a Claude Code subscription OR an API key — `pm-go doctor` will tell you which"
- `docs/runtimes.md` (new) — explain the runtime model, per-role overrides, the MCP gap on process runtimes, when to prefer SDK vs. CLI

## Scope — out (defer to v0.9.0)

- **Codex adapter.** The command shape is known (`codex exec --json`) but the stream-json format differs enough that a proper mapper deserves its own plan cycle.
- **Gemini adapter.** Same reasoning as codex. Also: gemini lacks native structured-output flags, so the mapper needs to prompt-engineer JSON extraction, which is its own reliability investigation.
- **MCP bridge for `canUseTool` on process runtimes.** See §4 above. Tracked as a known gap, not shipped in v0.8.0.
- **Telemetry / span attribution per runtime.** Existing spans stay; adding `runtime.name` as a span attribute is small and can go in v0.8.1.
- **TUI runtime selector.** Env vars only for v0.8.0. A TUI picker is polish.

## Constraints

- **No contract changes.** `AgentRun`, `Plan`, `ReviewReport`, `PhaseAuditReport`, `CompletionAuditReport` schemas must not change. Every runtime maps its output to these existing shapes.
- **No control-plane changes.** Postgres schema, Temporal workflow definitions, diff-scope enforcement — all untouched. The process runtime is a leaf-level swap inside the activity.
- **No new runtime dependencies on the hot path.** `ProcessRuntime` shells out with `node:child_process`, parses JSONL with the stdlib; avoid pulling in a general-purpose process wrapper.
- **Preserve today's OAuth fallthrough.** SDK-backed runners must still work for users on Claude Code subscription. The factory defaults to SDK when an Anthropic credential is present.

## Acceptance criteria

1. `pnpm pm-go doctor` runs to completion in under 1 s on a machine with all three CLIs installed, prints a table matching the format in §2, and exits 0.
2. On a machine with **no** Anthropic credentials but **with** `claude` CLI authenticated, a fresh `pnpm smoke:phase7-matrix` run passes end-to-end with `PLANNER_RUNTIME=claude IMPLEMENTER_RUNTIME=claude REVIEWER_RUNTIME=claude PHASE_AUDITOR_RUNTIME=claude COMPLETION_AUDITOR_RUNTIME=claude`.
3. With env `PLANNER_RUNTIME=sdk` and no Anthropic credentials, worker boot fails with an error message that quotes `pm-go doctor`'s output so the user sees exactly what's missing.
4. The existing full test suite passes unchanged (`pnpm typecheck && pnpm test`).
5. `pm-go doctor` prints the correct `--runtime auto` resolution for at least three environment permutations, exercised by unit tests.
6. A new integration test in `apps/worker` exercises the `ProcessRuntime` end-to-end against a mocked `claude` binary (fixtures in `packages/sample-repos`), asserting the same `AgentRun` output shape as the SDK runner produces for the same prompt.
7. `docs/runtimes.md` exists, names the MCP gap explicitly, and is linked from the README.

## Repo hints

Relevant entry points for the planner:

- `packages/executor-claude/src/` — existing SDK-backed runners. The new package mirrors this layout.
- `apps/worker/src/index.ts` — runner factory lives here; look at how `PLANNER_EXECUTOR_MODE` already switches between `live` (SDK) and `stub` today.
- `packages/executor-claude/src/planner-runner.ts` — the minimal runner contract. Copy its message-accumulator loop as the template for `ProcessRuntime`.
- `packages/executor-claude/src/errors.ts` — `classifyExecutorError`, `CONTENT_FILTER_ERROR_NAME`. Process runtime errors should go through the same classifier.
- `packages/contracts/src/` — `PlanSchema`, `ReviewReportJsonSchema`, etc. These feed the `--json-schema` flag on the claude CLI.
- `docs/` — add `runtimes.md` here; existing docs are the style template.
- No changes to `packages/db`, `packages/temporal-workflows`, or any activity in `apps/worker/src/activities/` except the thin runner-factory wiring.

## Risks

- **Stream-JSON drift.** Each CLI's `stream-json` format is a moving target between CLI versions. Pin tested versions in `pm-go doctor` output and fail loud on unknown message types rather than silently dropping them.
- **MCP gap on process runtime.** Documented above. Mitigation: keep SDK runtime as the default for high-risk implementer work until the MCP bridge lands in v0.9.0. README should name this in the runtime selection guidance.
- **Cost explosion from accidental live runs.** CLI runtimes don't surface cost back to pm-go as reliably as the SDK does. Add per-role budget caps (already present for reviewer/auditor) that kill the child process on threshold exceedance.
- **Canary CLIs (`claude` on an unsupported OS, `codex` on Linux before its public GA) can hang on stdin.** Set a startup timeout on every CLI spawn and fall through to the next adapter in `auto` mode.
