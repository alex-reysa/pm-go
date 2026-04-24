# Runtimes

This document covers the executor-process architecture used by pm-go agents,
how per-role environment variables control runtime selection, the role of the
policy MCP bridge, and guidance on when to choose the SDK path versus the CLI
path.

---

## Runtime Model and Executor-Process Architecture

Each agent role (planner, implementer, reviewer, phase-auditor,
completion-auditor) is backed by an **executor**. An executor is a typed
boundary object that receives a task prompt plus a structured permission set
and returns a structured result. At boot time the worker resolves the executor
implementation for every role independently.

There are three runtime flavours:

| Flavour | How it runs Claude | Typical use |
|---|---|---|
| `stub` | Returns hardcoded fixture data immediately. No model call, no API key. | CI, unit tests, fast local iteration. |
| `sdk` | Calls the Anthropic Agent SDK in-process (Node.js child thread). | Production — lowest latency, structured tool-call loop, native budget tracking. |
| `claude` | Forks the `claude` CLI binary as a subprocess; parses its JSONL stream output. | Integration tests with a real model binary; useful when you want the full Claude-Code CLI surface without the SDK. |

The `claude` flavour is called the **process-runtime** path. When
`*_RUNTIME=claude` the executor forks `claude` from `PATH`, feeds it the
prompt on stdin, and collects stream-json JSONL lines until the subprocess
exits. The executor then maps the JSONL records to the same `AgentResult`
shape that the SDK path emits, so the rest of the worker is runtime-agnostic.

---

## Per-Role Environment Variable Overrides

Every role has a dedicated `*_RUNTIME` env var. The worker reads these at
startup; changing them after the process has launched has no effect.

| Role | Env var | Default |
|---|---|---|
| Planner | `PLANNER_RUNTIME` | `stub` |
| Implementer | `IMPLEMENTER_RUNTIME` | `stub` |
| Reviewer | `REVIEWER_RUNTIME` | `stub` |
| Phase auditor | `PHASE_AUDITOR_RUNTIME` | `stub` |
| Completion auditor | `COMPLETION_AUDITOR_RUNTIME` | `stub` |

Valid values are `stub`, `sdk`, `claude`, and `auto`.

### `auto` resolution order

When a role is set to `auto` the worker selects the best available runtime
using the following waterfall:

1. **`sdk`** — if `ANTHROPIC_API_KEY` is set and non-empty, the SDK path is
   chosen. This is the recommended production default.
2. **`claude`** — if `ANTHROPIC_API_KEY` is absent but `claude` resolves on
   `PATH`, the CLI-process path is chosen. Useful for environments where the
   Claude Desktop app provides the binary.
3. **`stub`** — fallback when neither of the above is available. Emits a
   warning log line at startup so the behaviour is discoverable.

### Example: full live stack

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export PLANNER_RUNTIME=sdk
export IMPLEMENTER_RUNTIME=sdk
export REVIEWER_RUNTIME=sdk
export PHASE_AUDITOR_RUNTIME=sdk
export COMPLETION_AUDITOR_RUNTIME=sdk
pnpm start:worker
```

### Example: process-runtime smoke (no API key)

```bash
export PLANNER_RUNTIME=claude
export IMPLEMENTER_RUNTIME=claude
export REVIEWER_RUNTIME=claude
export PHASE_AUDITOR_RUNTIME=claude
export COMPLETION_AUDITOR_RUNTIME=claude
pnpm start:worker
```

---

## Policy MCP Bridge

The **policy MCP bridge** is a lightweight Model Context Protocol server that
the executor injects as a tool host whenever the runtime is `sdk` or `claude`.
Its job is to intercept every tool-call the agent attempts and apply the
role-scoped permission policy before the call reaches the real tool
implementation.

### Why it exists

Claude agents in both SDK and CLI modes can call arbitrary tools. Without a
policy layer, a reviewer agent could call `write_file`, an implementer could
call `bash` with no restrictions, and so on. Rather than patching every call
site, the bridge sits at the MCP protocol boundary and:

1. Accepts the agent's tool-call request.
2. Looks up the role's `PermissionSet` from the current task contract.
3. Decides `allow` or `deny`; for `deny` it returns an MCP error response
   and writes a `policy_decisions` row to Postgres so the denial is auditable.
4. Forwards `allow` calls to the downstream tool implementation unchanged.

### Trust-boundary preservation

The bridge is intentionally transparent to downstream tools: it does not
re-sign, re-wrap, or mutate the tool arguments on the allow path. This
preserves the existing trust boundary — the downstream implementation receives
exactly what the agent sent, so its own validation and sandboxing remain
authoritative. The bridge only adds a **pre-flight denial layer**; it does not
substitute for tool-level security.

Consequently, a `policy_decisions` row with `decision='denied'` records that
the agent attempted a forbidden tool call. A row with `decision='allowed'` is
not written (to keep the table focused on audit-significant events). The
`policy_decisions` table therefore represents the complete set of
**policy-enforcement events**, not a full call log.

---

## SDK vs. CLI: When to Prefer Which

### Prefer `sdk`

- **Production deployments.** The SDK path is fully supported, provides
  structured budget tracking (`cost_usd`, `prompt_tokens`, `completion_tokens`)
  returned from every run, and supports multi-turn tool-use loops natively.
- **When cost reporting matters.** The CLI path does not currently return a
  cost figure; `agent_runs.cost_usd` will be `null` for process-runtime runs
  (see Known Limitations).
- **When you need deterministic stop reasons.** The SDK path maps stop reasons
  (`max_tokens`, `end_turn`, `tool_use`, `budget_exceeded`) to the
  `AgentResult.stopReason` field. The CLI path infers stop reasons from JSONL
  record types, which is less reliable.

### Prefer `claude` (process-runtime)

- **Integration testing with the real CLI binary.** If you want to exercise
  the full Claude Code CLI surface (custom permissions file, file-scope
  enforcement, MCP server injection) without the SDK, fork `claude` as a
  subprocess.
- **Environments where the Anthropic SDK is not installable** but the Claude
  Desktop app is present.
- **Smoke-testing the process bridge itself.** The
  `scripts/phase7-process-runtime.sh` smoke script exercises this path with a
  mock `claude` binary so no API key is required.

---

## Known Limitations

### Cost reporting

The `claude` CLI does not expose per-run token counts or cost figures in its
JSONL stream. When `*_RUNTIME=claude`, the executor sets `agent_runs.cost_usd`
to `null` and `prompt_tokens`/`completion_tokens` to `0`. Budget-gate
enforcement therefore falls back to wall-clock time alone for process-runtime
runs. This is tracked in [GitHub issue #tbd].

### Startup timeout

The process-runtime executor waits up to **30 seconds** for the `claude`
subprocess to emit its first JSONL record. If the binary is slow to start
(cold JIT, slow filesystem), the executor raises a `StartupTimeoutError` and
the task transitions to `failed`. You can raise the cap with
`CLAUDE_STARTUP_TIMEOUT_MS` (e.g. `CLAUDE_STARTUP_TIMEOUT_MS=60000`).

### Single-phase plan limitation

The process-runtime smoke script (`scripts/phase7-process-runtime.sh`) drives
only a **single-phase plan** because the mock `claude` binary returns a
fixed response. Multi-phase plans with real model continuity are only
exercised by the SDK path.

---

## Diagnostics

Run `pm-go doctor` to check that the runtime configuration is valid before
starting the worker:

```bash
pnpm pm-go doctor
```

`pm-go doctor` checks:

- Each `*_RUNTIME` variable resolves to a known value.
- For `sdk`: `ANTHROPIC_API_KEY` is set.
- For `claude`: the `claude` binary is found on `PATH` and responds to
  `claude --version`.
- The policy MCP bridge port (`POLICY_MCP_PORT`, default `9400`) is free.

See also `docs/runbooks/` for incident runbooks covering common runtime
failure modes.
