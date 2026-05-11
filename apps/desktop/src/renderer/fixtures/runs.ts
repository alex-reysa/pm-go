/**
 * Fixtures for the Runs List route.
 *
 * Backed conceptually by `GET /plans` (with the nice-to-have
 * `attention` summary fields from 05-api-integration.md gap table
 * pre-applied so the cockpit can demo attention badges without
 * waiting on the API gap to land). M3 will drop the `attention`
 * derivation back to a client-side join when it consumes the live
 * route.
 */

import type {
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  PlanStatus,
  RiskBand,
} from "./types.js";

/**
 * `RunSummary` is the read model the Runs List route renders. It
 * mirrors the shape in 05-api-integration.md § "RunSummary"
 * (plus the `attention` nice-to-have so badges are demoable now).
 */
export interface RunSummary {
  id: FixtureId;
  title: string;
  summary: string;
  status: PlanStatus;
  riskLevels: RiskBand[];
  hasCompletionAudit: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Pre-joined cockpit-attention summary so the list can render badges. */
  attention: {
    pendingApprovals: number;
    blockedTasks: number;
    failedTasks: number;
    blockedPhases: number;
    releaseReady: boolean;
  };
}

/** The Runs List is a chronological array of run summaries. */
export type RunsList = RunSummary[];

const RUNS_HAPPY: RunsList = [
  {
    id: "plan_01HVQX7AA4B0EXEC1NG",
    title: "Add typed fixture module for M2 routes",
    summary:
      "Foundation work: per-domain typed mock data + banner that every consuming route surfaces in the UI.",
    status: "executing",
    riskLevels: ["medium", "low"],
    hasCompletionAudit: false,
    createdAt: "2026-05-09T13:04:22.000Z",
    updatedAt: "2026-05-11T09:18:51.000Z",
    attention: {
      pendingApprovals: 1,
      blockedTasks: 0,
      failedTasks: 0,
      blockedPhases: 0,
      releaseReady: false,
    },
  },
  {
    id: "plan_01HVQX9BB6C1FYAUD2RD",
    title: "Audit completion bundle generator",
    summary:
      "Phase 2 audit returned changes_requested on the evidence bundle artifact. Approvals queued for operator review.",
    status: "auditing",
    riskLevels: ["high", "medium"],
    hasCompletionAudit: false,
    createdAt: "2026-05-08T18:01:00.000Z",
    updatedAt: "2026-05-11T07:42:11.000Z",
    attention: {
      pendingApprovals: 2,
      blockedTasks: 0,
      failedTasks: 0,
      blockedPhases: 1,
      releaseReady: false,
    },
  },
  {
    id: "plan_01HVQXBCC7D2GZREL3SE",
    title: "Release v0.8.9 — health identity & desktop attach",
    summary:
      "Plan completed; completion audit pass stamped. Release in progress — release artifacts pending.",
    status: "released",
    riskLevels: ["low"],
    hasCompletionAudit: true,
    createdAt: "2026-04-30T11:22:09.000Z",
    updatedAt: "2026-05-10T21:55:42.000Z",
    attention: {
      pendingApprovals: 0,
      blockedTasks: 0,
      failedTasks: 0,
      blockedPhases: 0,
      releaseReady: true,
    },
  },
  {
    id: "plan_01HVQXEFF8E3HBLOCK4F",
    title: "Phase-1 IA wiring (paused)",
    summary:
      "Phase 1 blocked on an override-audit operator decision. Awaiting reasoned override.",
    status: "blocked",
    riskLevels: ["medium"],
    hasCompletionAudit: false,
    createdAt: "2026-05-02T09:00:00.000Z",
    updatedAt: "2026-05-10T16:31:08.000Z",
    attention: {
      pendingApprovals: 0,
      blockedTasks: 3,
      failedTasks: 1,
      blockedPhases: 1,
      releaseReady: false,
    },
  },
];

export const runsHappyPath: FixtureDataset<RunsList> = {
  state: "happy",
  label: "runs · happy path (4 runs across statuses)",
  data: RUNS_HAPPY,
};

export const runsEmptyState: FixtureDataset<RunsList> = {
  state: "empty",
  label: "runs · no runs yet — operator should land on New Spec",
  data: [],
};

export const runsErrorState: FixtureDataset<RunsList> = {
  state: "error",
  label: "runs · 503 from /plans",
  // Empty list so the route renders the error banner without claiming runs exist.
  data: [],
  error: {
    status: 503,
    message: "service unavailable while fetching /plans",
    body: { error: "service_unavailable" },
  },
};
