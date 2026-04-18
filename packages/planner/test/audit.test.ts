import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan } from "@pm-go/contracts";

import { auditPlan } from "../src/audit.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(fixturePath, "utf8"));

function clonePlan(): Plan {
  // Structured clone keeps the whole nested tree mutable independently.
  return JSON.parse(JSON.stringify(planFixture)) as Plan;
}

describe("auditPlan", () => {
  it("approves a valid fixture plan with zero findings", () => {
    const outcome = auditPlan(planFixture);
    expect(outcome.planId).toBe(planFixture.id);
    expect(outcome.approved).toBe(true);
    expect(outcome.revisionRequested).toBe(false);
    expect(outcome.findings).toHaveLength(0);
  });

  it("flags a phase index gap with plan_audit.phases.index_sequence", () => {
    const plan = clonePlan();
    // Mutate phase indices to [0, 2] instead of [0, 1].
    plan.phases[1]!.index = 2;
    const outcome = auditPlan(plan);
    expect(outcome.approved).toBe(false);
    expect(outcome.revisionRequested).toBe(true);
    const ids = outcome.findings.map((f) => f.id);
    expect(ids).toContain("plan_audit.phases.index_sequence");
  });

  it("flags overlapping fileScope.includes in phase 0 as a high finding", () => {
    const plan = clonePlan();
    // Make the two phase-0 tasks share an identical includes entry.
    const phase0 = plan.phases.find((p) => p.index === 0)!;
    const phase0Tasks = plan.tasks.filter((t) => t.phaseId === phase0.id);
    expect(phase0Tasks.length).toBeGreaterThanOrEqual(2);
    const shared = "packages/contracts/src/shared/schema.ts";
    phase0Tasks[0]!.fileScope.includes = [shared];
    phase0Tasks[1]!.fileScope.includes = [shared];

    const outcome = auditPlan(plan);
    expect(outcome.approved).toBe(false);
    const overlap = outcome.findings.find(
      (f) => f.id === "plan_audit.phase1.fileScope.disjoint",
    );
    expect(overlap).toBeDefined();
    expect(overlap!.severity).toBe("high");
    expect(overlap!.summary).toContain(shared);
  });

  it("flags a phase-0 dependency cycle with plan_audit.phase1.dependencyEdges.acyclic", () => {
    const plan = clonePlan();
    const phase0 = plan.phases.find((p) => p.index === 0)!;
    const phase0Tasks = plan.tasks.filter((t) => t.phaseId === phase0.id);
    expect(phase0Tasks.length).toBeGreaterThanOrEqual(2);
    const a = phase0Tasks[0]!.id;
    const b = phase0Tasks[1]!.id;
    phase0.dependencyEdges = [
      { fromTaskId: a, toTaskId: b, reason: "A before B", required: true },
      { fromTaskId: b, toTaskId: a, reason: "B before A", required: true },
    ];

    const outcome = auditPlan(plan);
    expect(outcome.approved).toBe(false);
    const cycle = outcome.findings.find(
      (f) => f.id === "plan_audit.phase1.dependencyEdges.acyclic",
    );
    expect(cycle).toBeDefined();
    expect(cycle!.severity).toBe("high");
  });

  it("flags an unapproved high-risk entry as a medium finding", () => {
    const plan = clonePlan();
    expect(plan.risks.length).toBeGreaterThan(0);
    plan.risks[0]!.level = "high";
    plan.risks[0]!.humanApprovalRequired = false;

    const outcome = auditPlan(plan);
    expect(outcome.approved).toBe(false);
    const finding = outcome.findings.find(
      (f) => f.id === "plan_audit.risks.highRiskApproval",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("medium");
  });
});
