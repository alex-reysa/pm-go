/**
 * Run-scoped Evidence route.
 *
 * Renders completion-audit evidence, review/audit artifact groupings,
 * and artifact bodies fetched through the Desktop API client. Artifact
 * bodies stay inert: this route shows text inside `<pre>` blocks and
 * links to the artifact-detail route for focused inspection.
 */

import React, { useEffect, useMemo, useState } from "react";
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
  type EvidenceArtifactContent,
  type EvidenceBundleView,
  type FixtureDataset,
} from "../fixtures/index.js";
import {
  buildArtifactEvidence,
  type ArtifactFetchPayload,
  type ArtifactSummaryViewModel,
  type EvidenceBundleViewModel,
  type ReadModelEnvelope,
  type RecoverableReadError,
  type WorkflowEvent,
} from "../read-models/index.js";
import { pathForArtifactDetail } from "../router/routes.js";

export interface EvidenceRouteProps {
  readonly dataset: FixtureDataset<EvidenceBundleView>;
  /** Optional API client override for route-level tests. */
  readonly apiClient?: DesktopApiClient;
  /** Optional selected-run override; production uses the `:planId` route param. */
  readonly planId?: string;
}

type EvidenceGroupId = "audits" | "reviews" | "release" | "other";

type EvidenceView = EvidenceBundleView | EvidenceBundleViewModel;

interface LiveEvidenceState {
  readonly loading: boolean;
  readonly envelope: ReadModelEnvelope<EvidenceBundleViewModel, unknown> | null;
  readonly errors: readonly RecoverableReadError[];
}

interface EvidenceArtifactRow {
  readonly id: string;
  readonly kind: string | null;
  readonly title: string;
  readonly contentType: string | null;
  readonly fetchedAt: string;
  readonly body: string | null;
  readonly error: RecoverableReadError | null;
  readonly limitations: readonly string[];
}

interface EvidenceGroup {
  readonly id: EvidenceGroupId;
  readonly title: string;
  readonly emptyCopy: string;
}

const EVIDENCE_GROUPS: readonly EvidenceGroup[] = [
  {
    id: "audits",
    title: "Audit evidence",
    emptyCopy: "No audit artifacts in this fixture.",
  },
  {
    id: "reviews",
    title: "Review evidence",
    emptyCopy: "No review artifacts in this fixture.",
  },
  {
    id: "release",
    title: "Release artifacts",
    emptyCopy: "No release artifacts in this fixture.",
  },
  {
    id: "other",
    title: "Other artifacts",
    emptyCopy: "No other artifacts in this fixture.",
  },
];

function groupForKind(kind: string | null): EvidenceGroupId {
  switch (kind) {
    case "completion_audit_report":
    case "phase_audit_report":
      return "audits";
    case "review_report":
      return "reviews";
    case "completion_evidence_bundle":
    case "pr_summary":
      return "release";
    case "merge_run_summary":
    case "task_diff":
    case "plan_markdown":
    case "test_report":
    case "event_log":
    case "patch_bundle":
    case "runner_diagnostic":
    case "other":
    case null:
      return "other";
    default:
      return "other";
  }
}

function artifactsByGroup(
  artifacts: readonly EvidenceArtifactRow[],
): Record<EvidenceGroupId, EvidenceArtifactRow[]> {
  const grouped: Record<EvidenceGroupId, EvidenceArtifactRow[]> = {
    audits: [],
    reviews: [],
    release: [],
    other: [],
  };
  for (const artifact of artifacts) {
    grouped[groupForKind(artifact.kind)].push(artifact);
  }
  return grouped;
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
  const label = recoverable ? "Recoverable API read failed" : "API read failed";
  return `${label} (HTTP ${error.status}): ${error.message}`;
}

function artifactBodyFromRead(read: ArtifactRead): string | null {
  switch (read.bodyKind) {
    case "json":
      return JSON.stringify(read.json, null, 2) ?? read.text;
    case "text":
      return read.text;
    case "binary":
      return null;
  }
}

function byteLengthFromRead(read: ArtifactRead): number {
  if (read.contentLength !== null) return read.contentLength;
  if (read.bodyKind === "binary") return read.bytes.byteLength;
  return read.text.length;
}

function fetchPayloadFromRead(read: ArtifactRead): ArtifactFetchPayload {
  return {
    id: read.artifactId,
    contentType: read.contentType,
    body: artifactBodyFromRead(read),
    byteLength: byteLengthFromRead(read),
    raw: read,
  };
}

function artifactIdsFromEvents(events: readonly WorkflowEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<WorkflowEvent, { kind: "artifact_persisted" }> =>
        event.kind === "artifact_persisted",
    )
    .map((event) => event.payload.artifactId);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fixtureArtifactRows(
  artifacts: readonly EvidenceArtifactContent[],
): EvidenceArtifactRow[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    contentType: artifact.contentType,
    fetchedAt: artifact.fetchedAt,
    body: artifact.body,
    error: null,
    limitations: [],
  }));
}

function liveArtifactRow(artifact: ArtifactSummaryViewModel): EvidenceArtifactRow {
  return {
    id: artifact.id,
    kind: artifact.kind.value,
    title: artifact.title.value ?? `Artifact ${artifact.id}`,
    contentType: artifact.contentType.value,
    fetchedAt: artifact.createdAt.value ?? "not returned by the artifact read",
    body: artifact.body,
    error: artifact.raw.fetch?.error ?? null,
    limitations: [
      ...artifact.kind.limitations,
      ...artifact.title.limitations,
      ...artifact.contentType.limitations,
      ...artifact.createdAt.limitations,
      ...artifact.trustedOpenState.limitations,
    ].map((limitation) => limitation.message),
  };
}

function liveArtifactRows(view: EvidenceBundleViewModel): EvidenceArtifactRow[] {
  const byId = new Map<string, EvidenceArtifactRow>();
  for (const artifact of [...view.releaseArtifacts, ...view.artifactContents]) {
    byId.set(artifact.id, liveArtifactRow(artifact));
  }
  for (const fetch of view.raw.artifactFetches) {
    if (byId.has(fetch.id)) continue;
    byId.set(fetch.id, {
      id: fetch.id,
      kind: null,
      title: `Artifact ${fetch.id}`,
      contentType: fetch.contentType,
      fetchedAt: "fetched through GET /artifacts/:id",
      body: fetch.body,
      error: fetch.error ?? null,
      limitations: ["Artifact metadata was not returned by the API."],
    });
  }
  return [...byId.values()];
}

function evidenceArtifactRows(view: EvidenceView): EvidenceArtifactRow[] {
  return "raw" in view
    ? liveArtifactRows(view)
    : fixtureArtifactRows(view.artifactContents);
}

function stringifyDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return json ?? String(value);
}

function fieldAsString(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const fieldValue = record[field];
  return typeof fieldValue === "string" ? fieldValue : null;
}

function checklistId(row: unknown, index: number): string {
  return fieldAsString(row, "id") ?? `checklist-${index}`;
}

function checklistTitle(row: unknown): string {
  return fieldAsString(row, "title") ?? stringifyDisplay(row);
}

function checklistOutcome(row: unknown): string {
  return fieldAsString(row, "outcome") ?? fieldAsString(row, "status") ?? "unknown";
}

function checklistEvidence(row: unknown): string | null {
  const direct = fieldAsString(row, "evidenceRef");
  if (direct !== null) return direct;
  if (typeof row !== "object" || row === null) return null;
  const ids = (row as Record<string, unknown>).evidenceArtifactIds;
  return Array.isArray(ids) && ids.length > 0 ? ids.join(", ") : null;
}

function findingId(row: unknown, index: number): string {
  return fieldAsString(row, "id") ?? `finding-${index}`;
}

function findingTitle(row: unknown): string {
  return fieldAsString(row, "title") ?? "Finding";
}

function findingMessage(row: unknown): string {
  return fieldAsString(row, "message") ?? fieldAsString(row, "summary") ?? "";
}

function findingSeverity(row: unknown): string {
  return fieldAsString(row, "severity") ?? "info";
}

function findingLocation(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const filePath = typeof record.filePath === "string" ? record.filePath : null;
  if (filePath === null) return null;
  const line =
    typeof record.line === "number"
      ? record.line
      : typeof record.startLine === "number"
        ? record.startLine
        : null;
  return line === null ? filePath : `${filePath}:${line}`;
}

function auditGeneratedAt(audit: NonNullable<EvidenceView["completionAudit"]>): string {
  return "generatedAt" in audit ? audit.generatedAt : audit.createdAt;
}

function auditSummary(audit: NonNullable<EvidenceView["completionAudit"]>): string {
  return stringifyDisplay(audit.summary);
}

export function Evidence(props: EvidenceRouteProps): React.JSX.Element {
  const { dataset } = props;
  const routeParams = useParams();
  const planId = props.planId ?? routeParams.planId ?? dataset.data.planId;
  const [liveState, setLiveState] = useState<LiveEvidenceState>({
    loading: false,
    envelope: null,
    errors: [],
  });

  useEffect(() => {
    if (planId === "") return;
    let cancelled = false;
    setLiveState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const api = await getDesktopApiClient(props.apiClient);
        const [planResult, eventsResult] = await Promise.allSettled([
          api.getPlan(planId),
          api.replayEvents(planId),
        ]);
        if (cancelled) return;

        const planError =
          planResult.status === "rejected"
            ? recoverableErrorFromUnknown(planResult.reason)
            : null;
        const eventsError =
          eventsResult.status === "rejected"
            ? recoverableErrorFromUnknown(eventsResult.reason)
            : null;
        const planDetail =
          planResult.status === "fulfilled" ? planResult.value : undefined;
        const events =
          eventsResult.status === "fulfilled" ? eventsResult.value.events : [];
        const artifactIds = uniqueStrings([
          ...(planDetail?.artifactIds ?? []),
          ...artifactIdsFromEvents(events),
        ]);
        const fetches = await Promise.all(
          artifactIds.map(async (id): Promise<ArtifactFetchPayload> => {
            try {
              return fetchPayloadFromRead(await api.readArtifact(id));
            } catch (error) {
              return {
                id,
                contentType: null,
                body: null,
                error: recoverableErrorFromUnknown(error),
              };
            }
          }),
        );
        if (cancelled) return;

        const fetchErrors = fetches
          .map((fetch) => fetch.error ?? null)
          .filter((error): error is RecoverableReadError => error !== null);
        const allErrors = [planError, eventsError, ...fetchErrors].filter(
          (error): error is RecoverableReadError => error !== null,
        );
        const envelope = buildArtifactEvidence({
          planId,
          artifactIds,
          fetches,
          ...(planDetail !== undefined ? { planDetail } : {}),
          ...(eventsResult.status === "fulfilled" ? { events } : {}),
          ...(allErrors[0] !== undefined ? { error: allErrors[0] } : {}),
        });

        setLiveState({
          loading: false,
          envelope,
          errors: allErrors,
        });
      } catch (error) {
        if (cancelled) return;
        const readError = recoverableErrorFromUnknown(error);
        setLiveState({
          loading: false,
          envelope: buildArtifactEvidence({ planId, error: readError }),
          errors: [readError],
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [planId, props.apiClient]);

  const hasLiveRead = liveState.envelope !== null || liveState.loading;
  const view: EvidenceView = liveState.envelope?.data ?? dataset.data;
  const artifactRows = useMemo(() => evidenceArtifactRows(view), [view]);
  const groupedArtifacts = useMemo(
    () => artifactsByGroup(artifactRows),
    [artifactRows],
  );
  const isError = liveState.errors.length > 0 || (!hasLiveRead && dataset.state === "error");
  const isEmpty =
    (hasLiveRead ? liveState.envelope?.state === "empty" : dataset.state === "empty") &&
    view.completionAudit === null &&
    view.checklist.length === 0 &&
    view.findings.length === 0 &&
    artifactRows.length === 0;
  const sourceLabel = hasLiveRead
    ? liveState.loading
      ? "Desktop API live · loading"
      : "Desktop API live"
    : FIXTURE_BANNER_LABEL;
  const errorMessages =
    liveState.errors.length > 0
      ? liveState.errors.map(formatReadError)
      : dataset.state === "error"
        ? [`Failed to load evidence (HTTP ${dataset.error.status}): ${dataset.error.message}`]
        : [];
  const limitations = liveState.envelope?.limitations ?? [];

  return (
    <section
      className="evidence"
      data-route="run.evidence"
      data-testid="evidence-route"
      data-fixture-state={hasLiveRead ? (liveState.envelope?.state ?? "loading") : dataset.state}
      aria-labelledby="evidence-title"
    >
      <header className="evidence__header">
        <h2 id="evidence-title">Evidence</h2>
        <p
          className="evidence__fixture-banner"
          data-testid="evidence-fixture-banner"
        >
          {sourceLabel}
          {!hasLiveRead ? ` · ${dataset.label}` : null}
        </p>
      </header>

      {isError ? (
        <div
          className="evidence__error"
          role="alert"
          data-testid="evidence-error"
        >
          <p className="evidence__error-title">
            Evidence read has recoverable API errors
          </p>
          <p className="evidence__error-message">
            {errorMessages.join(" · ")}
          </p>
        </div>
      ) : null}

      {liveState.loading ? (
        <p className="evidence__empty" role="status">
          Loading evidence.
        </p>
      ) : null}

      {isEmpty ? (
        <p className="evidence__empty" data-testid="evidence-empty">
          No completion audit evidence has been recorded yet.
        </p>
      ) : null}

      <section
        className="evidence__audit"
        aria-label="Completion audit"
        data-testid="evidence-audit"
      >
        <h3>Completion audit</h3>
        {view.completionAudit !== null ? (
          <dl>
            <dt>audit id</dt>
            <dd data-testid="evidence-audit-id">{view.completionAudit.id}</dd>
            <dt>outcome</dt>
            <dd data-testid="evidence-audit-outcome">
              {view.completionAudit.outcome}
            </dd>
            <dt>generated at</dt>
            <dd>{auditGeneratedAt(view.completionAudit)}</dd>
            <dt>summary</dt>
            <dd>{auditSummary(view.completionAudit)}</dd>
          </dl>
        ) : (
          <p data-testid="evidence-audit-empty">
            Completion audit has not run for this fixture.
          </p>
        )}
      </section>

      <section
        className="evidence__checklist"
        aria-label="Completion checklist"
        data-testid="evidence-checklist"
      >
        <h3>Checklist</h3>
        {view.checklist.length > 0 ? (
          <ul>
            {view.checklist.map((row, index) => (
              <li
                key={checklistId(row, index)}
                data-testid={`evidence-checklist-row-${checklistId(row, index)}`}
                data-outcome={checklistOutcome(row)}
              >
                <span>{checklistTitle(row)}</span>
                <span> · {checklistOutcome(row)}</span>
                {checklistEvidence(row) !== null ? (
                  <span> · {checklistEvidence(row)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="evidence-checklist-empty">
            No checklist rows in this fixture.
          </p>
        )}
      </section>

      <section
        className="evidence__findings"
        aria-label="Audit findings"
        data-testid="evidence-findings"
      >
        <h3>Findings</h3>
        {view.findings.length > 0 ? (
          <ul>
            {view.findings.map((finding, index) => (
              <li
                key={findingId(finding, index)}
                data-testid={`evidence-finding-${findingId(finding, index)}`}
                data-severity={findingSeverity(finding)}
              >
                <strong>{findingTitle(finding)}</strong>
                <p>{findingMessage(finding)}</p>
                {findingLocation(finding) !== null ? (
                  <p>{findingLocation(finding)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="evidence-findings-empty">
            No audit findings in this fixture.
          </p>
        )}
      </section>

      <section
        className="evidence__artifacts"
        aria-label="Artifact evidence grouped by context"
        data-testid="evidence-artifacts"
      >
        <h3>Artifacts</h3>
        {EVIDENCE_GROUPS.map((group) => {
          const artifacts = groupedArtifacts[group.id];
          return (
            <section
              key={group.id}
              className="evidence__artifact-group"
              data-testid={`evidence-artifact-group-${group.id}`}
              aria-label={group.title}
            >
              <h4>{group.title}</h4>
              {artifacts.length > 0 ? (
                <ul>
                  {artifacts.map((artifact) => (
                    <li
                      key={artifact.id}
                      data-testid={`evidence-artifact-${artifact.id}`}
                    >
                      <Link
                        to={pathForArtifactDetail(view.planId, artifact.id)}
                        data-testid={`evidence-artifact-${artifact.id}-link`}
                      >
                        {artifact.title}
                      </Link>
                      <dl>
                        <dt>kind</dt>
                        <dd>{artifact.kind ?? "not returned"}</dd>
                        <dt>content type</dt>
                        <dd>{artifact.contentType ?? "not returned"}</dd>
                        <dt>fetched at</dt>
                        <dd>{artifact.fetchedAt}</dd>
                      </dl>
                      {artifact.error !== null ? (
                        <p
                          className="evidence__artifact-error"
                          data-testid={`evidence-artifact-${artifact.id}-error`}
                        >
                          {formatReadError(artifact.error)}
                        </p>
                      ) : (
                        <pre
                          className="evidence__artifact-preview"
                          data-testid={`evidence-artifact-${artifact.id}-preview`}
                        >
                          {artifact.body ??
                            "Artifact content is binary or unavailable; no inert text preview can be rendered."}
                        </pre>
                      )}
                      {artifact.limitations.length > 0 ? (
                        <ul
                          className="evidence__artifact-limitations"
                          data-testid={`evidence-artifact-${artifact.id}-limitations`}
                        >
                          {artifact.limitations.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-testid={`evidence-artifact-group-${group.id}-empty`}>
                  {group.emptyCopy}
                </p>
              )}
            </section>
          );
        })}
      </section>

      {limitations.length > 0 ? (
        <section
          className="evidence__limitations"
          data-testid="evidence-limitations"
          aria-label="Recoverable limitations"
        >
          <h3>Recoverable limitations</h3>
          <ul>
            {limitations.map((limitation) => (
              <li
                key={`${limitation.code}-${limitation.source}-${limitation.field ?? ""}-${limitation.message}`}
              >
                {limitation.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
