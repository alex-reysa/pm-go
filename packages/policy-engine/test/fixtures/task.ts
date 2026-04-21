import type { Task, TaskBudget } from "@pm-go/contracts";

/**
 * Build a minimal `Task` suitable for budget / approval / stop tests.
 * Only the fields that matter to the policy evaluators are populated;
 * the rest default to safe, contract-valid values so the fixture can
 * also round-trip through `validateTask` when tests need it.
 */
export function buildTask(overrides: Partial<Task> = {}): Task {
  // `overrides.budget`, when present, is taken as-is so a caller can
  // omit `maxModelCostUsd` / `maxPromptTokens` to test "no cap" paths.
  const defaultBudget: TaskBudget = {
    maxWallClockMinutes: 45,
    maxModelCostUsd: 4,
    maxPromptTokens: 350_000,
  };
  const budget: TaskBudget = overrides.budget ?? defaultBudget;

  const base: Task = {
    id: "cccccccc-dddd-4eee-8fff-000000000000",
    planId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    phaseId: "22222222-3333-4444-8555-666666666666",
    slug: "test-task",
    title: "Test task",
    summary: "fixture used by policy-engine tests",
    kind: "implementation",
    status: "running",
    riskLevel: "medium",
    fileScope: {
      includes: ["packages/example/src/**"],
    },
    acceptanceCriteria: [],
    testCommands: [],
    budget,
    reviewerPolicy: {
      required: true,
      strictness: "standard",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 2,
  };

  const { budget: _budgetOverride, ...rest } = overrides;
  void _budgetOverride;
  return { ...base, ...rest, budget };
}
