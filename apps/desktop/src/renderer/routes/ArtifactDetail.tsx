/**
 * Run-scoped Artifact Detail route.
 *
 * Renders artifact content fetched through the Desktop API client.
 * Text, JSON, and Markdown stay inert inside preformatted text; the
 * route never injects raw HTML or follows artifact URIs.
 */

import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  ApiConfigurationError,
  ApiError,
  createDesktopApiClientFromConfig,
  type ArtifactRead,
  type DesktopApiClient,
} from "../api/index.js";
import {
  FIXTURE_BANNER_LABEL,
  type ArtifactDetail as ArtifactDetailView,
  type FixtureDataset,
} from "../fixtures/index.js";
import type { RecoverableReadError } from "../read-models/index.js";
import { pathForRunEvidence } from "../router/routes.js";

export interface ArtifactDetailRouteProps {
  readonly dataset: FixtureDataset<ArtifactDetailView | null>;
  /** Optional API client override for route-level tests. */
  readonly apiClient?: DesktopApiClient;
  /** Optional artifact override; production uses the `:artifactId` route param. */
  readonly artifactId?: string;
  /** Optional plan override; production uses the `:planId` route param. */
  readonly planId?: string;
}

interface LiveArtifactState {
  readonly loading: boolean;
  readonly artifact: ArtifactRead | null;
  readonly error: RecoverableReadError | null;
}

async function getDesktopApiClient(
  override: DesktopApiClient | undefined,
): Promise<DesktopApiClient> {
  if (override !== undefined) return override;
  if (typeof window === "undefined" || window.pmGoDesktop === undefined) {
    throw new ApiConfigurationError("Desktop bridge is unavailable.");
  }
  return createDesktopApiClientFromConfig(await window.pmGoDesktop.getConfig());
}

function recoverableErrorFromUnknown(error: unknown): RecoverableReadError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      message: error.message,
      body: error.body,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      raw: error,
    };
  }
  if (error instanceof Error) {
    return { status: 0, message: error.message, raw: error };
  }
  return { status: 0, message: "Unknown Desktop API error.", raw: error };
}

function formatReadError(error: RecoverableReadError): string {
  const recoverable =
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status >= 500;
  const label = recoverable ? "Recoverable artifact read failed" : "Artifact read failed";
  return `${label} (HTTP ${error.status}): ${error.message}`;
}

function textForArtifact(read: ArtifactRead): string {
  switch (read.bodyKind) {
    case "json":
      return JSON.stringify(read.json, null, 2) ?? read.text;
    case "text":
      return read.text;
    case "binary":
      return `Binary artifact content (${read.bytes.byteLength} bytes) cannot be rendered safely as text.`;
  }
}

function byteLengthForArtifact(read: ArtifactRead): number {
  if (read.contentLength !== null) return read.contentLength;
  if (read.bodyKind === "binary") return read.bytes.byteLength;
  return read.text.length;
}

export function ArtifactDetail(
  props: ArtifactDetailRouteProps,
): React.JSX.Element {
  const { dataset } = props;
  const routeParams = useParams();
  const artifactId = props.artifactId ?? routeParams.artifactId ?? null;
  const planId = props.planId ?? routeParams.planId ?? dataset.data?.planId ?? null;
  const [liveState, setLiveState] = useState<LiveArtifactState>({
    loading: false,
    artifact: null,
    error: null,
  });

  useEffect(() => {
    if (artifactId === null) return;
    let cancelled = false;
    setLiveState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const api = await getDesktopApiClient(props.apiClient);
        const artifact = await api.readArtifact(artifactId);
        if (cancelled) return;
        setLiveState({ loading: false, artifact, error: null });
      } catch (error) {
        if (cancelled) return;
        setLiveState({
          loading: false,
          artifact: null,
          error: recoverableErrorFromUnknown(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifactId, props.apiClient]);

  const hasLiveRead =
    liveState.loading || liveState.artifact !== null || liveState.error !== null;
  const artifact = hasLiveRead ? null : dataset.data;
  const liveArtifact = liveState.artifact;
  const error = liveState.error;
  const isError = error !== null || (!hasLiveRead && dataset.state === "error");
  const isEmpty =
    (hasLiveRead && liveArtifact === null && error === null && !liveState.loading) ||
    (!hasLiveRead && (dataset.state === "empty" || artifact === null));
  const sourceLabel = hasLiveRead
    ? liveState.loading
      ? "Desktop API live · loading"
      : "Desktop API live"
    : FIXTURE_BANNER_LABEL;
  const contentBody =
    liveArtifact !== null
      ? textForArtifact(liveArtifact)
      : artifact !== null
        ? artifact.body
        : "";
  const contentType =
    liveArtifact !== null
      ? liveArtifact.contentType
      : artifact !== null
        ? artifact.contentType
        : "unknown";
  const renderedArtifactId =
    liveArtifact?.artifactId ?? artifact?.id ?? artifactId ?? "unknown";
  const byteLength =
    liveArtifact !== null
      ? byteLengthForArtifact(liveArtifact)
      : artifact !== null
        ? artifact.byteLength
        : 0;

  return (
    <section
      className="artifact-detail"
      data-route="run.artifactDetail"
      data-testid="artifact-detail-route"
      data-fixture-state={hasLiveRead ? "live" : dataset.state}
      aria-labelledby="artifact-detail-title"
    >
      <header className="artifact-detail__header">
        <h2 id="artifact-detail-title">Artifact Detail</h2>
        <p
          className="artifact-detail__fixture-banner"
          data-testid="artifact-detail-fixture-banner"
        >
          {sourceLabel}
          {!hasLiveRead ? ` · ${dataset.label}` : null}
        </p>
        {planId !== null ? (
          <Link
            to={pathForRunEvidence(planId)}
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
            {error !== null
              ? formatReadError(error)
              : `Failed to load artifact (HTTP ${dataset.state === "error" ? dataset.error.status : 0})`}
          </p>
          <p className="artifact-detail__error-message">
            {error !== null
              ? "The shell and selected run context remain mounted; retry after the API recovers."
              : dataset.state === "error"
                ? dataset.error.message
                : "Artifact is unavailable."}
          </p>
        </div>
      ) : null}

      {liveState.loading ? (
        <p className="artifact-detail__empty" role="status">
          Loading artifact content.
        </p>
      ) : null}

      {isEmpty && !isError ? (
        <p className="artifact-detail__empty" data-testid="artifact-detail-empty">
          No artifact is selected.
        </p>
      ) : null}

      {liveArtifact !== null || artifact !== null ? (
        <article
          className="artifact-detail__body"
          data-testid="artifact-detail-body"
        >
          <header className="artifact-detail__body-header">
            <h3>
              {artifact !== null ? artifact.title : `Artifact ${renderedArtifactId}`}
            </h3>
            <dl>
              <dt>artifact id</dt>
              <dd data-testid="artifact-detail-id">{renderedArtifactId}</dd>
              <dt>kind</dt>
              <dd>{artifact !== null ? artifact.kind : "not returned by GET /artifacts/:id"}</dd>
              <dt>content type</dt>
              <dd data-testid="artifact-detail-content-type">
                {contentType}
              </dd>
              <dt>created at</dt>
              <dd>{artifact !== null ? artifact.createdAt : "not returned by GET /artifacts/:id"}</dd>
              <dt>byte length</dt>
              <dd>{byteLength}</dd>
            </dl>
          </header>
          <pre
            className="artifact-detail__content"
            data-testid="artifact-detail-content"
            data-artifact-body-kind={liveArtifact?.bodyKind ?? "fixture"}
          >
            {contentBody}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
