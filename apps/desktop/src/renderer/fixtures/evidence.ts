/**
 * Fixtures for the Evidence route.
 *
 * Backed conceptually by `GET /completion-audit-reports/:id`,
 * the `latestCompletionAudit` field on plan detail, and fetched
 * artifact bodies from `GET /artifacts/:id`. Each fixture
 * represents the evidence bundle the operator sees right before
 * (or after) a release attempt.
 */

import type {
  ArtifactKind,
  CompletionAuditOutcome,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
} from "./types.js";

/** Single completion-audit checklist row. */
export interface CompletionChecklistRow {
  id: FixtureId;
  title: string;
  outcome: "pass" | "fail" | "skipped";
  evidenceRef: string | null;
}

/** Single completion-audit finding. */
export interface CompletionAuditFinding {
  id: FixtureId;
  severity: "info" | "warn" | "blocker";
  title: string;
  message: string;
  filePath: string | null;
  line: number | null;
}

/** Inert artifact content fetched for evidence rendering. */
export interface EvidenceArtifactContent {
  id: FixtureId;
  kind: ArtifactKind;
  /** Human-friendly title for the viewer chrome. */
  title: string;
  contentType: "text/markdown" | "application/json" | "text/plain";
  /** Rendered inertly: no raw HTML, no remote loads. */
  body: string;
  fetchedAt: IsoTimestamp;
}

/**
 * `EvidenceBundleView` is the read model the Evidence route
 * renders. Tracks 05-api-integration.md § "EvidenceBundleView".
 */
export interface EvidenceBundleView {
  planId: FixtureId;
  completionAudit: {
    id: FixtureId;
    outcome: CompletionAuditOutcome;
    generatedAt: IsoTimestamp;
    summary: string;
  } | null;
  checklist: CompletionChecklistRow[];
  findings: CompletionAuditFinding[];
  releaseArtifactIds: FixtureId[];
  artifactContents: EvidenceArtifactContent[];
  releaseState: "no_audit" | "audit_pending" | "ready_to_release" | "released";
}

const EVIDENCE_HAPPY: EvidenceBundleView = {
  planId: "plan_01HVQXBCC7D2GZREL3SE",
  completionAudit: {
    id: "ca_01HVQXBCC1AUDITPASS00",
    outcome: "pass",
    generatedAt: "2026-05-10T20:50:11.000Z",
    summary:
      "Completion audit passed. All phase audits green; release artifacts ready.",
  },
  checklist: [
    {
      id: "ck_phase_audits_green",
      title: "Every phase audit outcome is pass.",
      outcome: "pass",
      evidenceRef: "phase_audit_reports/all",
    },
    {
      id: "ck_no_failed_tasks",
      title: "No tasks in failed status.",
      outcome: "pass",
      evidenceRef: null,
    },
    {
      id: "ck_release_evidence",
      title: "PR summary + completion evidence bundle artifacts present.",
      outcome: "pass",
      evidenceRef: "artifacts/release",
    },
  ],
  findings: [
    {
      id: "fnd_info_warm_cache",
      severity: "info",
      title: "Cache warm-up note",
      message:
        "First M3 boot will incur a fresh budget snapshot computation; consider pre-warming after release.",
      filePath: null,
      line: null,
    },
  ],
  releaseArtifactIds: [
    "art_01HVQXBCC1PRSUMMARY01",
    "art_01HVQXBCC2COMPBUNDLE1",
  ],
  artifactContents: [
    {
      id: "art_01HVQXBCC1PRSUMMARY01",
      kind: "pr_summary",
      title: "PR summary — v0.8.9 release",
      contentType: "text/markdown",
      body:
        "# v0.8.9\n\n- Health identity envelope landed.\n- Desktop attach-state machine wired.\n- Fixture module prepared for M2.\n",
      fetchedAt: "2026-05-10T20:51:01.000Z",
    },
    {
      id: "art_01HVQXBCC2COMPBUNDLE1",
      kind: "completion_evidence_bundle",
      title: "Completion evidence bundle",
      contentType: "application/json",
      body: JSON.stringify(
        {
          plan: "plan_01HVQXBCC7D2GZREL3SE",
          phases: 3,
          tasks: 12,
          auditsPassed: 3,
        },
        null,
        2,
      ),
      fetchedAt: "2026-05-10T20:51:03.000Z",
    },
  ],
  releaseState: "ready_to_release",
};

const EVIDENCE_EMPTY: EvidenceBundleView = {
  planId: "plan_00000000000000EMPTY00",
  completionAudit: null,
  checklist: [],
  findings: [],
  releaseArtifactIds: [],
  artifactContents: [],
  releaseState: "no_audit",
};

export const evidenceHappyPath: FixtureDataset<EvidenceBundleView> = {
  state: "happy",
  label: "evidence · completion-audit pass + 2 release artifacts",
  data: EVIDENCE_HAPPY,
};

export const evidenceEmptyState: FixtureDataset<EvidenceBundleView> = {
  state: "empty",
  label: "evidence · no completion audit yet",
  data: EVIDENCE_EMPTY,
};

export const evidenceErrorState: FixtureDataset<EvidenceBundleView> = {
  state: "error",
  label: "evidence · 404 from /completion-audit-reports/:id",
  data: EVIDENCE_EMPTY,
  error: {
    status: 404,
    message: "completion audit report not found",
    body: { error: "completion_audit_report_not_found" },
  },
};
