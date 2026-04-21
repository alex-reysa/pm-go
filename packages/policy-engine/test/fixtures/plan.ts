import type { Phase, Plan, ReviewFinding } from "@pm-go/contracts";

export function buildFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  const base: ReviewFinding = {
    id: "finding-1",
    severity: "low",
    title: "Sample finding",
    summary: "fixture finding for stop-condition tests",
    filePath: "src/example.ts",
    confidence: 0.9,
    suggestedFixDirection: "no-op",
  };
  return { ...base, ...overrides };
}

export function buildPhase(overrides: Partial<Phase> = {}): Phase {
  const base: Phase = {
    id: "22222222-3333-4444-8555-666666666666",
    planId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    index: 0,
    title: "Phase 0",
    summary: "fixture phase",
    status: "executing",
    integrationBranch: "codex/integration",
    baseSnapshotId: "11111111-2222-4333-8444-555555555559",
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
  return { ...base, ...overrides };
}

export function buildPlan(overrides: Partial<Plan> = {}): Plan {
  const base: Plan = {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    specDocumentId: "11111111-2222-4333-8444-555555555550",
    repoSnapshotId: "11111111-2222-4333-8444-555555555551",
    title: "Fixture plan",
    summary: "plan fixture for stop-condition tests",
    status: "executing",
    phases: [buildPhase()],
    tasks: [],
    risks: [],
    createdAt: "2026-04-21T09:00:00.000Z",
    updatedAt: "2026-04-21T09:00:00.000Z",
  };
  return { ...base, ...overrides };
}
