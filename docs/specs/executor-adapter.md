# Executor Adapter

Pins the `@anthropic-ai/claude-agent-sdk` surface to the `pm-go`
control-plane data model.

## Boundary

- Workflows never import the Anthropic SDK directly.
- Activities in `packages/temporal-activities` call the adapter exported
  from `packages/executor-claude`.
- The adapter is the single place where SDK options are constructed from
  control-plane inputs (`Task`, `ReviewPolicy`, `FileScope`,
  `WorktreeLease`, `AgentRun`).
- All role-specific option assembly, scope enforcement, and session
  bookkeeping lives behind this boundary.

## Control-Plane To SDK Option Mapping

| Control-plane input | SDK option | Behavior |
| --- | --- | --- |
| `Task.fileScope.includes` | `additionalDirectories` + `canUseTool` | Restrict filesystem access and deny writes outside scope. |
| `Task.fileScope.excludes` | `canUseTool` | Deny tool calls targeting excluded paths. |
| `Task.budget.maxModelCostUsd` | `maxBudgetUsd` | Stop the run when budget is reached. |
| `Task.budget.maxWallClockMinutes` | Workflow-level activity timeout, not an SDK option | Orchestrator enforces via Temporal. |
| `Task.budget.maxPromptTokens` | `maxTurns` as a proxy plus per-turn accounting via `onMessage` | SDK has no direct token cap. |
| `ReviewPolicy.reviewerWriteAccess: false` | `disallowedTools: ['Write','Edit','NotebookEdit']` plus `canUseTool` denial on write-like `Bash` invocations | Enforces reviewer independence. |
| `WorktreeLease.worktreePath` | `cwd` | All tool calls execute inside the worktree. |
| `AgentRun.model` | `model` | Executor records the exact model string used. |
| `AgentRun.promptVersion` | `systemPrompt` | Adapter looks up the versioned prompt by ID. |
| Prior `AgentRun.sessionId` | `resume` (optionally `forkSession: true`) | Durable session continuity across retries. |

## Role Profiles

### `implementer`

- Allowed tools: `['Read','Grep','Glob','Bash','Write','Edit','NotebookEdit']`.
- Disallowed tools: none at the SDK level; scope enforcement runs in
  `canUseTool`.
- Permission mode: `default`.
- Structured output required: no.
- `canUseTool` active: yes; denies writes outside `fileScope.includes`.

### `reviewer`

- Allowed tools: `['Read','Grep','Glob','Bash']`.
- Disallowed tools: `['Write','Edit','NotebookEdit']`.
- Permission mode: `default`.
- Structured output required: yes;
  `outputFormat: { type: 'json_schema', schema: <ReviewContractSchema> }`.
- `canUseTool` active: yes; denies any `Bash` matching
  `/\bgit (commit|push|merge|reset|checkout|rebase)\b/` or write-like
  shell redirection.

### `auditor`

- Allowed tools: `['Read','Grep','Glob','Bash']`.
- Disallowed tools: `['Write','Edit','NotebookEdit']`.
- Permission mode: `default`.
- Structured output required: yes;
  `outputFormat: { type: 'json_schema', schema: <AuditContractSchema> }`.
- `canUseTool` active: yes; same read-only posture as `reviewer`.
- Applies to both plan audit and completion audit roles.

### `planner`

- Allowed tools: `['Read','Grep','Glob']`.
- Disallowed tools: `['Write','Edit','NotebookEdit','Bash']`.
- Permission mode: `default`.
- Structured output required: yes;
  `outputFormat: { type: 'json_schema', schema: <PlanContractSchema> }`.
- `canUseTool` active: yes; denies anything outside the read set.

### `integrator`

- Allowed tools: `['Read','Grep','Glob','Bash']`.
- Disallowed tools: `['Write','Edit','NotebookEdit']`.
- Permission mode: `default`.
- Structured output required: no.
- `canUseTool` active: yes; permits git write commands only when `cwd`
  resolves to the integration branch worktree; no arbitrary file edits.

## Scope Enforcement

- `executor.canUseTool.fileScope` — runtime denial at every tool call.
  Deny if the target path is outside `fileScope.includes` or matches
  `fileScope.excludes`. Record the denial as a `PolicyDecision` with
  `decision: 'scope_violation'`.
- `task_review.fileScope.diff` — workflow-level post-execution check.
  Diff the worktree against the base SHA. Fail the task into `blocked`
  if any changed file is outside `fileScope.includes`.

## Session And Cost Accounting

- Every `query()` call returns or emits: `session_id`,
  `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`,
  `total_cost_usd`, and turn count.
- The adapter persists these onto the `AgentRun` row at completion.
- For long runs, the adapter writes incremental updates via `onMessage`.
- Resume uses `resume: previousAgentRun.sessionId`.
- A fork (`forkSession: true`) is used when re-auditing so that the
  original session remains immutable.

## Permission Model

- The SDK exposes four enforcement layers: permission modes,
  `canUseTool`, hooks, and `settings.json` rules.
- V1 chooses a single primary trust boundary: `canUseTool`, implemented
  in the executor adapter, fed by `ReviewPolicy` and `FileScope`.
- `permissionMode: 'default'`.
- `allowDangerouslySkipPermissions` is never set.
- `settingSources: []`; V1 does not load user `CLAUDE.md`.
- Hooks are reserved for observability only, not enforcement.

## Observability

- The adapter emits durable events per message and per tool call, each
  tied to `AgentRun.id`.
- The SDK `onMessage` callback fans out message-level events to the
  observability package.
- The SDK `hooks` surface fans out tool-call lifecycle events.
- Emitted events include session id, role, tool name, scope decision,
  token usage delta, and cost delta.

## Non-Goals For V1

- No multi-provider abstraction.
- No runtime role generation.
- No `mcpServers` configuration.
- No `plugins`.
- No `sandbox` settings; worktree isolation is sufficient for V1.
- No `enableFileCheckpointing`; worktree plus git commits are the
  checkpoint mechanism.
