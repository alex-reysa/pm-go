/**
 * Fixtures for the Artifact-detail route and the artifact-summary
 * surfaces (cockpit + evidence routes).
 *
 * Backed conceptually by `GET /artifacts/:id` plus the artifact-id
 * lists returned by plan detail and `artifact_persisted` events.
 * 05-api-integration.md flags the artifact metadata gap — we
 * pre-bake `kind`, `title`, `createdAt`, and `contentType` so the
 * M2 route can render plausibly without speculating on an
 * artifact-metadata endpoint.
 */

import type {
  ArtifactKind,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
} from "./types.js";

/**
 * `ArtifactSummary` is the row shape the artifact list renders.
 * Tracks 05-api-integration.md § "ArtifactSummary".
 */
export interface ArtifactSummary {
  id: FixtureId;
  kind: ArtifactKind;
  title: string;
  planId: FixtureId;
  taskId: FixtureId | null;
  phaseId: FixtureId | null;
  createdAt: IsoTimestamp;
  contentType: "text/markdown" | "application/json" | "text/plain";
  fetchStatus: "idle" | "loading" | "loaded" | "errored";
  /**
   * Trusted-path open state. Always null at M2 — the renderer must
   * never accept a renderer-derived path. M5 will populate this
   * via a main-process validation round-trip.
   */
  trustedOpenState: null;
}

/**
 * `ArtifactDetail` is the read model for the Artifact-detail
 * route. Adds the inert content body to the summary fields.
 */
export interface ArtifactDetail extends ArtifactSummary {
  /**
   * Rendered inertly: no raw HTML execution, no remote image
   * loads, sanitized links only. M5 will run Markdown through a
   * sanitizer; M2 fixtures already produce safe-by-default
   * content.
   */
  body: string;
  /** Server-reported byte length, for the viewer's footer chrome. */
  byteLength: number;
}

export type ArtifactsList = ArtifactSummary[];

const ARTIFACTS_HAPPY: ArtifactsList = [
  {
    id: "art_01HVQXA001PRSUMMARY0",
    kind: "pr_summary",
    title: "PR summary — fixture module",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: "task_01HVQX9001FIXTURES000",
    phaseId: "phase_01HVQX8001FOUNDATION0",
    createdAt: "2026-05-10T20:14:00.000Z",
    contentType: "text/markdown",
    fetchStatus: "idle",
    trustedOpenState: null,
  },
  {
    id: "art_01HVQXA002REVIEWREP00",
    kind: "review_report",
    title: "Review report — route-shell cycle 1",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: "task_01HVQX9003ROUTES0000",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    createdAt: "2026-05-11T08:59:12.000Z",
    contentType: "application/json",
    fetchStatus: "loaded",
    trustedOpenState: null,
  },
  {
    id: "art_01HVQXA003MERGE000001",
    kind: "merge_run_summary",
    title: "Merge run — phase 0 integration",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: null,
    phaseId: "phase_01HVQX8001FOUNDATION0",
    createdAt: "2026-05-10T19:55:00.000Z",
    contentType: "text/plain",
    fetchStatus: "idle",
    trustedOpenState: null,
  },
];

export const artifactsHappyPath: FixtureDataset<ArtifactsList> = {
  state: "happy",
  label: "artifacts · 3 typed artifacts across kinds",
  data: ARTIFACTS_HAPPY,
};

export const artifactsEmptyState: FixtureDataset<ArtifactsList> = {
  state: "empty",
  label: "artifacts · plan has not produced artifacts yet",
  data: [],
};

export const artifactsErrorState: FixtureDataset<ArtifactsList> = {
  state: "error",
  label: "artifacts · 500 listing artifacts",
  data: [],
  error: {
    status: 500,
    message: "failed to list artifacts",
    body: { error: "internal_error" },
  },
};

/** Sample populated artifact detail for the Artifact-detail route. */
export const artifactDetailHappyPath: FixtureDataset<ArtifactDetail> = {
  state: "happy",
  label: "artifact detail · markdown PR summary",
  data: {
    id: "art_01HVQXA001PRSUMMARY0",
    kind: "pr_summary",
    title: "PR summary — fixture module",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: "task_01HVQX9001FIXTURES000",
    phaseId: "phase_01HVQX8001FOUNDATION0",
    createdAt: "2026-05-10T20:14:00.000Z",
    contentType: "text/markdown",
    fetchStatus: "loaded",
    trustedOpenState: null,
    body:
      "# Fixture module\n\nPer-domain typed mock data + banner constant. M3 will swap consumers route-by-route.\n\n## Domains\n\n- runs, plan, phases, tasks, approvals, budget, evidence, artifacts, release, events.\n",
    byteLength: 198,
  },
};

export const artifactDetailEmptyState: FixtureDataset<ArtifactDetail | null> = {
  state: "empty",
  label: "artifact detail · no artifact selected",
  data: null,
};

export const artifactDetailErrorState: FixtureDataset<ArtifactDetail | null> = {
  state: "error",
  label: "artifact detail · 403 from /artifacts/:id",
  data: null,
  error: {
    status: 403,
    message: "artifact path containment check failed on the API",
    body: { error: "artifact_forbidden" },
  },
};
