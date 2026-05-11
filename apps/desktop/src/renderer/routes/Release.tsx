/**
 * Run-scoped Release route.
 *
 * Renders completion-audit readiness, release artifact state, blockers,
 * and the M2 release confirmation affordance. The actual release POST
 * remains deferred to M4 via ConfirmationModal copy.
 */

import React, { useState } from "react";

import { ConfirmationModal } from "../layout/ConfirmationModal.js";
import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type ReleaseStatus,
  type ReleaseView,
} from "../fixtures/index.js";

export interface ReleaseRouteProps {
  readonly dataset: FixtureDataset<ReleaseView>;
  readonly initialReleaseConfirmationOpen?: boolean;
}

function statusLabel(status: ReleaseStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "ready":
      return "Ready";
    case "in_progress":
      return "Release in progress";
    case "released":
      return "Released";
    case "failed":
      return "Failed";
  }
}

function releaseDisabledReason(view: ReleaseView): string | null {
  if (view.blockers.length > 0) {
    return "Resolve release blockers before confirming.";
  }
  if (view.completionAuditOutcome !== "pass") {
    return "A passing completion audit is required before release.";
  }
  return null;
}

export function Release(props: ReleaseRouteProps): React.JSX.Element {
  const { dataset, initialReleaseConfirmationOpen = false } = props;
  const view = dataset.data;
  const isError = dataset.state === "error";
  const isEmpty = dataset.state === "empty";
  const [isReleaseModalOpen, setReleaseModalOpen] = useState<boolean>(
    initialReleaseConfirmationOpen,
  );
  const disabledReason = releaseDisabledReason(view);

  return (
    <section
      className="release"
      data-route="run.release"
      data-testid="release-route"
      data-fixture-state={dataset.state}
      aria-labelledby="release-title"
    >
      <header className="release__header">
        <h2 id="release-title">Release</h2>
        <p
          className="release__fixture-banner"
          data-testid="release-fixture-banner"
        >
          {FIXTURE_BANNER_LABEL} · {dataset.label}
        </p>
      </header>

      {isError ? (
        <div className="release__error" role="alert" data-testid="release-error">
          <p className="release__error-title">
            Failed to load release state (HTTP {dataset.error.status})
          </p>
          <p className="release__error-message">{dataset.error.message}</p>
        </div>
      ) : null}

      {isEmpty ? (
        <p className="release__empty" data-testid="release-empty">
          No completion audit has marked this plan ready for release.
        </p>
      ) : null}

      <section
        className="release__readiness"
        aria-label="Release readiness"
        data-testid="release-readiness"
      >
        <h3>Readiness</h3>
        <dl>
          <dt>status</dt>
          <dd data-testid="release-status">{statusLabel(view.status)}</dd>
          <dt>completion audit</dt>
          <dd data-testid="release-completion-audit-outcome">
            {view.completionAuditOutcome ?? "none"}
          </dd>
          <dt>completion audit id</dt>
          <dd>{view.completionAuditId ?? "none"}</dd>
          <dt>workflow run</dt>
          <dd>{view.workflowRunId ?? "none"}</dd>
          <dt>attempted at</dt>
          <dd>{view.attemptedAt ?? "never"}</dd>
        </dl>
      </section>

      <section
        className="release__audit"
        aria-label="Completion audit and blockers"
        data-testid="release-audit"
      >
        <h3>Completion audit</h3>
        {view.blockers.length > 0 ? (
          <ul className="release__blockers" data-testid="release-blockers">
            {view.blockers.map((blocker) => (
              <li key={blocker.id} data-testid={`release-blocker-${blocker.id}`}>
                <strong>{blocker.title}</strong>
                <p>{blocker.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="release-no-blockers">
            No completion-audit blockers in this fixture.
          </p>
        )}
      </section>

      <section
        className="release__artifacts"
        aria-label="Release artifacts"
        data-testid="release-artifacts"
      >
        <h3>Release artifacts</h3>
        {view.releaseArtifactIds.length > 0 ? (
          <ul>
            {view.releaseArtifactIds.map((artifactId) => (
              <li key={artifactId} data-testid={`release-artifact-${artifactId}`}>
                {artifactId}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="release-artifacts-empty">
            No release artifacts persisted for this fixture.
          </p>
        )}
      </section>

      {view.releaseNotes !== null ? (
        <section
          className="release__notes"
          aria-label="Release notes"
          data-testid="release-notes"
        >
          <h3>Release notes</h3>
          <pre>{view.releaseNotes}</pre>
        </section>
      ) : null}

      <div className="release__actions">
        <button
          type="button"
          className="release__button"
          data-testid="release-button"
          onClick={() => setReleaseModalOpen(true)}
        >
          Release
        </button>
      </div>

      <ConfirmationModal
        isOpen={isReleaseModalOpen}
        action={`Release plan ${view.planId}`}
        confirmLabel="Release"
        disabledReason={disabledReason}
        onConfirm={() => setReleaseModalOpen(false)}
        onCancel={() => setReleaseModalOpen(false)}
      >
        <p className="release__confirm-summary">
          Completion audit {view.completionAuditOutcome ?? "none"} · readiness{" "}
          {statusLabel(view.status)}.
        </p>
      </ConfirmationModal>
    </section>
  );
}
