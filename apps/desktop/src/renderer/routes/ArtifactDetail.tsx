/**
 * Run-scoped Artifact Detail route.
 *
 * M2 renders fixture artifact content inertly as preformatted text.
 * There is intentionally no Markdown renderer, no raw HTML injection,
 * and no remote resource loading in this surface.
 */

import React from "react";
import { Link } from "react-router-dom";

import {
  FIXTURE_BANNER_LABEL,
  type ArtifactDetail as ArtifactDetailView,
  type FixtureDataset,
} from "../fixtures/index.js";
import { pathForRunEvidence } from "../router/routes.js";

export interface ArtifactDetailRouteProps {
  readonly dataset: FixtureDataset<ArtifactDetailView | null>;
}

export function ArtifactDetail(
  props: ArtifactDetailRouteProps,
): React.JSX.Element {
  const { dataset } = props;
  const artifact = dataset.data;
  const isError = dataset.state === "error";
  const isEmpty = dataset.state === "empty" || artifact === null;

  return (
    <section
      className="artifact-detail"
      data-route="run.artifactDetail"
      data-testid="artifact-detail-route"
      data-fixture-state={dataset.state}
      aria-labelledby="artifact-detail-title"
    >
      <header className="artifact-detail__header">
        <h2 id="artifact-detail-title">Artifact Detail</h2>
        <p
          className="artifact-detail__fixture-banner"
          data-testid="artifact-detail-fixture-banner"
        >
          {FIXTURE_BANNER_LABEL} · {dataset.label}
        </p>
        {artifact !== null ? (
          <Link
            to={pathForRunEvidence(artifact.planId)}
            data-testid="artifact-detail-back-link"
          >
            Back to evidence
          </Link>
        ) : null}
      </header>

      {isError ? (
        <div
          className="artifact-detail__error"
          role="alert"
          data-testid="artifact-detail-error"
        >
          <p className="artifact-detail__error-title">
            Failed to load artifact (HTTP {dataset.error.status})
          </p>
          <p className="artifact-detail__error-message">
            {dataset.error.message}
          </p>
        </div>
      ) : null}

      {isEmpty && !isError ? (
        <p className="artifact-detail__empty" data-testid="artifact-detail-empty">
          No artifact is selected.
        </p>
      ) : null}

      {artifact !== null ? (
        <article
          className="artifact-detail__body"
          data-testid="artifact-detail-body"
        >
          <header className="artifact-detail__body-header">
            <h3>{artifact.title}</h3>
            <dl>
              <dt>artifact id</dt>
              <dd data-testid="artifact-detail-id">{artifact.id}</dd>
              <dt>kind</dt>
              <dd>{artifact.kind}</dd>
              <dt>content type</dt>
              <dd data-testid="artifact-detail-content-type">
                {artifact.contentType}
              </dd>
              <dt>created at</dt>
              <dd>{artifact.createdAt}</dd>
              <dt>byte length</dt>
              <dd>{artifact.byteLength}</dd>
            </dl>
          </header>
          <pre
            className="artifact-detail__content"
            data-testid="artifact-detail-content"
          >
            {artifact.body}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
