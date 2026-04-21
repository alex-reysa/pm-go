import { describe, expect, it } from "vitest";

import { evaluateApprovalGate } from "../src/approval.js";

import { buildRisk } from "./fixtures/risk.js";
import { buildTask } from "./fixtures/task.js";

describe("evaluateApprovalGate", () => {
  it("returns required:false for a low-risk task with no Risk flag", () => {
    const task = buildTask({ riskLevel: "low", requiresHumanApproval: false });
    expect(evaluateApprovalGate("low", task)).toEqual({ required: false });
  });

  it("returns required:false for a medium-risk task with no Risk flag", () => {
    const task = buildTask({
      riskLevel: "medium",
      requiresHumanApproval: false,
    });
    expect(evaluateApprovalGate("medium", task)).toEqual({
      required: false,
    });
  });

  it("returns high band when task riskLevel is high (task flag unset)", () => {
    const task = buildTask({ riskLevel: "high", requiresHumanApproval: false });
    expect(evaluateApprovalGate("high", task)).toEqual({
      required: true,
      band: "high",
    });
  });

  it("returns high band when task.requiresHumanApproval is true at medium", () => {
    const task = buildTask({
      riskLevel: "medium",
      requiresHumanApproval: true,
    });
    expect(evaluateApprovalGate("medium", task)).toEqual({
      required: true,
      band: "high",
    });
  });

  it("escalates to catastrophic when Risk + Task both demand approval at high", () => {
    const task = buildTask({ riskLevel: "high", requiresHumanApproval: true });
    const risk = buildRisk({ level: "high", humanApprovalRequired: true });
    expect(evaluateApprovalGate(risk, task)).toEqual({
      required: true,
      band: "catastrophic",
    });
  });

  it("stays at high band when Risk is flagged but Task is not", () => {
    const task = buildTask({ riskLevel: "high", requiresHumanApproval: false });
    const risk = buildRisk({ level: "high", humanApprovalRequired: true });
    expect(evaluateApprovalGate(risk, task)).toEqual({
      required: true,
      band: "high",
    });
  });

  it("returns required:false for medium Risk with humanApprovalRequired:true and unflagged Task", () => {
    const task = buildTask({
      riskLevel: "medium",
      requiresHumanApproval: false,
    });
    const risk = buildRisk({ level: "medium", humanApprovalRequired: true });
    // Rule 3 requires a non-null band; medium maps to null, so the gate
    // stays open. A plan flagging a medium-risk item is informative, not
    // blocking.
    expect(evaluateApprovalGate(risk, task)).toEqual({ required: false });
  });

  it("accepts a bare RiskLevel argument", () => {
    const task = buildTask({ riskLevel: "high", requiresHumanApproval: false });
    expect(evaluateApprovalGate("high", task)).toEqual({
      required: true,
      band: "high",
    });
  });

  it("is stable (pure) across calls with the same input", () => {
    const task = buildTask({ riskLevel: "high" });
    const a = evaluateApprovalGate("high", task);
    const b = evaluateApprovalGate("high", task);
    expect(a).toEqual(b);
  });
});
