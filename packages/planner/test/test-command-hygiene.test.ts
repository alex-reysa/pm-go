import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan } from "@pm-go/contracts";

import {
  applyTestCommandRewrites,
  auditPlanTestCommands,
  normalizeTestCommand,
  validateTaskTestCommands,
} from "../src/test-command-hygiene.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);

function loadPlan(): Plan {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Plan;
}

describe("normalizeTestCommand", () => {
  it("rewrites `pnpm test --filter @pm-go/worker` to `pnpm --filter @pm-go/worker test`", () => {
    const result = normalizeTestCommand("pnpm test --filter @pm-go/worker");
    expect(result.rewritten).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.command).toBe("pnpm --filter @pm-go/worker test");
    expect(result.message).toContain("Use `pnpm --filter <pkg> test`");
  });

  it("rewrites `pnpm test --filter=@pm-go/worker` (equals form)", () => {
    const result = normalizeTestCommand("pnpm test --filter=@pm-go/worker");
    expect(result.rewritten).toBe(true);
    expect(result.command).toBe("pnpm --filter @pm-go/worker test");
  });

  it("preserves trailing args when rewriting", () => {
    const result = normalizeTestCommand(
      "pnpm test --filter @pm-go/worker -- --reporter=verbose",
    );
    expect(result.rewritten).toBe(true);
    expect(result.command).toBe(
      "pnpm --filter @pm-go/worker test -- --reporter=verbose",
    );
  });

  it("accepts the canonical workspace-safe shape unchanged", () => {
    const result = normalizeTestCommand("pnpm --filter @pm-go/worker test");
    expect(result.rewritten).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.command).toBe("pnpm --filter @pm-go/worker test");
  });

  it("accepts plain `pnpm test` and `pnpm typecheck` unchanged", () => {
    expect(normalizeTestCommand("pnpm test").rewritten).toBe(false);
    expect(normalizeTestCommand("pnpm typecheck").rewritten).toBe(false);
    expect(normalizeTestCommand("pnpm --filter @pm-go/api typecheck").rewritten)
      .toBe(false);
  });

  it("ignores empty / whitespace strings", () => {
    expect(normalizeTestCommand("").rejected).toBe(false);
    expect(normalizeTestCommand("   ").rejected).toBe(false);
  });
});

describe("validateTaskTestCommands", () => {
  it("flags a forbidden `pnpm test --filter` command on a task", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.testCommands = [
      "pnpm typecheck",
      "pnpm test --filter @pm-go/worker",
    ];
    const issues = validateTaskTestCommands(task);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(1);
    expect(issues[0]!.suggestion).toBe("pnpm --filter @pm-go/worker test");
  });

  it("returns no issues for clean testCommands", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.testCommands = ["pnpm typecheck", "pnpm --filter @pm-go/api test"];
    expect(validateTaskTestCommands(task)).toHaveLength(0);
  });
});

describe("auditPlanTestCommands", () => {
  it("emits a high-severity finding for each offending command across all tasks", () => {
    const plan = loadPlan();
    plan.tasks[0]!.testCommands = ["pnpm test --filter @pm-go/worker"];
    if (plan.tasks[1]) {
      plan.tasks[1].testCommands = ["pnpm test --filter @pm-go/api"];
    }
    const findings = auditPlanTestCommands(plan);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    for (const f of findings) {
      expect(f.id).toBe("plan_audit.tasks.testCommands.hygiene");
      expect(f.severity).toBe("high");
    }
  });
});

describe("applyTestCommandRewrites", () => {
  it("mutates the plan in place to use workspace-safe shapes", () => {
    const plan = loadPlan();
    plan.tasks[0]!.testCommands = [
      "pnpm typecheck",
      "pnpm test --filter @pm-go/worker",
    ];
    const { rewrites, rejections } = applyTestCommandRewrites(plan);
    expect(rewrites).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(plan.tasks[0]!.testCommands[1]).toBe(
      "pnpm --filter @pm-go/worker test",
    );
  });
});
