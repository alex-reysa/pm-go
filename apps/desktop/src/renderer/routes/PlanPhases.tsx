/**
 * Plan / Phases route.
 *
 * Renders the per-plan phase list in dependency (index) order with
 * each row's status badge, integration branch, and a one-line audit
 * / merge-run summary. The route is intentionally NOT expanded: each
 * row shows the headline state, and operators that want the deep
 * detail click through to the right inspector or open the task list.
 *
 * Mounts inside `RunDetailShell`, which owns the run-section nav,
 * the EventDrawer toggle (collapsed by default), and the
 * RightInspectorProvider. This file consumes the fixture envelope
 * only — no router params, no SSE, no API.
 */

import React from "react";

import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type PhasesList,
  type PhaseSummary,
  phasesHappyPath,
} from "../fixtures/index.js";

export interface PlanPhasesProps {
  /**
   * Phases dataset. Defaults to the happy-path fixture; tests swap in
   * `phasesEmptyState` / `phasesErrorState` to exercise the other
   * envelope variants.
   */
  readonly dataset?: FixtureDataset<PhasesList>;
}

/**
 * Format the latest phase-audit / merge-run summary into one line.
 * Returns a stable placeholder when neither summary is present so
 * the row layout stays predictable across phases.
 */
function describePhaseAudit(phase: PhaseSummary): string {
  if (phase.latestPhaseAudit !== null) {
    return `Audit: ${phase.latestPhaseAudit.outcome} — ${phase.latestPhaseAudit.summary}`;
  }
  if (phase.latestMergeRun !== null) {
    return `Merge run #${phase.latestMergeRun.index} · ${phase.latestMergeRun.outcome}`;
  }
  return "No audit stamped yet.";
}

/**
 * Summarise the per-status task counts on a phase, e.g.
 * `"2 merged · 1 running"`. Keeps the row compact while still
 * conveying enough for the operator to triage which phase needs
 * attention first.
 */
function describePhaseCounts(phase: PhaseSummary): string {
  const entries = Object.entries(phase.taskCountsByStatus).filter(
    ([, count]) => typeof count === "number" && count > 0,
  );
  if (entries.length === 0) {
    return "No tasks";
  }
  return entries.map(([status, count]) => `${count} ${status}`).join(" · ");
}

export function PlanPhases(props: PlanPhasesProps): React.JSX.Element {
  const dataset = props.dataset ?? phasesHappyPath;
  const phases = dataset.data;
  const errorMessage = dataset.state === "error" ? dataset.error.message : null;
  const isEmpty = dataset.state === "empty" || phases.length === 0;

  return (
    <section
      className="plan-phases"
      data-testid="plan-phases"
      data-dataset-state={dataset.state}
      aria-labelledby="plan-phases-title"
    >
      <header className="plan-phases__header">
        <p className="plan-phases__fixture-label">{FIXTURE_BANNER_LABEL}</p>
        <h1 id="plan-phases-title" className="plan-phases__title">
          Plan / Phases
        </h1>
        <p className="plan-phases__summary">
          {`${phases.length} phase${phases.length === 1 ? "" : "s"} in dependency order.`}
        </p>
        {errorMessage !== null ? (
          <p
            className="plan-phases__error"
            data-testid="plan-phases-error"
            role="status"
          >
            {`Phases load failed: ${errorMessage}. Surrounding navigation is still available.`}
          </p>
        ) : null}
      </header>

      {isEmpty ? (
        <p
          className="plan-phases__empty"
          data-testid="plan-phases-empty"
        >
          {dataset.state === "error"
            ? "No cached phases to show."
            : "Planner has not emitted phases yet."}
        </p>
      ) : (
        <ol className="plan-phases__list" data-testid="plan-phases-list">
          {phases.map((phase) => (
            <li
              key={phase.id}
              className="plan-phases__row"
              data-testid={`plan-phases-row-${phase.id}`}
              data-phase-status={phase.status}
            >
              <header className="plan-phases__row-header">
                <span className="plan-phases__row-index">
                  {`Phase ${phase.index}`}
                </span>
                <span className="plan-phases__row-title">{phase.title}</span>
                <span
                  className="plan-phases__row-status"
                  data-testid={`plan-phases-row-status-${phase.id}`}
                >
                  {phase.status}
                </span>
              </header>
              <p className="plan-phases__row-summary">{phase.summary}</p>
              <p className="plan-phases__row-counts">
                {describePhaseCounts(phase)}
              </p>
              <p className="plan-phases__row-audit">
                {describePhaseAudit(phase)}
              </p>
              {phase.integrationBranch !== null ? (
                <p className="plan-phases__row-branch">
                  {`Integration branch: ${phase.integrationBranch}`}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
