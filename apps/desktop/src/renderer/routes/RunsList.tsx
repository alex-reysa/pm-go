/**
 * Runs List — the canonical landing surface for the desktop cockpit
 * after attach has succeeded.
 *
 * Information architecture (docs/desktop/03-information-architecture.md
 * §Route Map row `/runs`):
 *
 *   - This route is **top-level**, not run-scoped. It MUST NOT mount
 *     the EventDrawer or the RightInspector. Those primitives live
 *     beneath {@link RunDetailShell}, which only wraps the
 *     `/runs/:planId/...` family. Smoke tests assert that the rendered
 *     markup for this route contains neither `data-testid="event-drawer"`
 *     nor `data-testid="right-inspector"`.
 *   - The route renders three fixture variants — happy, empty, error —
 *     and surfaces the M2 fixture banner so an operator never confuses
 *     mock data for live state.
 *   - Each row exposes an attention summary (pending approvals, blocked
 *     tasks, failed tasks, blocked phases, release-ready) so the user
 *     can triage which run to open next. The summary is derived
 *     client-side from the pre-joined fixture fields; M3 replaces this
 *     with a join over `GET /plans` plus the aggregated approval /
 *     task counters.
 *   - Navigation: each row links to `/runs/:planId` via
 *     {@link pathForRunOverview}. The page also offers a "New Spec"
 *     entry that navigates to `/runs/new`.
 *
 * The route is a pure render-from-props component: the fixture is
 * injected via the {@link RunsListProps.fixture} prop with a default
 * pointing at {@link runsHappyPath}. Tests pass each of the three
 * datasets to exercise the variant rendering.
 */

import React from "react";
import { Link } from "react-router-dom";

import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type RunSummary,
  type RunsList as RunsListData,
  runsHappyPath,
} from "../fixtures/index.js";
import { useLiveRuns, type LiveRunsResource } from "../layout/index.js";
import type { RunSummaryViewModel } from "../read-models/index.js";
import { ROUTES, pathForRunOverview } from "../router/index.js";

export interface RunsListProps {
  /**
   * Fixture dataset driving this render. Defaults to
   * {@link runsHappyPath}. Tests pass the empty / error variants to
   * exercise non-happy paths; M3 replaces this prop with a live
   * dataset hook.
   */
  readonly fixture?: FixtureDataset<RunsListData>;
  readonly live?: LiveRunsResource;
}

/**
 * Render a one-line description of a run's attention indicators.
 * Empty stretches collapse to "no attention items" so the operator
 * can see at a glance which rows need nothing.
 */
function describeAttention(attention: RunSummary["attention"]): string {
  const parts: string[] = [];
  if (attention.pendingApprovals > 0) {
    parts.push(
      `${attention.pendingApprovals} pending approval${attention.pendingApprovals === 1 ? "" : "s"}`,
    );
  }
  if (attention.blockedTasks > 0) {
    parts.push(
      `${attention.blockedTasks} blocked task${attention.blockedTasks === 1 ? "" : "s"}`,
    );
  }
  if (attention.failedTasks > 0) {
    parts.push(
      `${attention.failedTasks} failed task${attention.failedTasks === 1 ? "" : "s"}`,
    );
  }
  if (attention.blockedPhases > 0) {
    parts.push(
      `${attention.blockedPhases} blocked phase${attention.blockedPhases === 1 ? "" : "s"}`,
    );
  }
  if (attention.releaseReady) {
    parts.push("release ready");
  }
  return parts.length === 0 ? "no attention items" : parts.join(" · ");
}

function RunRow({ run }: { run: RunSummary }): React.JSX.Element {
  const summary = describeAttention(run.attention);
  return (
    <li
      className="runs-list__row"
      data-testid={`runs-list-row-${run.id}`}
      data-plan-id={run.id}
      data-status={run.status}
    >
      <Link
        to={pathForRunOverview(run.id)}
        className="runs-list__link"
        data-testid={`runs-list-link-${run.id}`}
      >
        <span className="runs-list__title">{run.title}</span>
        <span
          className="runs-list__status-badge"
          data-testid={`runs-list-status-${run.id}`}
        >
          {run.status}
        </span>
      </Link>
      <p className="runs-list__summary">{run.summary}</p>
      <p
        className="runs-list__attention"
        data-testid={`runs-list-attention-${run.id}`}
      >
        {summary}
      </p>
      {run.riskLevels.length > 0 ? (
        <p
          className="runs-list__risks"
          data-testid={`runs-list-risks-${run.id}`}
        >
          risk: {run.riskLevels.join(", ")}
        </p>
      ) : null}
    </li>
  );
}

function describeLiveAttention(attention: RunSummaryViewModel["attention"]): string {
  const parts: string[] = [];
  const pendingApprovals = attention.pendingApprovals.value;
  const blockedTasks = attention.blockedTasks.value;
  const failedTasks = attention.failedTasks.value;
  const blockedPhases = attention.blockedPhases.value;
  const releaseReady = attention.releaseReady.value;

  if (pendingApprovals !== null && pendingApprovals > 0) {
    parts.push(
      `${pendingApprovals} pending approval${pendingApprovals === 1 ? "" : "s"}`,
    );
  }
  if (blockedTasks !== null && blockedTasks > 0) {
    parts.push(`${blockedTasks} blocked task${blockedTasks === 1 ? "" : "s"}`);
  }
  if (failedTasks !== null && failedTasks > 0) {
    parts.push(`${failedTasks} failed task${failedTasks === 1 ? "" : "s"}`);
  }
  if (blockedPhases !== null && blockedPhases > 0) {
    parts.push(`${blockedPhases} blocked phase${blockedPhases === 1 ? "" : "s"}`);
  }
  if (releaseReady === true) {
    parts.push("release ready");
  }

  if (parts.length > 0) return parts.join(" · ");
  return [
    pendingApprovals,
    blockedTasks,
    failedTasks,
    blockedPhases,
    releaseReady,
  ].every((value) => value === null)
    ? "attention unavailable until run detail loads"
    : "no attention items";
}

function LiveRunRow({ run }: { run: RunSummaryViewModel }): React.JSX.Element {
  return (
    <li
      className="runs-list__row"
      data-testid={`runs-list-row-${run.id}`}
      data-plan-id={run.id}
      data-status={run.status}
    >
      <Link
        to={pathForRunOverview(run.id)}
        className="runs-list__link"
        data-testid={`runs-list-link-${run.id}`}
      >
        <span className="runs-list__title">{run.title}</span>
        <span
          className="runs-list__status-badge"
          data-testid={`runs-list-status-${run.id}`}
        >
          {run.status}
        </span>
      </Link>
      <p className="runs-list__summary">{run.summary}</p>
      <p
        className="runs-list__attention"
        data-testid={`runs-list-attention-${run.id}`}
      >
        {describeLiveAttention(run.attention)}
      </p>
      {run.riskLevels.length > 0 ? (
        <p
          className="runs-list__risks"
          data-testid={`runs-list-risks-${run.id}`}
        >
          risk: {run.riskLevels.join(", ")}
        </p>
      ) : null}
    </li>
  );
}

function formatLiveErrorKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function LiveRunsList({ live }: { live: LiveRunsResource }): React.JSX.Element {
  const hasRows = live.data.length > 0;
  const showEmptyMessage = live.state === "empty";
  const primaryError = live.errors[0] ?? null;

  return (
    <section
      className="runs-list"
      data-testid="runs-list-route"
      data-route="runs"
      data-source="live"
      data-live-state={live.state}
      aria-labelledby="runs-list-title"
    >
      <header className="runs-list__header">
        <h1 id="runs-list-title">{ROUTES.runs.title}</h1>
        <Link
          to={ROUTES["runs.new"].path}
          className="runs-list__new-spec"
          data-testid="runs-list-new-spec-link"
        >
          {ROUTES["runs.new"].title}
        </Link>
        <button
          type="button"
          className="runs-list__refresh"
          data-testid="runs-list-refresh"
          onClick={live.refresh}
        >
          Refresh
        </button>
      </header>
      {live.isLoading || live.isRefreshing ? (
        <p
          className="runs-list__loading"
          data-testid="runs-list-loading"
          role="status"
        >
          {live.isRefreshing ? "Refreshing live runs." : "Loading live runs."}
        </p>
      ) : null}
      {primaryError !== null ? (
        <div
          className="runs-list__error"
          role="alert"
          data-testid="runs-list-error"
          data-error-kind={primaryError.kind}
        >
          <p>
            Unable to load live runs ({formatLiveErrorKind(primaryError.kind)}
            {primaryError.status > 0 ? `, HTTP ${primaryError.status}` : ""}):{" "}
            {primaryError.message}
          </p>
          <button type="button" onClick={live.refresh}>
            Retry
          </button>
        </div>
      ) : null}
      {showEmptyMessage ? (
        <p className="runs-list__empty" data-testid="runs-list-empty">
          No runs yet. Start a plan from{" "}
          <Link to={ROUTES["runs.new"].path} data-testid="runs-list-empty-new-spec-link">
            New Spec
          </Link>
          .
        </p>
      ) : null}
      {hasRows ? (
        <ul className="runs-list__rows" data-testid="runs-list-rows">
          {live.data.map((run) => (
            <LiveRunRow key={run.id} run={run} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function RunsList(props: RunsListProps): React.JSX.Element {
  const liveFromContext = useLiveRuns();
  if (props.fixture === undefined) {
    const live = props.live ?? liveFromContext;
    if (live !== null) {
      return <LiveRunsList live={live} />;
    }
  }

  const fixture = props.fixture ?? runsHappyPath;
  const showEmptyMessage =
    fixture.state === "empty" || (fixture.state === "error" && fixture.data.length === 0);

  return (
    <section
      className="runs-list"
      data-testid="runs-list-route"
      data-route="runs"
      data-fixture-state={fixture.state}
      aria-labelledby="runs-list-title"
    >
      <header className="runs-list__header">
        <h1 id="runs-list-title">{ROUTES.runs.title}</h1>
        <Link
          to={ROUTES["runs.new"].path}
          className="runs-list__new-spec"
          data-testid="runs-list-new-spec-link"
        >
          {ROUTES["runs.new"].title}
        </Link>
      </header>
      <p
        className="runs-list__fixture-banner"
        data-testid="fixture-banner"
        role="status"
      >
        {FIXTURE_BANNER_LABEL} · {fixture.label}
      </p>
      {fixture.state === "error" ? (
        <p
          className="runs-list__error"
          role="alert"
          data-testid="runs-list-error"
        >
          Unable to load runs (HTTP {fixture.error.status}): {fixture.error.message}
        </p>
      ) : null}
      {showEmptyMessage ? (
        <p
          className="runs-list__empty"
          data-testid="runs-list-empty"
        >
          No runs yet. Start a plan from{" "}
          <Link
            to={ROUTES["runs.new"].path}
            data-testid="runs-list-empty-new-spec-link"
          >
            New Spec
          </Link>
          .
        </p>
      ) : (
        <ul className="runs-list__rows" data-testid="runs-list-rows">
          {fixture.data.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
