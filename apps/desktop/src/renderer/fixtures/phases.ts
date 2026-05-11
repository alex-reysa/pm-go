/**
 * Fixtures for the Plan / Phases route.
 *
 * Backed conceptually by `GET /phases?planId` (list) and
 * `GET /phases/:phaseId` (detail expansion). Each phase carries
 * a pre-joined `taskCountsByStatus` so the cockpit can render
 * progress without round-tripping to `GET /tasks?planId`.
 */

import type {
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  PhaseStatus,
  TaskStatus,
} from "./types.js";

/**
 * Counts of phase tasks bucketed by status. Mirrors the nice-to-have
 * field documented in 05-api-integration.md's API gap table; M3
 * can derive this client-side or accept it from the API when
 * the server-side field lands.
 */
export type TaskCountsByStatus = Partial<Record<TaskStatus, number>>;

/** Latest merge-run summary attached to a phase when one exists. */
export interface PhaseMergeRunRef {
  id: FixtureId;
  index: number;
  completedAt: IsoTimestamp | null;
  integrationHead: string | null;
  outcome: "succeeded" | "failed" | "in_progress";
}

/** Latest phase-audit-report summary attached to a phase when one exists. */
export interface PhaseAuditRef {
  id: FixtureId;
  index: number;
  generatedAt: IsoTimestamp;
  outcome: "pass" | "changes_requested" | "blocked";
  summary: string;
}

/**
 * `PhaseSummary` is the read model the Plan/Phases route renders.
 * Tracks 05-api-integration.md § "PhaseSummary".
 */
export interface PhaseSummary {
  id: FixtureId;
  planId: FixtureId;
  index: number;
  title: string;
  summary: string;
  status: PhaseStatus;
  integrationBranch: string | null;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  phaseAuditReportId: FixtureId | null;
  taskCountsByStatus: TaskCountsByStatus;
  latestMergeRun: PhaseMergeRunRef | null;
  latestPhaseAudit: PhaseAuditRef | null;
}

/** Phase list is the array a route renders. */
export type PhasesList = PhaseSummary[];

const PHASES_HAPPY: PhasesList = [
  {
    id: "phase_01HVQX8001FOUNDATION0",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    index: 0,
    title: "Foundation: typed fixture module",
    summary: "Per-domain typed mock data + banner constant.",
    status: "completed",
    integrationBranch: "phase-0-foundation",
    startedAt: "2026-05-09T13:10:00.000Z",
    completedAt: "2026-05-10T20:14:33.000Z",
    phaseAuditReportId: "pa_01HVQX9100AUDITPASS0",
    taskCountsByStatus: { merged: 2 },
    latestMergeRun: {
      id: "mr_01HVQX9100MR000PHASE0",
      index: 1,
      completedAt: "2026-05-10T19:55:00.000Z",
      integrationHead: "abc1234deadbeef0001",
      outcome: "succeeded",
    },
    latestPhaseAudit: {
      id: "pa_01HVQX9100AUDITPASS0",
      index: 1,
      generatedAt: "2026-05-10T20:14:33.000Z",
      outcome: "pass",
      summary: "Fixture module + banner accepted. No drift findings.",
    },
  },
  {
    id: "phase_01HVQX8002ROUTESURFACE",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    index: 1,
    title: "Per-route surfaces",
    summary: "Wire each top-level route + selected-run sub-routes to fixtures.",
    status: "executing",
    integrationBranch: "phase-1-routes",
    startedAt: "2026-05-11T07:00:00.000Z",
    completedAt: null,
    phaseAuditReportId: null,
    taskCountsByStatus: {
      ready: 1,
      running: 1,
      in_review: 1,
      ready_to_merge: 0,
      blocked: 0,
    },
    latestMergeRun: null,
    latestPhaseAudit: null,
  },
  {
    id: "phase_01HVQX8003CONFAUDIT00",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    index: 2,
    title: "Confirm-modal + audit coverage",
    summary: "Confirmation pattern + route-level smoke tests.",
    status: "pending",
    integrationBranch: null,
    startedAt: null,
    completedAt: null,
    phaseAuditReportId: null,
    taskCountsByStatus: { pending: 2 },
    latestMergeRun: null,
    latestPhaseAudit: null,
  },
];

export const phasesHappyPath: FixtureDataset<PhasesList> = {
  state: "happy",
  label: "phases · 3 phases across completed/executing/pending",
  data: PHASES_HAPPY,
};

export const phasesEmptyState: FixtureDataset<PhasesList> = {
  state: "empty",
  label: "phases · plan exists but planner has emitted no phases",
  data: [],
};

export const phasesErrorState: FixtureDataset<PhasesList> = {
  state: "error",
  label: "phases · 500 from /phases",
  data: [],
  error: {
    status: 500,
    message: "internal server error while listing phases",
    body: { error: "internal_error" },
  },
};
