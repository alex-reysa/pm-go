/**
 * Fixtures for the Approvals queue route.
 *
 * Backed conceptually by `GET /approvals?planId`. Each row carries
 * the joined task / phase context the cockpit row needs (taskTitle,
 * phaseTitle) since 05-api-integration.md flags those as derived
 * fields the renderer composes after listing approvals.
 */

import type {
  ApprovalStatus,
  ApprovalSubject,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  RiskBand,
} from "./types.js";

/**
 * `ApprovalQueueItem` is the row shape the Approvals route renders.
 * Tracks 05-api-integration.md § "ApprovalQueueItem".
 */
export interface ApprovalQueueItem {
  id: FixtureId;
  planId: FixtureId;
  taskId: FixtureId | null;
  phaseId: FixtureId | null;
  subject: ApprovalSubject;
  riskBand: RiskBand;
  status: ApprovalStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  requestedAt: IsoTimestamp;
  decidedAt: IsoTimestamp | null;
  reason: string | null;
  /** Joined task title for display, when subject === "task". */
  taskTitle: string | null;
  taskSlug: string | null;
  /** Joined phase title for display, when subject === "phase" or for task rows. */
  phaseTitle: string | null;
  /** Hint for the bulk-approve UI — server still decides. */
  isBulkEligible: boolean;
  /** Populated by `POST /plans/:id/approve-all-pending` skip reasons. */
  bulkSkippedReason: string | null;
}

export type ApprovalsList = ApprovalQueueItem[];

const APPROVALS_HAPPY: ApprovalsList = [
  {
    id: "appr_01HVQXB001TASKAPPRV01",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: "task_01HVQX9003ROUTES0000",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    subject: "task",
    riskBand: "medium",
    status: "pending",
    requestedBy: "reviewer-agent",
    approvedBy: null,
    requestedAt: "2026-05-11T09:00:01.000Z",
    decidedAt: null,
    reason: null,
    taskTitle: "Wire react-router route shell + selected-run subroutes",
    taskSlug: "route-shell",
    phaseTitle: "Per-route surfaces",
    isBulkEligible: true,
    bulkSkippedReason: null,
  },
  {
    id: "appr_01HVQXB002TASKAPPRV02",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: "task_01HVQX9004APPROVALS0",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    subject: "task",
    riskBand: "medium",
    status: "pending",
    requestedBy: "reviewer-agent",
    approvedBy: null,
    requestedAt: "2026-05-11T09:11:15.000Z",
    decidedAt: null,
    reason: null,
    taskTitle: "Approvals queue route + bulk-approve modal",
    taskSlug: "approvals-route",
    phaseTitle: "Per-route surfaces",
    // Catastrophic-pattern marker: this row has a "danger" risk
    // signal so the bulk-approve flow should skip it server-side.
    isBulkEligible: false,
    bulkSkippedReason: null,
  },
  {
    id: "appr_01HVQXB003PHASEOVRRD3",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    taskId: null,
    phaseId: "phase_01HVQX8001FOUNDATION0",
    subject: "phase",
    riskBand: "low",
    status: "approved",
    requestedBy: "phase-auditor",
    approvedBy: "operator",
    requestedAt: "2026-05-10T20:14:00.000Z",
    decidedAt: "2026-05-10T20:18:24.000Z",
    reason: "Audit pass; one-line fix in fixture banner.",
    taskTitle: null,
    taskSlug: null,
    phaseTitle: "Foundation: typed fixture module",
    isBulkEligible: false,
    bulkSkippedReason: null,
  },
];

export const approvalsHappyPath: FixtureDataset<ApprovalsList> = {
  state: "happy",
  label: "approvals · 2 pending + 1 historical",
  data: APPROVALS_HAPPY,
};

export const approvalsEmptyState: FixtureDataset<ApprovalsList> = {
  state: "empty",
  label: "approvals · queue is clear",
  data: [],
};

export const approvalsErrorState: FixtureDataset<ApprovalsList> = {
  state: "error",
  label: "approvals · 403 from /approvals",
  data: [],
  error: {
    status: 403,
    message: "operator session lacks approvals scope",
    body: { error: "forbidden" },
  },
};
