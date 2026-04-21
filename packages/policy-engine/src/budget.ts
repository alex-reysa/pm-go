import type {
  AgentRun,
  BudgetDecision,
  BudgetOverrun,
  Task,
} from "@pm-go/contracts";

/**
 * Minutes from an ISO-8601 timestamp pair. Returns 0 when either end
 * is absent — a still-running agent contributes no wall-clock usage
 * against the budget until it completes, so the gate is conservative
 * on purpose. The caller is responsible for forcing a tick by passing
 * a completion time if it wants to short-circuit a stuck run.
 */
function minutesBetween(startedAt?: string, completedAt?: string): number {
  if (!startedAt || !completedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const diffMs = end - start;
  if (diffMs <= 0) return 0;
  return diffMs / 60_000;
}

/**
 * Total prompt tokens attributed to an `AgentRun`. Cache reads and
 * cache creations are counted as input tokens for budget purposes
 * because they bill against the token cap the same way a fresh
 * prompt does. `outputTokens` is intentionally excluded from the
 * **prompt**-token cap — the contract field is `maxPromptTokens`,
 * which names only the input side.
 */
function runPromptTokens(run: AgentRun): number {
  return (
    (run.inputTokens ?? 0) +
    (run.cacheCreationTokens ?? 0) +
    (run.cacheReadTokens ?? 0)
  );
}

/**
 * `evaluateBudgetGate(task, runs) → BudgetDecision`
 *
 * Pure. Sums cost / tokens / wall-clock across the `AgentRun[]`
 * associated with a `Task` and compares totals against that task's
 * `TaskBudget`. Returns `{ ok: true }` if every configured cap is
 * still in bounds; otherwise returns an aggregated overrun detail so
 * the caller can persist a single `PolicyDecision` row citing each
 * dimension that tripped the gate.
 *
 * Scoping rules:
 *   - Only runs whose `taskId === task.id` are counted. The caller
 *     may pass the full plan-wide run list; the function filters.
 *   - A run in `queued` status contributes nothing (no tokens, no
 *     cost, no wall-clock) — it has not started spending yet.
 *   - A still-`running` run contributes whatever tokens / cost the
 *     executor has already attributed to it on the row (the Phase 3
 *     adapter streams partial values). Wall-clock is only counted
 *     for terminal runs (started + completed both populated).
 *   - Missing caps are permissive: if `task.budget.maxModelCostUsd`
 *     is undefined, the USD dimension cannot trip the gate.
 *   - `task.budget.maxWallClockMinutes` is required by the `TaskBudget`
 *     contract and is always checked; a value of `0` effectively
 *     disables wall-clock limiting (nothing > 0 minutes would trip
 *     because the check is strict `>`).
 */
export function evaluateBudgetGate(
  task: Task,
  runs: readonly AgentRun[],
): BudgetDecision {
  const scoped = runs.filter((r) => r.taskId === task.id);

  let totalUsd = 0;
  let totalPromptTokens = 0;
  let totalWallClockMinutes = 0;

  for (const run of scoped) {
    if (run.status === "queued") continue;
    totalUsd += run.costUsd ?? 0;
    totalPromptTokens += runPromptTokens(run);
    totalWallClockMinutes += minutesBetween(run.startedAt, run.completedAt);
  }

  const over: BudgetOverrun = {};

  const { maxModelCostUsd, maxPromptTokens, maxWallClockMinutes } =
    task.budget;

  if (maxModelCostUsd !== undefined && totalUsd > maxModelCostUsd) {
    over.usd = +(totalUsd - maxModelCostUsd).toFixed(6);
  }
  if (maxPromptTokens !== undefined && totalPromptTokens > maxPromptTokens) {
    over.tokens = totalPromptTokens - maxPromptTokens;
  }
  if (totalWallClockMinutes > maxWallClockMinutes) {
    over.wallClockMinutes = +(
      totalWallClockMinutes - maxWallClockMinutes
    ).toFixed(3);
  }

  if (Object.keys(over).length === 0) {
    return { ok: true };
  }

  return { ok: false, reason: "budget_exceeded", over };
}
