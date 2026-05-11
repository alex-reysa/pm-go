/**
 * Run-scoped Budget route.
 *
 * Renders the `BudgetSnapshot` fixture envelope:
 *
 *   - plan-level totals (USD, tokens, wall-clock minutes)
 *   - per-task pressure rows with cost vs. cap and an `overBudget`
 *     flag — the per-row `overBudget` derivation matches the
 *     `overBudgetTasks` rollup on the snapshot
 *   - cross-links back to Tasks and Approvals (deep links via the
 *     `pathForRunTasks` / `pathForRunApprovals` path helpers) so the
 *     operator can drill into the cause of any over-budget signal
 *
 * The route is body-only — RunDetailShell owns the surrounding chrome.
 * State branching mirrors the other run-scoped routes:
 *
 *   - `happy` → snapshot + rows.
 *   - `empty` → empty-state callout for "no spend recorded yet"; the
 *     header chrome and per-task table omit the rows but keep the
 *     summary skeleton so the page does not collapse on first load.
 *   - `error` → inline `ApiError` callout while the per-task table
 *     keeps any stale rows the envelope carries. M3 will replace the
 *     stale-row preservation with cache-derived data; M2 fixtures
 *     ship an empty `BUDGET_EMPTY` snapshot in the error envelope so
 *     the same render path still runs.
 *
 * The "policy decisions" call-out is a static block under M2 — the
 * fixture envelope does not carry per-task policy decisions yet, so
 * the surface renders a "see Approvals" link that bridges into the
 * Approvals route until M3 surfaces real policy-engine output.
 */

import React from "react";
import { Link } from "react-router-dom";

import {
  FIXTURE_BANNER_LABEL,
  type BudgetPerTask,
  type BudgetSnapshot,
  type FixtureDataset,
  phasesHappyPath,
  tasksHappyPath,
} from "../fixtures/index.js";
import {
  pathForRunApprovals,
  pathForRunPhases,
  pathForRunTasks,
  pathForTaskDetail,
} from "../router/routes.js";

export interface BudgetRouteProps {
  /**
   * Fixture envelope to render. M3 swap-target.
   */
  readonly dataset: FixtureDataset<BudgetSnapshot>;
}

/**
 * Format a USD amount with two-decimal precision and a leading `$`.
 * Kept local to this route so the typing experiment doesn't drag a
 * cross-cutting i18n module in at M2.
 */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format an integer-token count with thousands separators. Falls back
 * to the raw integer if `toLocaleString` is unavailable (it should
 * always be defined in modern V8 / WebKit, but we're conservative on
 * the renderer's contract surface).
 */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

interface PhasePressureRow {
  readonly phaseId: string;
  readonly phaseTitle: string;
  readonly taskCount: number;
  readonly usd: number;
  readonly tokens: number;
  readonly wallClockMinutes: number;
  readonly overBudgetCount: number;
}

function phasePressureRows(snapshot: BudgetSnapshot): readonly PhasePressureRow[] {
  const taskPhaseById = new Map(
    tasksHappyPath.data.map((task) => [task.id, task.phaseId]),
  );
  const phaseTitleById = new Map(
    phasesHappyPath.data.map((phase) => [phase.id, phase.title]),
  );
  const rowsByPhase = new Map<string, PhasePressureRow>();

  for (const task of snapshot.perTask) {
    const phaseId = taskPhaseById.get(task.taskId) ?? "phase_unknown";
    const existing = rowsByPhase.get(phaseId);
    const next: PhasePressureRow = {
      phaseId,
      phaseTitle: phaseTitleById.get(phaseId) ?? "Unassigned phase",
      taskCount: (existing?.taskCount ?? 0) + 1,
      usd: (existing?.usd ?? 0) + task.usd,
      tokens: (existing?.tokens ?? 0) + task.tokens,
      wallClockMinutes:
        (existing?.wallClockMinutes ?? 0) + task.wallClockMinutes,
      overBudgetCount:
        (existing?.overBudgetCount ?? 0) + (task.overBudget ? 1 : 0),
    };
    rowsByPhase.set(phaseId, next);
  }

  return [...rowsByPhase.values()];
}

function BudgetRow({
  row,
  planId,
}: {
  row: BudgetPerTask;
  planId: string;
}): React.JSX.Element {
  return (
    <li
      className="budget__row"
      data-task-id={row.taskId}
      data-over-budget={row.overBudget ? "true" : "false"}
      data-testid={`budget-row-${row.taskId}`}
    >
      <div className="budget__row-title">
        <Link
          to={pathForTaskDetail(planId, row.taskId)}
          className="budget__row-link"
          data-testid={`budget-row-${row.taskId}-link`}
        >
          {row.taskTitle}
        </Link>
      </div>
      <dl className="budget__row-meta">
        <dt>spend</dt>
        <dd data-testid={`budget-row-${row.taskId}-spend`}>
          {formatUsd(row.usd)} / {formatUsd(row.capUsd)}
        </dd>
        <dt>tokens</dt>
        <dd data-testid={`budget-row-${row.taskId}-tokens`}>
          {formatTokens(row.tokens)}
        </dd>
        <dt>wall-clock</dt>
        <dd data-testid={`budget-row-${row.taskId}-wallclock`}>
          {row.wallClockMinutes}m
        </dd>
      </dl>
      {row.overBudget ? (
        <p
          className="budget__row-over"
          role="alert"
          data-testid={`budget-row-${row.taskId}-overbudget`}
        >
          Over budget · review in Approvals.
        </p>
      ) : null}
    </li>
  );
}

export function Budget(props: BudgetRouteProps): React.JSX.Element {
  const { dataset } = props;
  const snapshot = dataset.data;
  const planId = snapshot.planId;
  const isError = dataset.state === "error";
  const isEmpty = dataset.state === "empty" || snapshot.perTask.length === 0;
  const phaseRows = phasePressureRows(snapshot);

  return (
    <section
      className="budget"
      data-route="run.budget"
      data-testid="budget-route"
      data-fixture-state={dataset.state}
      aria-labelledby="budget-title"
    >
      <header className="budget__header">
        <h2 id="budget-title">Budget</h2>
        <p
          className="budget__fixture-banner"
          data-testid="budget-fixture-banner"
        >
          {FIXTURE_BANNER_LABEL} · {dataset.label}
        </p>
      </header>
      {isError ? (
        <div className="budget__error" role="alert" data-testid="budget-error">
          <p className="budget__error-title">
            Failed to load budget snapshot (HTTP {dataset.error.status})
          </p>
          <p className="budget__error-message">{dataset.error.message}</p>
        </div>
      ) : null}
      <section
        className="budget__summary"
        aria-label="Plan budget summary"
        data-testid="budget-summary"
      >
        <dl>
          <dt>generated at</dt>
          <dd data-testid="budget-summary-generated-at">
            {snapshot.generatedAt}
          </dd>
          <dt>total spend</dt>
          <dd data-testid="budget-summary-total-usd">
            {formatUsd(snapshot.totalUsd)}
          </dd>
          <dt>total tokens</dt>
          <dd data-testid="budget-summary-total-tokens">
            {formatTokens(snapshot.totalTokens)}
          </dd>
          <dt>total wall-clock</dt>
          <dd data-testid="budget-summary-total-wallclock">
            {snapshot.totalWallClockMinutes}m
          </dd>
        </dl>
      </section>
      <section
        className="budget__phase-pressure"
        aria-label="Phase budget pressure"
        data-testid="budget-phase-pressure"
      >
        <h3>Phase pressure</h3>
        {phaseRows.length > 0 ? (
          <ul className="budget__phase-pressure-rows">
            {phaseRows.map((phase) => (
              <li
                key={phase.phaseId}
                className="budget__phase-pressure-row"
                data-testid={`budget-phase-${phase.phaseId}`}
              >
                <Link
                  to={pathForRunPhases(planId)}
                  data-testid={`budget-phase-${phase.phaseId}-link`}
                >
                  {phase.phaseTitle}
                </Link>
                <dl>
                  <dt>tasks</dt>
                  <dd>{phase.taskCount}</dd>
                  <dt>spend</dt>
                  <dd>{formatUsd(phase.usd)}</dd>
                  <dt>tokens</dt>
                  <dd>{formatTokens(phase.tokens)}</dd>
                  <dt>wall-clock</dt>
                  <dd>{phase.wallClockMinutes}m</dd>
                  <dt>over budget</dt>
                  <dd>{phase.overBudgetCount}</dd>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="budget-phase-pressure-empty">
            No phase pressure recorded for this fixture.
          </p>
        )}
      </section>
      <section
        className="budget__policy"
        aria-label="Policy decisions"
        data-testid="budget-policy"
      >
        <h3>Policy decisions</h3>
        <p>
          Approval gating decisions land in the{" "}
          <Link
            to={pathForRunApprovals(planId)}
            data-testid="budget-policy-approvals-link"
          >
            Approvals
          </Link>{" "}
          queue. Per-task cost drives the per-row{" "}
          <Link
            to={pathForRunTasks(planId)}
            data-testid="budget-policy-tasks-link"
          >
            Tasks
          </Link>{" "}
          breakdown below — click a row to inspect the task lease.
        </p>
        {snapshot.overBudgetTasks.length > 0 ? (
          <p
            className="budget__policy-overbudget"
            role="status"
            data-testid="budget-policy-overbudget"
          >
            {snapshot.overBudgetTasks.length} task(s) over budget.
          </p>
        ) : null}
      </section>
      {isEmpty && !isError ? (
        <p className="budget__empty" data-testid="budget-empty">
          No spend recorded for this plan yet.
        </p>
      ) : null}
      {!isEmpty ? (
        <ul className="budget__rows" data-testid="budget-rows">
          {snapshot.perTask.map((row) => (
            <BudgetRow key={row.taskId} row={row} planId={planId} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
