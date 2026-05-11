/**
 * Run Overview — the run-scoped cockpit route.
 *
 * Renders the "cockpit pattern" laid out in
 * `docs/desktop/03-information-architecture.md` § Disclosure Rules:
 *
 *     +--------------------------------------------------------------+
 *     | 1) Current state (always first)                              |
 *     | 2) Blocker / next action                                     |
 *     | 3) Release readiness                                         |
 *     +--------------------------------------------------------------+
 *     | per-phase / per-task supporting detail (BELOW the cockpit)   |
 *     +--------------------------------------------------------------+
 *
 * The cockpit three render BEFORE any per-phase or per-task detail.
 * Detail surfaces are deliberately collapsed — operators that want
 * more click into Plan/Phases, Tasks, or the right inspector. The
 * route does NOT expand every phase by default.
 *
 * M2 mock data: every dataset is sourced from the typed fixture
 * module behind `FIXTURE_BANNER_LABEL`. The error variant still
 * renders the cockpit shell — the IA contract is that an API
 * failure must not blank the route. Stale `data` rides alongside
 * the error banner so the operator keeps situational awareness.
 *
 * No SSE wiring, no API calls. M3 swaps the fixture imports for
 * live read-model reads through a thin adapter that returns the
 * same `FixtureDataset<...>` envelope.
 */

import React from "react";

import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type PhasesList,
  type PlanDetail,
  type ReleaseView,
  phasesHappyPath,
  planHappyPath,
  releaseEmptyState,
} from "../fixtures/index.js";

export interface RunOverviewProps {
  /**
   * Plan-detail dataset. Defaults to the M2 happy-path fixture; tests
   * swap in `planEmptyState` / `planErrorState` to exercise the
   * empty- and error-state rendering paths.
   */
  readonly planDataset?: FixtureDataset<PlanDetail>;
  /** Phases dataset for the supporting detail strip. */
  readonly phasesDataset?: FixtureDataset<PhasesList>;
  /** Release-view dataset for the release-readiness summary. */
  readonly releaseDataset?: FixtureDataset<ReleaseView>;
}

/**
 * Short human-readable description of the plan status, picked from a
 * small literal table so the cockpit copy stays stable across
 * fixtures and the eventual live data. Mirrors the action-gating
 * matrix in `docs/desktop/05-api-integration.md` at the level of
 * granularity an operator needs to scan in one second.
 */
function describePlanStatus(plan: PlanDetail): string {
  switch (plan.status) {
    case "draft":
      return "Draft — planner has not started.";
    case "executing":
      return "Executing — workers are picking up tasks.";
    case "auditing":
      return "Auditing — completion auditor is running.";
    case "completed":
      return "Completed — awaiting release.";
    case "released":
      return "Released — plan has shipped.";
    case "blocked":
      return "Blocked — operator action required.";
    case "failed":
      return "Failed — see blocker for details.";
    default:
      return "Unknown state.";
  }
}

/**
 * Single short blocker line. Order of precedence intentionally puts
 * the release-readiness blocker last so an executing plan with no
 * release attempt yet does not surface a misleading "no audit" note.
 */
function describeBlocker(
  plan: PlanDetail,
  phases: PhasesList,
  release: ReleaseView,
): string {
  if (plan.status === "blocked" || plan.status === "failed") {
    return `Plan is ${plan.status}; resolve the failing task or phase before retrying.`;
  }
  const blockedPhase = phases.find(
    (phase) => phase.status === "blocked" || phase.status === "failed",
  );
  if (blockedPhase !== undefined) {
    return `Phase "${blockedPhase.title}" is ${blockedPhase.status}.`;
  }
  if (release.blockers.length > 0) {
    return release.blockers[0]?.message ?? "Release is blocked.";
  }
  return "No blockers.";
}

/**
 * Suggested next action. Kept terse — the cockpit's job is to give
 * the operator one verb to take, not to enumerate every possibility.
 */
function describeNextAction(plan: PlanDetail, release: ReleaseView): string {
  if (plan.status === "released") {
    return "No action required.";
  }
  if (
    plan.status === "completed" &&
    release.completionAuditOutcome === "pass"
  ) {
    return "Release the plan.";
  }
  if (plan.status === "completed") {
    return "Run completion audit.";
  }
  if (plan.status === "executing" || plan.status === "auditing") {
    return "Wait for the active task to finish.";
  }
  if (plan.status === "blocked" || plan.status === "failed") {
    return "Resolve the blocker, then retry the blocked task.";
  }
  return "Start the planner.";
}

/**
 * Empty-state copy for when the plan dataset is the `empty` envelope
 * variant. Centralised so the literal string only lives in one
 * place; tests look for it verbatim.
 */
const EMPTY_PLAN_COPY = "This plan has no decomposition yet.";

function defaultReleaseDatasetFor(
  plan: PlanDetail,
): FixtureDataset<ReleaseView> {
  return {
    ...releaseEmptyState,
    data: {
      ...releaseEmptyState.data,
      planId: plan.id,
    },
  };
}

export function RunOverview(props: RunOverviewProps): React.JSX.Element {
  const planDataset = props.planDataset ?? planHappyPath;
  const phasesDataset = props.phasesDataset ?? phasesHappyPath;
  const plan = planDataset.data;
  const releaseDataset = props.releaseDataset ?? defaultReleaseDatasetFor(plan);
  const phases = phasesDataset.data;
  const release = releaseDataset.data;

  const planErrorMessage =
    planDataset.state === "error" ? planDataset.error.message : null;
  const phasesErrorMessage =
    phasesDataset.state === "error" ? phasesDataset.error.message : null;
  const releaseErrorMessage =
    releaseDataset.state === "error" ? releaseDataset.error.message : null;
  const isEmpty = planDataset.state === "empty";

  return (
    <section
      className="run-overview"
      data-testid="run-overview"
      data-plan-status={plan.status}
      data-dataset-state={planDataset.state}
      aria-labelledby="run-overview-title"
    >
      <header className="run-overview__banner" data-testid="run-overview-banner">
        <p className="run-overview__fixture-label">{FIXTURE_BANNER_LABEL}</p>
        <h1 id="run-overview-title" className="run-overview__title">
          {plan.title}
        </h1>
        <p className="run-overview__summary">{plan.summary}</p>
        {planErrorMessage !== null ? (
          <p
            className="run-overview__error"
            data-testid="run-overview-plan-error"
            role="status"
          >
            {`Plan load failed: ${planErrorMessage}. Showing the last cached snapshot.`}
          </p>
        ) : null}
      </header>

      {/*
        Cockpit triad: rendered in a fixed order BEFORE any
        per-phase/per-task list. Each section carries a stable
        data-testid so smoke tests can assert the DOM order via
        `index.of(testid)` rather than a brittle CSS selector.
      */}
      <div
        className="run-overview__cockpit"
        data-testid="run-overview-cockpit"
        aria-label="Run cockpit summary"
      >
        <section
          className="run-overview__section"
          data-testid="run-overview-current-state"
          aria-labelledby="run-overview-current-state-title"
        >
          <h2 id="run-overview-current-state-title">Current state</h2>
          <p className="run-overview__state-status">
            Plan status: <strong>{plan.status}</strong>
          </p>
          <p className="run-overview__state-description">
            {describePlanStatus(plan)}
          </p>
          <p className="run-overview__state-counts">
            {`${phases.length} phase${phases.length === 1 ? "" : "s"} · ` +
              `${plan.taskIds.length} task${plan.taskIds.length === 1 ? "" : "s"}`}
          </p>
        </section>

        <section
          className="run-overview__section"
          data-testid="run-overview-blocker-next-action"
          aria-labelledby="run-overview-blocker-title"
        >
          <h2 id="run-overview-blocker-title">Blocker / next action</h2>
          <p className="run-overview__blocker" data-testid="run-overview-blocker">
            {describeBlocker(plan, phases, release)}
          </p>
          <p
            className="run-overview__next-action"
            data-testid="run-overview-next-action"
          >
            {`Next action: ${describeNextAction(plan, release)}`}
          </p>
        </section>

        <section
          className="run-overview__section"
          data-testid="run-overview-release-readiness"
          aria-labelledby="run-overview-release-title"
        >
          <h2 id="run-overview-release-title">Release readiness</h2>
          <p className="run-overview__release-status">
            Release status: <strong>{release.status}</strong>
          </p>
          <p className="run-overview__release-audit">
            {`Completion audit: ${release.completionAuditOutcome ?? "not yet stamped"}`}
          </p>
          <p className="run-overview__release-artifacts">
            {`Release artifacts: ${release.releaseArtifactIds.length}`}
          </p>
          {releaseErrorMessage !== null ? (
            <p
              className="run-overview__error"
              data-testid="run-overview-release-error"
              role="status"
            >
              {`Release load failed: ${releaseErrorMessage}.`}
            </p>
          ) : null}
        </section>
      </div>

      {/*
        Supporting detail. The IA contract says NOT all-expanded — we
        render a compact phase strip with a link cue ("Open Plan /
        Phases") rather than re-rendering every phase's body.
      */}
      <section
        className="run-overview__detail"
        data-testid="run-overview-detail"
        aria-labelledby="run-overview-detail-title"
      >
        <h2 id="run-overview-detail-title">Per-phase detail</h2>
        {isEmpty || phases.length === 0 ? (
          <p
            className="run-overview__detail-empty"
            data-testid="run-overview-detail-empty"
          >
            {isEmpty ? EMPTY_PLAN_COPY : "No phases to show."}
          </p>
        ) : (
          <ul className="run-overview__phase-strip">
            {phases.map((phase) => (
              <li
                key={phase.id}
                className="run-overview__phase"
                data-testid={`run-overview-phase-${phase.id}`}
                data-phase-status={phase.status}
              >
                <span className="run-overview__phase-index">
                  {`Phase ${phase.index}`}
                </span>
                <span className="run-overview__phase-title">{phase.title}</span>
                <span className="run-overview__phase-status">
                  {phase.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {phasesErrorMessage !== null ? (
          <p
            className="run-overview__error"
            data-testid="run-overview-phases-error"
            role="status"
          >
            {`Phases load failed: ${phasesErrorMessage}. Showing whatever was cached.`}
          </p>
        ) : null}
      </section>
    </section>
  );
}
