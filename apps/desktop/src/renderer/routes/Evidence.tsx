/**
 * Run-scoped Evidence route.
 *
 * Renders completion-audit evidence, review/audit artifact groupings,
 * and release artifact bodies from M2 fixtures. Artifact bodies stay
 * inert: this route shows fetched text inside `<pre>` blocks and links
 * to the artifact-detail route for focused inspection.
 */

import React from "react";
import { Link } from "react-router-dom";

import {
  FIXTURE_BANNER_LABEL,
  type ArtifactKind,
  type EvidenceArtifactContent,
  type EvidenceBundleView,
  type FixtureDataset,
} from "../fixtures/index.js";
import { pathForArtifactDetail } from "../router/routes.js";

export interface EvidenceRouteProps {
  readonly dataset: FixtureDataset<EvidenceBundleView>;
}

type EvidenceGroupId = "audits" | "reviews" | "release" | "other";

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

function groupForKind(kind: ArtifactKind): EvidenceGroupId {
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
    case "other":
      return "other";
  }
}

function artifactsByGroup(
  artifacts: readonly EvidenceArtifactContent[],
): Record<EvidenceGroupId, EvidenceArtifactContent[]> {
  const grouped: Record<EvidenceGroupId, EvidenceArtifactContent[]> = {
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

export function Evidence(props: EvidenceRouteProps): React.JSX.Element {
  const { dataset } = props;
  const view = dataset.data;
  const groupedArtifacts = artifactsByGroup(view.artifactContents);
  const isError = dataset.state === "error";
  const isEmpty =
    dataset.state === "empty" &&
    view.completionAudit === null &&
    view.checklist.length === 0 &&
    view.findings.length === 0 &&
    view.artifactContents.length === 0;

  return (
    <section
      className="evidence"
      data-route="run.evidence"
      data-testid="evidence-route"
      data-fixture-state={dataset.state}
      aria-labelledby="evidence-title"
    >
      <header className="evidence__header">
        <h2 id="evidence-title">Evidence</h2>
        <p
          className="evidence__fixture-banner"
          data-testid="evidence-fixture-banner"
        >
          {FIXTURE_BANNER_LABEL} · {dataset.label}
        </p>
      </header>

      {isError ? (
        <div
          className="evidence__error"
          role="alert"
          data-testid="evidence-error"
        >
          <p className="evidence__error-title">
            Failed to load evidence (HTTP {dataset.error.status})
          </p>
          <p className="evidence__error-message">{dataset.error.message}</p>
        </div>
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
            <dd>{view.completionAudit.generatedAt}</dd>
            <dt>summary</dt>
            <dd>{view.completionAudit.summary}</dd>
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
            {view.checklist.map((row) => (
              <li
                key={row.id}
                data-testid={`evidence-checklist-row-${row.id}`}
                data-outcome={row.outcome}
              >
                <span>{row.title}</span>
                <span> · {row.outcome}</span>
                {row.evidenceRef !== null ? (
                  <span> · {row.evidenceRef}</span>
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
            {view.findings.map((finding) => (
              <li
                key={finding.id}
                data-testid={`evidence-finding-${finding.id}`}
                data-severity={finding.severity}
              >
                <strong>{finding.title}</strong>
                <p>{finding.message}</p>
                {finding.filePath !== null ? (
                  <p>
                    {finding.filePath}
                    {finding.line !== null ? `:${finding.line}` : ""}
                  </p>
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
                        <dd>{artifact.kind}</dd>
                        <dt>content type</dt>
                        <dd>{artifact.contentType}</dd>
                        <dt>fetched at</dt>
                        <dd>{artifact.fetchedAt}</dd>
                      </dl>
                      <pre
                        className="evidence__artifact-preview"
                        data-testid={`evidence-artifact-${artifact.id}-preview`}
                      >
                        {artifact.body}
                      </pre>
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
    </section>
  );
}
