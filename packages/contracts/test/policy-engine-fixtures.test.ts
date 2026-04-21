import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ApprovalRequestSchema,
  BudgetReportSchema,
  RetryPolicyConfigSchema,
  validateApprovalRequest,
  validateBudgetReport,
} from "../src/validators/policy.js";

// Importing through the policy-exports sub-barrel proves Worker 4 can
// pull every Phase 7 contract type + validator + JSON Schema from a
// single re-export point, exactly as documented in
// `packages/contracts/src/policy-exports.ts`.
import {
  ApprovalRequestJsonSchema,
  ApprovalRequestSchema as ApprovalRequestSchemaViaBarrel,
  BudgetReportJsonSchema,
  BudgetReportSchema as BudgetReportSchemaViaBarrel,
  RetryPolicyConfigJsonSchema,
  RetryPolicyConfigSchema as RetryPolicyConfigSchemaViaBarrel,
  validateApprovalRequest as validateApprovalRequestViaBarrel,
  validateBudgetReport as validateBudgetReportViaBarrel,
  validateRetryPolicyConfig as validateRetryPolicyConfigViaBarrel,
} from "../src/policy-exports.js";
import type {
  ApprovalDecision,
  BudgetDecision,
  RetryDecision,
  RetryPolicyConfig,
  StopDecision,
} from "../src/policy-exports.js";

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

describe("policy-exports sub-barrel", () => {
  it("re-exports validator schemas by reference identity", () => {
    expect(ApprovalRequestSchemaViaBarrel).toBe(ApprovalRequestSchema);
    expect(BudgetReportSchemaViaBarrel).toBe(BudgetReportSchema);
    expect(RetryPolicyConfigSchemaViaBarrel).toBe(RetryPolicyConfigSchema);
  });

  it("re-exports JSON Schemas as the same objects (TypeBox === JSON Schema)", () => {
    expect(ApprovalRequestJsonSchema).toBe(ApprovalRequestSchema);
    expect(BudgetReportJsonSchema).toBe(BudgetReportSchema);
    expect(RetryPolicyConfigJsonSchema).toBe(RetryPolicyConfigSchema);
  });

  it("re-exports working runtime validators that accept valid payloads", () => {
    const approvalFixture = loadFixture("approval-request-pending.json");
    const budgetFixture = loadFixture("budget-report-happy.json");
    const retry: RetryPolicyConfig = {
      workflowName: "SampleWorkflow",
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      backoffMultiplier: 2,
      maxAttempts: 3,
    };
    expect(validateApprovalRequestViaBarrel(approvalFixture)).toBe(true);
    expect(validateBudgetReportViaBarrel(budgetFixture)).toBe(true);
    expect(validateRetryPolicyConfigViaBarrel(retry)).toBe(true);
  });

  it("exposes the four decision union types at compile time", () => {
    // Compile-only assertions: if these types vanish, the test won't
    // compile. Runtime behavior is asserted by the engine tests.
    const _a: ApprovalDecision = { required: false };
    const _b: BudgetDecision = { ok: true };
    const _c: RetryDecision = { retry: false, reason: "n/a" };
    const _d: StopDecision = { stop: false };
    expect(_a).toBeDefined();
    expect(_b).toBeDefined();
    expect(_c).toBeDefined();
    expect(_d).toBeDefined();
  });
});
