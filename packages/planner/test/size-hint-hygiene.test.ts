import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan } from "@pm-go/contracts";

import {
  auditPlanSizeHints,
  effectiveSizeHint,
} from "../src/size-hint-hygiene.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);

function loadPlan(): Plan {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Plan;
}

describe("effectiveSizeHint", () => {
  it("treats absence as medium", () => {
    const plan = loadPlan();
    delete plan.tasks[0]!.sizeHint;
    expect(effectiveSizeHint(plan.tasks[0]!)).toBe("medium");
  });
  it("returns the explicit hint when present", () => {
    const plan = loadPlan();
    plan.tasks[0]!.sizeHint = "large";
    expect(effectiveSizeHint(plan.tasks[0]!)).toBe("large");
  });
});

describe("auditPlanSizeHints", () => {
  it("flags small + high-risk", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.sizeHint = "small";
    task.riskLevel = "high";
    task.requiresHumanApproval = false;
    const findings = auditPlanSizeHints(plan);
    expect(
      findings.some((f) => f.id === "plan_audit.tasks.sizeHint.smallHighRisk"),
    ).toBe(true);
  });

  it("flags small + requiresHumanApproval", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.sizeHint = "small";
    task.riskLevel = "low";
    task.requiresHumanApproval = true;
    const findings = auditPlanSizeHints(plan);
    expect(
      findings.some(
        (f) => f.id === "plan_audit.tasks.sizeHint.smallHumanApproval",
      ),
    ).toBe(true);
  });

  it("flags small + migration-related acceptance criteria", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.sizeHint = "small";
    task.riskLevel = "low";
    task.requiresHumanApproval = false;
    task.acceptanceCriteria = [
      {
        id: "ac-1",
        description: "Migration applies cleanly to production schema.",
        verificationCommands: ["pnpm db:migrate"],
        required: true,
      },
    ];
    const findings = auditPlanSizeHints(plan);
    expect(
      findings.some(
        (f) => f.id === "plan_audit.tasks.sizeHint.smallDestructive",
      ),
    ).toBe(true);
  });

  it("does not flag a clean small task", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.sizeHint = "small";
    task.riskLevel = "low";
    task.requiresHumanApproval = false;
    task.acceptanceCriteria = [
      {
        id: "ac-1",
        description: "Reviewer prompt mentions the new severity threshold.",
        verificationCommands: ["pnpm --filter @pm-go/planner test"],
        required: true,
      },
    ];
    const findings = auditPlanSizeHints(plan);
    expect(findings).toHaveLength(0);
  });

  it("ignores tasks with sizeHint=medium or large", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.sizeHint = "medium";
    task.riskLevel = "high";
    task.requiresHumanApproval = true;
    const findings = auditPlanSizeHints(plan);
    expect(findings).toHaveLength(0);
  });
});
