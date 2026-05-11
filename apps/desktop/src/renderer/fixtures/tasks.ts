/**
 * Fixtures for the Tasks and Task-detail routes.
 *
 * Backed conceptually by `GET /tasks?planId` (list) and
 * `GET /tasks/:taskId` (detail). The fixtures denormalize a few
 * fields the API gap table lists as "nice-to-have" (e.g. branch,
 * worktree, latest review state) so the cockpit task rows can
 * render today.
 */

import type {
  ApprovalStatus,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  ReviewOutcome,
  RiskBand,
  TaskKind,
  TaskStatus,
} from "./types.js";

/** Per-task budget summary; mirrors the live budget-report shape. */
export interface TaskBudgetSpend {
  usd: number;
  tokens: number;
  wallClockMinutes: number;
  /** True iff `usd` >= the task's configured max-cost cap. */
  overBudget: boolean;
}

/** Available-action descriptor — see 05-api-integration.md § ActionAvailability. */
export interface TaskActionAvailability {
  action:
    | "task.run"
    | "task.review"
    | "task.fix"
    | "task.approve"
    | "task.overrideReview";
  enabled: boolean;
  reason: string | null;
  requiresConfirmation: true;
  requiresReason: boolean;
  pending: boolean;
}

/**
 * `TaskSummary` is the row shape the Tasks list renders. Tracks
 * 05-api-integration.md § "TaskSummary".
 */
export interface TaskSummary {
  id: FixtureId;
  planId: FixtureId;
  phaseId: FixtureId;
  slug: string;
  title: string;
  status: TaskStatus;
  riskLevel: RiskBand;
  kind: TaskKind;
  approvalStatus: ApprovalStatus | null;
  reviewState: ReviewOutcome | null;
  branchName: string | null;
  budgetSpend: TaskBudgetSpend | null;
  availableActions: TaskActionAvailability[];
}

/** Latest agent-run summary attached to a task. */
export interface TaskAgentRunRef {
  id: FixtureId;
  role: "implementer" | "reviewer" | "phase_auditor" | "completion_auditor";
  startedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  outcome: "succeeded" | "failed" | "in_progress" | "blocked";
  costUsd: number;
}

/** Latest lease attached to a task (branch + worktree). */
export interface TaskLeaseRef {
  id: FixtureId;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  leasedAt: IsoTimestamp;
  releasedAt: IsoTimestamp | null;
}

/** Latest review report attached to a task. */
export interface TaskReviewReportRef {
  id: FixtureId;
  cycleNumber: number;
  outcome: ReviewOutcome;
  generatedAt: IsoTimestamp;
  summary: string;
  findingsCount: number;
}

/**
 * `TaskDetail` is the read model the Task-detail drawer renders.
 * Tracks 05-api-integration.md § "TaskDetail".
 */
export interface TaskDetail extends TaskSummary {
  summary: string;
  fileScope: { includes: string[]; excludes: string[] };
  acceptanceCriteria: Array<{
    id: FixtureId;
    title: string;
    verify: string;
  }>;
  testCommands: string[];
  budget: {
    maxWallClockMinutes: number;
    maxModelCostUsd: number;
    maxPromptTokens: number;
  };
  worktreePath: string | null;
  latestAgentRun: TaskAgentRunRef | null;
  latestLease: TaskLeaseRef | null;
  latestReviewReport: TaskReviewReportRef | null;
}

export type TasksList = TaskSummary[];

const TASKS_HAPPY: TasksList = [
  {
    id: "task_01HVQX9001FIXTURES000",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8001FOUNDATION0",
    slug: "fixtures-module",
    title: "Typed fixture module for every run-related domain",
    status: "merged",
    riskLevel: "medium",
    kind: "foundation",
    approvalStatus: "approved",
    reviewState: "approved",
    branchName: "task-fixtures-module",
    budgetSpend: {
      usd: 1.23,
      tokens: 88_421,
      wallClockMinutes: 14,
      overBudget: false,
    },
    availableActions: [],
  },
  {
    id: "task_01HVQX9002BANNER0000",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8001FOUNDATION0",
    slug: "fixture-banner",
    title: "Render M3 fixture banner on every consuming route",
    status: "merged",
    riskLevel: "low",
    kind: "feature",
    approvalStatus: "approved",
    reviewState: "approved",
    branchName: "task-fixture-banner",
    budgetSpend: {
      usd: 0.41,
      tokens: 22_004,
      wallClockMinutes: 6,
      overBudget: false,
    },
    availableActions: [],
  },
  {
    id: "task_01HVQX9003ROUTES0000",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    slug: "route-shell",
    title: "Wire react-router route shell + selected-run subroutes",
    status: "in_review",
    riskLevel: "medium",
    kind: "feature",
    approvalStatus: "pending",
    reviewState: "pending",
    branchName: "task-route-shell",
    budgetSpend: {
      usd: 2.05,
      tokens: 142_109,
      wallClockMinutes: 27,
      overBudget: false,
    },
    availableActions: [
      {
        action: "task.approve",
        enabled: true,
        reason: null,
        requiresConfirmation: true,
        requiresReason: false,
        pending: false,
      },
      {
        action: "task.overrideReview",
        enabled: false,
        reason: "task is not blocked or fixing",
        requiresConfirmation: true,
        requiresReason: true,
        pending: false,
      },
    ],
  },
  {
    id: "task_01HVQX9004APPROVALS0",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    slug: "approvals-route",
    title: "Approvals queue route + bulk-approve modal",
    status: "running",
    riskLevel: "medium",
    kind: "feature",
    approvalStatus: null,
    reviewState: null,
    branchName: "task-approvals-route",
    budgetSpend: {
      usd: 0.74,
      tokens: 51_220,
      wallClockMinutes: 9,
      overBudget: false,
    },
    availableActions: [
      {
        action: "task.run",
        enabled: false,
        reason: "task is already running",
        requiresConfirmation: true,
        requiresReason: false,
        pending: false,
      },
    ],
  },
  {
    id: "task_01HVQX9005EVIDENCE00",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8003CONFAUDIT00",
    slug: "evidence-route",
    title: "Evidence + release route fixtures",
    status: "pending",
    riskLevel: "low",
    kind: "feature",
    approvalStatus: null,
    reviewState: null,
    branchName: null,
    budgetSpend: null,
    availableActions: [
      {
        action: "task.run",
        enabled: false,
        reason: "owning phase is not executing",
        requiresConfirmation: true,
        requiresReason: false,
        pending: false,
      },
    ],
  },
];

export const tasksHappyPath: FixtureDataset<TasksList> = {
  state: "happy",
  label: "tasks · 5 tasks across statuses",
  data: TASKS_HAPPY,
};

export const tasksEmptyState: FixtureDataset<TasksList> = {
  state: "empty",
  label: "tasks · no tasks decomposed yet",
  data: [],
};

export const tasksErrorState: FixtureDataset<TasksList> = {
  state: "error",
  label: "tasks · 502 from /tasks",
  data: [],
  error: {
    status: 502,
    message: "upstream timeout while listing tasks",
    body: { error: "upstream_timeout" },
  },
};

/**
 * Sample {@link TaskDetail} used by the Task-detail drawer in M2.
 * Exposed alongside the list datasets so the drawer route has a
 * realistic payload to render without joining the list itself.
 */
export const taskDetailHappyPath: FixtureDataset<TaskDetail> = {
  state: "happy",
  label: "task detail · in_review task awaiting approval",
  data: {
    id: "task_01HVQX9003ROUTES0000",
    planId: "plan_01HVQX7AA4B0EXEC1NG",
    phaseId: "phase_01HVQX8002ROUTESURFACE",
    slug: "route-shell",
    title: "Wire react-router route shell + selected-run subroutes",
    status: "in_review",
    riskLevel: "medium",
    kind: "feature",
    approvalStatus: "pending",
    reviewState: "pending",
    branchName: "task-route-shell",
    budgetSpend: {
      usd: 2.05,
      tokens: 142_109,
      wallClockMinutes: 27,
      overBudget: false,
    },
    availableActions: [
      {
        action: "task.approve",
        enabled: true,
        reason: null,
        requiresConfirmation: true,
        requiresReason: false,
        pending: false,
      },
    ],
    summary:
      "Add the React Router shell that hosts the selected-run sub-routes (Run Overview, Plan/Phases, Tasks, Task Detail, Approvals, Budget, Evidence, Artifact Detail, Release).",
    fileScope: {
      includes: [
        "apps/desktop/src/renderer/routes/**",
        "apps/desktop/src/renderer/layout/**",
        "apps/desktop/src/renderer/index.tsx",
        "apps/desktop/src/renderer/App.tsx",
      ],
      excludes: [],
    },
    acceptanceCriteria: [
      {
        id: "ac_routes_mount_smoke",
        title: "Every top-level route mounts without throwing.",
        verify: "pnpm --filter @pm-go/desktop test",
      },
      {
        id: "ac_routes_typecheck",
        title: "Renderer typecheck passes with route tree wired.",
        verify: "pnpm --filter @pm-go/desktop typecheck",
      },
    ],
    testCommands: [
      "pnpm --filter @pm-go/desktop typecheck",
      "pnpm --filter @pm-go/desktop test",
    ],
    budget: {
      maxWallClockMinutes: 90,
      maxModelCostUsd: 20,
      maxPromptTokens: 200_000,
    },
    worktreePath:
      "/Users/alejandro/Desktop/999. PROJECTS/pm-go/.worktrees/route-shell",
    latestAgentRun: {
      id: "ar_01HVQXA001IMPL0000001",
      role: "implementer",
      startedAt: "2026-05-11T08:30:00.000Z",
      completedAt: "2026-05-11T08:58:31.000Z",
      outcome: "succeeded",
      costUsd: 2.05,
    },
    latestLease: {
      id: "lease_01HVQXA001LEASE00001",
      worktreePath:
        "/Users/alejandro/Desktop/999. PROJECTS/pm-go/.worktrees/route-shell",
      branchName: "task-route-shell",
      baseSha: "1230b060fd2ab813a2c7579239242a3d1f34d83b",
      leasedAt: "2026-05-11T08:29:54.000Z",
      releasedAt: null,
    },
    latestReviewReport: {
      id: "rr_01HVQXA001REVIEW00001",
      cycleNumber: 1,
      outcome: "pending",
      generatedAt: "2026-05-11T08:59:12.000Z",
      summary: "Reviewer agent is queued; no findings yet.",
      findingsCount: 0,
    },
  },
};

export const taskDetailEmptyState: FixtureDataset<TaskDetail | null> = {
  state: "empty",
  label: "task detail · no task selected",
  data: null,
};

export const taskDetailErrorState: FixtureDataset<TaskDetail | null> = {
  state: "error",
  label: "task detail · 404 from /tasks/:id",
  data: null,
  error: {
    status: 404,
    message: "task not found",
    body: { error: "task_not_found" },
  },
};
