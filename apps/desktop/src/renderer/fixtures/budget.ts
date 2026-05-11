/**
 * Fixtures for the Budget route.
 *
 * Backed conceptually by `GET /plans/:planId/budget-report`.
 * 05-api-integration.md flags this endpoint as expensive (the
 * server computes + persists a fresh snapshot on every read),
 * so the M2 fixture pre-bakes a snapshot the UI can render
 * without round-tripping.
 */

import type {
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
} from "./types.js";

/** Per-task breakdown row. Mirrors `BudgetSnapshot.perTask`. */
export interface BudgetPerTask {
  taskId: FixtureId;
  taskTitle: string;
  usd: number;
  tokens: number;
  wallClockMinutes: number;
  /** True when spend exceeds the task's configured max-cost cap. */
  overBudget: boolean;
  /** Configured cost cap for context in the row. */
  capUsd: number;
}

/**
 * `BudgetSnapshot` is the read model the Budget route renders.
 * Tracks 05-api-integration.md § "BudgetSnapshot".
 */
export interface BudgetSnapshot {
  id: FixtureId;
  planId: FixtureId;
  generatedAt: IsoTimestamp;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
  perTask: BudgetPerTask[];
  /** Task ids whose `overBudget` is true; redundant for fast filtering. */
  overBudgetTasks: FixtureId[];
}

const BUDGET_HAPPY: BudgetSnapshot = {
  id: "br_01HVQXC001BUDGETSNAP0",
  planId: "plan_01HVQX7AA4B0EXEC1NG",
  generatedAt: "2026-05-11T09:18:00.000Z",
  totalUsd: 4.43,
  totalTokens: 303_754,
  totalWallClockMinutes: 56,
  perTask: [
    {
      taskId: "task_01HVQX9001FIXTURES000",
      taskTitle: "Typed fixture module for every run-related domain",
      usd: 1.23,
      tokens: 88_421,
      wallClockMinutes: 14,
      overBudget: false,
      capUsd: 15,
    },
    {
      taskId: "task_01HVQX9002BANNER0000",
      taskTitle: "Render M3 fixture banner on every consuming route",
      usd: 0.41,
      tokens: 22_004,
      wallClockMinutes: 6,
      overBudget: false,
      capUsd: 10,
    },
    {
      taskId: "task_01HVQX9003ROUTES0000",
      taskTitle: "Wire react-router route shell + selected-run subroutes",
      usd: 2.05,
      tokens: 142_109,
      wallClockMinutes: 27,
      overBudget: false,
      capUsd: 20,
    },
    {
      taskId: "task_01HVQX9004APPROVALS0",
      taskTitle: "Approvals queue route + bulk-approve modal",
      usd: 0.74,
      tokens: 51_220,
      wallClockMinutes: 9,
      overBudget: false,
      capUsd: 15,
    },
  ],
  overBudgetTasks: [],
};

const BUDGET_EMPTY: BudgetSnapshot = {
  id: "br_00000000000EMPTYSNAP0",
  planId: "plan_00000000000000EMPTY00",
  generatedAt: "2026-05-11T09:18:00.000Z",
  totalUsd: 0,
  totalTokens: 0,
  totalWallClockMinutes: 0,
  perTask: [],
  overBudgetTasks: [],
};

export const budgetHappyPath: FixtureDataset<BudgetSnapshot> = {
  state: "happy",
  label: "budget · 4 tasks under cap",
  data: BUDGET_HAPPY,
};

export const budgetEmptyState: FixtureDataset<BudgetSnapshot> = {
  state: "empty",
  label: "budget · no spend recorded yet",
  data: BUDGET_EMPTY,
};

export const budgetErrorState: FixtureDataset<BudgetSnapshot> = {
  state: "error",
  label: "budget · 500 from /plans/:id/budget-report",
  // Reuse the empty snapshot so the route can keep the page
  // chrome rendered around the inline error.
  data: BUDGET_EMPTY,
  error: {
    status: 500,
    message: "budget reporter failed",
    body: { error: "budget_reporter_failed" },
  },
};
