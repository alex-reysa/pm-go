/**
 * Fixtures for the Run-detail / Plan route.
 *
 * Backed conceptually by `GET /plans/:planId`. Each fixture
 * represents the highest-fidelity plan reconstruction the route
 * receives — phases and tasks are referenced by id, not inlined,
 * to keep the route join-discipline honest (the live API returns
 * either inline lists or narrow ids depending on the route).
 */

import type {
  CompletionAuditOutcome,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  PlanStatus,
  RiskBand,
} from "./types.js";

/** Minimal completion-audit summary attached to a plan. */
export interface PlanCompletionAuditRef {
  id: FixtureId;
  outcome: CompletionAuditOutcome;
  generatedAt: IsoTimestamp;
  /** Short headline for cockpit rendering. */
  summary: string;
}

/**
 * `PlanDetail` mirrors `GET /plans/:planId`'s shape:
 * `{ plan, artifactIds, latestCompletionAudit }` flattened into
 * one object that the renderer can consume in one read.
 */
export interface PlanDetail {
  id: FixtureId;
  title: string;
  summary: string;
  status: PlanStatus;
  riskLevels: RiskBand[];
  repoRoot: string;
  specDocumentId: FixtureId;
  repoSnapshotId: FixtureId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Phase ids in cockpit display order. */
  phaseIds: FixtureId[];
  /** Task ids belonging to the plan (full denormalized list). */
  taskIds: FixtureId[];
  /** Artifact ids surfaced by the plan envelope. */
  artifactIds: FixtureId[];
  /** Latest completion-audit summary, when one has been stamped. */
  latestCompletionAudit: PlanCompletionAuditRef | null;
  /** Plan-scope event cursor (last seen id). */
  lastEventId: FixtureId | null;
}

const PLAN_HAPPY: PlanDetail = {
  id: "plan_01HVQX7AA4B0EXEC1NG",
  title: "Add typed fixture module for M2 routes",
  summary:
    "Wire per-domain typed mock data for runs, plan, phases, tasks, approvals, budget, evidence, artifacts, release, and events. Each fixture carries the M3-replacement banner.",
  status: "executing",
  riskLevels: ["medium", "low"],
  repoRoot: "/Users/alejandro/Desktop/999. PROJECTS/pm-go",
  specDocumentId: "spec_01HVQ91234SPECDOC0001",
  repoSnapshotId: "snap_01HVQ91234REPOSNAP001",
  createdAt: "2026-05-09T13:04:22.000Z",
  updatedAt: "2026-05-11T09:18:51.000Z",
  phaseIds: [
    "phase_01HVQX8001FOUNDATION0",
    "phase_01HVQX8002ROUTESURFACE",
    "phase_01HVQX8003CONFAUDIT00",
  ],
  taskIds: [
    "task_01HVQX9001FIXTURES000",
    "task_01HVQX9002BANNER0000",
    "task_01HVQX9003ROUTES0000",
    "task_01HVQX9004APPROVALS0",
    "task_01HVQX9005EVIDENCE00",
  ],
  artifactIds: ["art_01HVQXA001PRSUMMARY0"],
  latestCompletionAudit: null,
  lastEventId: "evt_01HVQXB000LASTSEEN00",
};

const PLAN_EMPTY: PlanDetail = {
  // The "empty" plan represents an attached, freshly-created plan
  // that has no phases or tasks decomposed yet — for example, the
  // moment after `POST /plans` returns but before the planner
  // workflow has emitted its first phase.
  id: "plan_00000000000000EMPTY00",
  title: "Untitled plan",
  summary: "Plan has been created but planner has not emitted phases yet.",
  status: "draft",
  riskLevels: [],
  repoRoot: "/tmp/empty-repo",
  specDocumentId: "spec_00000000000EMPTY00001",
  repoSnapshotId: "snap_00000000000EMPTY00001",
  createdAt: "2026-05-11T09:18:51.000Z",
  updatedAt: "2026-05-11T09:18:51.000Z",
  phaseIds: [],
  taskIds: [],
  artifactIds: [],
  latestCompletionAudit: null,
  lastEventId: null,
};

export const planHappyPath: FixtureDataset<PlanDetail> = {
  state: "happy",
  label: "plan · fully-populated executing plan",
  data: PLAN_HAPPY,
};

export const planEmptyState: FixtureDataset<PlanDetail> = {
  state: "empty",
  label: "plan · attached but no phases yet",
  data: PLAN_EMPTY,
};

export const planErrorState: FixtureDataset<PlanDetail> = {
  state: "error",
  label: "plan · 404 from /plans/:id",
  // Same "empty" plan body so the surrounding nav has SOMETHING
  // to render; the route is expected to show the error inline
  // and prompt for a reload rather than blank the screen.
  data: PLAN_EMPTY,
  error: {
    status: 404,
    message: "plan not found",
    body: { error: "plan_not_found" },
  },
};
