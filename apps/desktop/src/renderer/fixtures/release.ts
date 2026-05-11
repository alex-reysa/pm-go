/**
 * Fixtures for the Release route.
 *
 * Backed conceptually by the latest completion-audit outcome and
 * any release artifact events emitted after `POST /plans/:id/release`.
 * 05-api-integration.md is explicit: the release POST response is
 * NOT proof of success — the route must show "release in progress"
 * until durable artifact / event state confirms it.
 */

import type {
  CompletionAuditOutcome,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  ReleaseStatus,
} from "./types.js";

/**
 * `ReleaseView` is the read model the Release route renders. It
 * pulls together the completion-audit outcome, the release
 * artifacts, and the in-flight workflow run id (if any) so the
 * UI can render a single coherent "release readiness" surface.
 */
export interface ReleaseView {
  planId: FixtureId;
  status: ReleaseStatus;
  completionAuditOutcome: CompletionAuditOutcome | null;
  completionAuditId: FixtureId | null;
  releaseArtifactIds: FixtureId[];
  /** Workflow run id from `POST /plans/:id/release`, when one has been issued. */
  workflowRunId: FixtureId | null;
  /** ISO timestamp of the most recent release attempt. */
  attemptedAt: IsoTimestamp | null;
  /** Operator-facing release notes draft. */
  releaseNotes: string | null;
  /** Indicates that the operator must address blockers before retrying. */
  blockers: Array<{
    id: FixtureId;
    title: string;
    message: string;
  }>;
}

const RELEASE_HAPPY: ReleaseView = {
  planId: "plan_01HVQXBCC7D2GZREL3SE",
  status: "released",
  completionAuditOutcome: "pass",
  completionAuditId: "ca_01HVQXBCC1AUDITPASS00",
  releaseArtifactIds: [
    "art_01HVQXBCC1PRSUMMARY01",
    "art_01HVQXBCC2COMPBUNDLE1",
  ],
  workflowRunId: "wfr_01HVQXBCC9RELEASEWF01",
  attemptedAt: "2026-05-10T21:55:42.000Z",
  releaseNotes:
    "v0.8.9 ships health-identity envelope + Desktop attach state machine. M2 prep (fixtures) lands behind feature gate.",
  blockers: [],
};

const RELEASE_EMPTY: ReleaseView = {
  planId: "plan_00000000000000EMPTY00",
  status: "idle",
  completionAuditOutcome: null,
  completionAuditId: null,
  releaseArtifactIds: [],
  workflowRunId: null,
  attemptedAt: null,
  releaseNotes: null,
  blockers: [],
};

const RELEASE_ERROR: ReleaseView = {
  planId: "plan_01HVQXEFF8E3HBLOCK4F",
  status: "failed",
  completionAuditOutcome: "fail",
  completionAuditId: "ca_01HVQXEFF8AUDITFAIL01",
  releaseArtifactIds: [],
  workflowRunId: null,
  attemptedAt: "2026-05-10T16:25:00.000Z",
  releaseNotes: null,
  blockers: [
    {
      id: "blk_completion_audit_fail",
      title: "Completion audit failed",
      message: "Latest completion audit outcome is fail; release endpoint refused.",
    },
    {
      id: "blk_no_release_artifacts",
      title: "Missing release artifacts",
      message: "No pr_summary or completion_evidence_bundle artifacts persisted.",
    },
  ],
};

export const releaseHappyPath: FixtureDataset<ReleaseView> = {
  state: "happy",
  label: "release · released with audit pass + artifacts",
  data: RELEASE_HAPPY,
};

export const releaseEmptyState: FixtureDataset<ReleaseView> = {
  state: "empty",
  label: "release · plan idle, no audit yet",
  data: RELEASE_EMPTY,
};

export const releaseErrorState: FixtureDataset<ReleaseView> = {
  state: "error",
  label: "release · 409 from /plans/:id/release",
  data: RELEASE_ERROR,
  error: {
    status: 409,
    message: "no passing completion audit stamped on plan",
    body: {
      error: "release_blocked",
      reason: "completion_audit_outcome != pass",
    },
  },
};
