import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Plan } from "@pm-go/contracts";
import {
  createStubPlannerRunner,
  type PlannerRunner,
  type PlannerRunnerInput,
  type PlannerRunnerResult,
} from "@pm-go/executor-claude";

/**
 * Wraps `createStubPlannerRunner` so that every call substitutes the
 * fixture's `specDocumentId` / `repoSnapshotId` with the live ids from the
 * incoming `PlannerRunnerInput` and re-stamps the plan with a fresh
 * top-level `id` plus fresh `planId` back-references on every phase/task.
 *
 * Without this wrapper the stub would return the static fixture plan
 * whose foreign-key-bearing ids don't match the spec + snapshot rows just
 * inserted by the smoke, and `persistPlan` would blow up on the
 * `plans.spec_document_id` FK.
 *
 * Mutation is confined to a structural-clone of the fixture; the cached
 * fixture on disk stays untouched so re-runs are deterministic.
 */
export function createFixtureSubstitutingStubRunner(
  fixturePath: string,
): PlannerRunner {
  const raw = readFileSync(fixturePath, "utf8");
  const fixture: Plan = JSON.parse(raw) as Plan;

  return {
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const rebased = rebasePlanIds(fixture, {
        specDocumentId: input.specDocument.id,
        repoSnapshotId: input.repoSnapshot.id,
      });
      // Delegate AgentRun synthesis to the existing stub runner so the
      // contract (role=planner, status=completed, zero usage) stays in
      // one place.
      const inner = createStubPlannerRunner(rebased);
      return inner.run(input);
    },
  };
}

interface IdOverrides {
  specDocumentId: string;
  repoSnapshotId: string;
}

/**
 * Deep-clones the fixture plan and rewrites every id/reference we care
 * about:
 *   - `plan.id` -> same as `specDocumentId` (V1 convention: planId == specDocumentId)
 *   - `plan.specDocumentId` -> overrides.specDocumentId
 *   - `plan.repoSnapshotId` -> overrides.repoSnapshotId
 *   - every `phase.planId` -> plan.id
 *   - every `phase.baseSnapshotId` -> overrides.repoSnapshotId
 *   - every `task.planId` -> plan.id
 *   - phase ids, task ids, dependency edge endpoints: remapped to fresh
 *     UUIDs so a second run against a new spec doesn't collide on the
 *     `plan_tasks.plan_id_slug_unique` constraint from a stale plan.
 */
function rebasePlanIds(fixture: Plan, overrides: IdOverrides): Plan {
  const cloned: Plan = JSON.parse(JSON.stringify(fixture)) as Plan;
  // V1 convention: planId === specDocumentId.
  cloned.id = overrides.specDocumentId;
  cloned.specDocumentId = overrides.specDocumentId;
  cloned.repoSnapshotId = overrides.repoSnapshotId;

  const phaseIdMap = new Map<string, string>();
  const taskIdMap = new Map<string, string>();
  for (const phase of cloned.phases) phaseIdMap.set(phase.id, randomUUID());
  for (const task of cloned.tasks) taskIdMap.set(task.id, randomUUID());

  for (const phase of cloned.phases) {
    phase.id = phaseIdMap.get(phase.id)!;
    phase.planId = cloned.id;
    phase.baseSnapshotId = overrides.repoSnapshotId;
    phase.taskIds = phase.taskIds.map((id) => taskIdMap.get(id) ?? id);
    phase.mergeOrder = phase.mergeOrder.map((id) => taskIdMap.get(id) ?? id);
    phase.dependencyEdges = phase.dependencyEdges.map((edge) => ({
      ...edge,
      fromTaskId: taskIdMap.get(edge.fromTaskId) ?? edge.fromTaskId,
      toTaskId: taskIdMap.get(edge.toTaskId) ?? edge.toTaskId,
    }));
  }
  for (const task of cloned.tasks) {
    task.id = taskIdMap.get(task.id)!;
    task.planId = cloned.id;
    task.phaseId = phaseIdMap.get(task.phaseId) ?? task.phaseId;
  }

  return cloned;
}
