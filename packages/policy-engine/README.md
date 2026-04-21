# @pm-go/policy-engine

Phase 7 Worker 1 — pure-function policy evaluators.

This package decides whether a task may keep spending budget, whether a
plan or task needs a human thumbs-up before merge, whether a failed
workflow attempt should retry, and whether a runaway review cycle should
stop the plan entirely.

## Invariants

The package is **side-effect free**:

- no I/O — no DB, no filesystem, no network
- no Temporal SDK imports
- no `@anthropic-ai/claude-agent-sdk` imports
- every exported function accepts plain domain values and returns a
  discriminated-union decision

The durable consequences of a decision (inserting a `PolicyDecision`
row, writing an `ApprovalRequest`, short-circuiting a task to `blocked`)
live outside this package — Worker 4 wires the decisions into the
Temporal activity layer during Wave 2.

## Decision sources

- `Task.budget` and `AgentRun[]` — budget gate
- `Task.riskLevel` and `Risk.humanApprovalRequired` — approval gate
- `RetryPolicyConfig` and last-error name — retry decision
- `OperatingLimits`, review-cycle count, findings — stop condition

## Exports

| Function                   | Input shape                                                  | Output shape                                                                     |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `evaluateBudgetGate`       | `Task`, `AgentRun[]`                                         | `BudgetDecision` — `{ ok: true } \| { ok: false; reason; over }`                 |
| `evaluateApprovalGate`     | `Risk \| Task`, `Task`                                       | `ApprovalDecision` — `{ required: false } \| { required: true; band }`           |
| `evaluateRetryDecision`    | `workflowName`, `attempt`, `lastError`, `RetryPolicyConfig[]` | `RetryDecision` — `{ retry: true; delayMs } \| { retry: false; reason }`         |
| `evaluateStopCondition`    | `Plan`, `cycles`, `ReviewFinding[]`, `OperatingLimits`       | `StopDecision` — `{ stop: false } \| { stop: true; reason }`                     |

See `packages/contracts/src/policy.ts` for the companion type
definitions (`ApprovalRequest`, `ApprovalDecision`, `BudgetDecision`,
`BudgetReport`, `RetryPolicyConfig`, `RetryDecision`, `StopDecision`).

## Tests

```
pnpm --filter @pm-go/policy-engine test
```

All evaluator functions are fully covered by fixture-driven unit tests
under `packages/policy-engine/test/`.
