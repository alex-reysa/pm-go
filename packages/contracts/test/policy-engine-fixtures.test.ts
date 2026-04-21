import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateApprovalRequest,
  validateBudgetReport,
} from "../src/validators/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(__dirname, "../src/fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), "utf8"));
}

describe("validateApprovalRequest", () => {
  it.each([
    "approval-request-pending.json",
    "approval-request-approved.json",
    "approval-request-rejected.json",
    "approval-request-plan.json",
  ])("accepts the %s fixture", (name) => {
    expect(validateApprovalRequest(loadFixture(name))).toBe(true);
  });

  it("rejects an approval request with an unknown status", () => {
    const fixture = loadFixture(
      "approval-request-pending.json",
    ) as Record<string, unknown>;
    const mutated = { ...fixture, status: "deferred" };
    expect(validateApprovalRequest(mutated)).toBe(false);
  });

  it("rejects an approval request with an unknown risk band", () => {
    const fixture = loadFixture(
      "approval-request-pending.json",
    ) as Record<string, unknown>;
    const mutated = { ...fixture, riskBand: "medium" };
    expect(validateApprovalRequest(mutated)).toBe(false);
  });

  it("rejects an approval request with an unexpected top-level field", () => {
    const fixture = loadFixture(
      "approval-request-pending.json",
    ) as Record<string, unknown>;
    const extra = { ...fixture, note: "nope" };
    expect(validateApprovalRequest(extra)).toBe(false);
  });

  it("rejects an approval request missing required id", () => {
    const fixture = loadFixture(
      "approval-request-pending.json",
    ) as Record<string, unknown>;
    const { id: _id, ...rest } = fixture;
    void _id;
    expect(validateApprovalRequest(rest)).toBe(false);
  });
});

describe("validateBudgetReport", () => {
  it.each(["budget-report-happy.json", "budget-report-over-budget.json"])(
    "accepts the %s fixture",
    (name) => {
      expect(validateBudgetReport(loadFixture(name))).toBe(true);
    },
  );

  it("rejects a budget report with a negative per-task total", () => {
    const fixture = loadFixture(
      "budget-report-happy.json",
    ) as Record<string, unknown>;
    const breakdown = [
      { ...((fixture.perTaskBreakdown as unknown[])[0] as object) },
    ] as { totalUsd: number }[];
    breakdown[0]!.totalUsd = -1;
    const mutated = { ...fixture, perTaskBreakdown: breakdown };
    expect(validateBudgetReport(mutated)).toBe(false);
  });

  it("rejects a budget report missing generatedAt", () => {
    const fixture = loadFixture(
      "budget-report-happy.json",
    ) as Record<string, unknown>;
    const { generatedAt: _gen, ...rest } = fixture;
    void _gen;
    expect(validateBudgetReport(rest)).toBe(false);
  });

  it("rejects a budget report with a non-UUID id", () => {
    const fixture = loadFixture(
      "budget-report-happy.json",
    ) as Record<string, unknown>;
    const mutated = { ...fixture, id: "not-a-uuid" };
    expect(validateBudgetReport(mutated)).toBe(false);
  });
});
