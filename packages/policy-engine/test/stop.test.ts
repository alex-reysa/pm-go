import { describe, expect, it } from "vitest";

import { DEFAULT_OPERATING_LIMITS } from "@pm-go/contracts";

import { evaluateStopCondition } from "../src/stop.js";

import { buildFinding, buildPhase, buildPlan } from "./fixtures/plan.js";

describe("evaluateStopCondition", () => {
  it("returns stop:false when everything is within limits", () => {
    const plan = buildPlan();
    const result = evaluateStopCondition(plan, 0, [], DEFAULT_OPERATING_LIMITS);
    expect(result).toEqual({ stop: false });
  });

  it("stops on high-severity findings above the cap", () => {
    const plan = buildPlan();
    const findings = [
      buildFinding({ id: "f1", severity: "high" }),
      buildFinding({ id: "f2", severity: "high" }),
    ];
    const result = evaluateStopCondition(
      plan,
      0,
      findings,
      DEFAULT_OPERATING_LIMITS,
    );
    // default cap is 1 → 2 high-severity findings trips the gate
    expect(result).toEqual({
      stop: true,
      reason: "high_severity_findings",
    });
  });

  it("does NOT stop at exactly the high-severity cap", () => {
    const plan = buildPlan();
    const findings = [buildFinding({ severity: "high" })];
    const result = evaluateStopCondition(
      plan,
      0,
      findings,
      DEFAULT_OPERATING_LIMITS,
    );
    expect(result).toEqual({ stop: false });
  });

  it("ignores non-high-severity findings when counting the gate", () => {
    const plan = buildPlan();
    const findings = [
      buildFinding({ id: "f1", severity: "medium" }),
      buildFinding({ id: "f2", severity: "medium" }),
      buildFinding({ id: "f3", severity: "low" }),
    ];
    const result = evaluateStopCondition(
      plan,
      0,
      findings,
      DEFAULT_OPERATING_LIMITS,
    );
    expect(result).toEqual({ stop: false });
  });

  it("stops on too many review cycles", () => {
    const plan = buildPlan();
    const result = evaluateStopCondition(
      plan,
      // default maxReviewFixCyclesPerTask is 2 → 3 trips the gate
      3,
      [],
      DEFAULT_OPERATING_LIMITS,
    );
    expect(result).toEqual({
      stop: true,
      reason: "review_cycles_exceeded",
    });
  });

  it("does NOT stop at exactly the review-cycles cap", () => {
    const plan = buildPlan();
    const result = evaluateStopCondition(
      plan,
      2,
      [],
      DEFAULT_OPERATING_LIMITS,
    );
    expect(result).toEqual({ stop: false });
  });

  it("stops when phase reruns exceed the limit", () => {
    const plan = buildPlan({
      phases: [
        buildPhase({
          id: "22222222-3333-4444-8555-aaaaaaaaaaaa",
          status: "blocked",
          phaseAuditReportId: "33333333-4444-4555-8666-777777777770",
        }),
        buildPhase({
          id: "22222222-3333-4444-8555-bbbbbbbbbbbb",
          status: "blocked",
          phaseAuditReportId: "33333333-4444-4555-8666-777777777771",
        }),
      ],
    });
    const result = evaluateStopCondition(
      plan,
      0,
      [],
      DEFAULT_OPERATING_LIMITS,
    );
    // default maxAutomaticPhaseReruns is 1; 2 blocked-with-audit phases → stop
    expect(result).toEqual({
      stop: true,
      reason: "phase_rerun_exhausted",
    });
  });

  it("prioritises high_severity_findings over review_cycles_exceeded", () => {
    const plan = buildPlan();
    const findings = [
      buildFinding({ id: "f1", severity: "high" }),
      buildFinding({ id: "f2", severity: "high" }),
    ];
    const result = evaluateStopCondition(
      plan,
      9,
      findings,
      DEFAULT_OPERATING_LIMITS,
    );
    expect(result).toEqual({
      stop: true,
      reason: "high_severity_findings",
    });
  });

  it("prioritises review_cycles_exceeded over phase_rerun_exhausted", () => {
    const plan = buildPlan({
      phases: [
        buildPhase({
          id: "22222222-3333-4444-8555-aaaaaaaaaaaa",
          status: "blocked",
          phaseAuditReportId: "33333333-4444-4555-8666-777777777770",
        }),
        buildPhase({
          id: "22222222-3333-4444-8555-bbbbbbbbbbbb",
          status: "blocked",
          phaseAuditReportId: "33333333-4444-4555-8666-777777777771",
        }),
      ],
    });
    const result = evaluateStopCondition(plan, 5, [], DEFAULT_OPERATING_LIMITS);
    expect(result).toEqual({
      stop: true,
      reason: "review_cycles_exceeded",
    });
  });

  it("honours caller-supplied limits overrides", () => {
    const plan = buildPlan();
    const custom = {
      ...DEFAULT_OPERATING_LIMITS,
      maxReviewFixCyclesPerTask: 5,
    } as typeof DEFAULT_OPERATING_LIMITS;
    const result = evaluateStopCondition(plan, 3, [], custom);
    expect(result).toEqual({ stop: false });
  });

  it("is stable (pure) across calls with the same input", () => {
    const plan = buildPlan();
    const findings = [buildFinding({ severity: "high" })];
    const a = evaluateStopCondition(plan, 1, findings, DEFAULT_OPERATING_LIMITS);
    const b = evaluateStopCondition(plan, 1, findings, DEFAULT_OPERATING_LIMITS);
    expect(a).toEqual(b);
  });
});
