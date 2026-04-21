import { describe, expect, it } from "vitest";

import { evaluateBudgetGate } from "../src/budget.js";

import { buildTask } from "./fixtures/task.js";
import { buildAgentRun } from "./fixtures/agent-run.js";

describe("evaluateBudgetGate", () => {
  it("returns ok when the task has no runs", () => {
    const task = buildTask();
    expect(evaluateBudgetGate(task, [])).toEqual({ ok: true });
  });

  it("returns ok when totals stay strictly under every cap", () => {
    const task = buildTask();
    const runs = [
      buildAgentRun({
        costUsd: 1,
        inputTokens: 10_000,
        outputTokens: 20_000,
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:10:00.000Z",
      }),
      buildAgentRun({
        id: "dddddddd-eeee-4fff-8000-000000000002",
        costUsd: 0.5,
        inputTokens: 5_000,
        startedAt: "2026-04-21T10:10:00.000Z",
        completedAt: "2026-04-21T10:15:00.000Z",
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });

  it("trips when USD spend exceeds maxModelCostUsd", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 45,
        maxModelCostUsd: 0.01,
        maxPromptTokens: 350_000,
      },
    });
    const runs = [
      buildAgentRun({
        costUsd: 0.05,
        inputTokens: 1000,
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:01:00.000Z",
      }),
    ];
    const result = evaluateBudgetGate(task, runs);
    expect(result).toEqual({
      ok: false,
      reason: "budget_exceeded",
      over: { usd: 0.04 },
    });
  });

  it("trips when prompt tokens exceed maxPromptTokens (input + cache)", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 45,
        maxModelCostUsd: 100,
        maxPromptTokens: 10_000,
      },
    });
    const runs = [
      buildAgentRun({
        costUsd: 0,
        inputTokens: 8_000,
        cacheCreationTokens: 2_000,
        cacheReadTokens: 5_000,
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:01:00.000Z",
      }),
    ];
    const result = evaluateBudgetGate(task, runs);
    expect(result).toEqual({
      ok: false,
      reason: "budget_exceeded",
      over: { tokens: 5_000 },
    });
  });

  it("trips when wall-clock exceeds maxWallClockMinutes", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 5,
        maxModelCostUsd: 100,
        maxPromptTokens: 1_000_000,
      },
    });
    const runs = [
      buildAgentRun({
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:12:00.000Z",
      }),
    ];
    const result = evaluateBudgetGate(task, runs);
    expect(result).toEqual({
      ok: false,
      reason: "budget_exceeded",
      over: { wallClockMinutes: 7 },
    });
  });

  it("aggregates all three dimensions when they all trip", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1,
        maxModelCostUsd: 0.5,
        maxPromptTokens: 100,
      },
    });
    const runs = [
      buildAgentRun({
        costUsd: 2,
        inputTokens: 500,
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:10:00.000Z",
      }),
    ];
    const result = evaluateBudgetGate(task, runs);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("budget_exceeded");
      expect(result.over.usd).toBeCloseTo(1.5);
      expect(result.over.tokens).toBe(400);
      expect(result.over.wallClockMinutes).toBeCloseTo(9);
    }
  });

  it("skips queued runs (they have no spend yet)", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1,
        maxModelCostUsd: 0.01,
      },
    });
    const runs = [
      buildAgentRun({
        status: "queued",
        costUsd: 99,
        inputTokens: 9_999_999,
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });

  it("counts in-flight running runs' streamed cost/tokens but not wall-clock", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 100,
        maxModelCostUsd: 0.01,
      },
    });
    const runs = [
      buildAgentRun({
        status: "running",
        costUsd: 0.1,
        inputTokens: 1000,
        // no completedAt → wall-clock contributes 0
        startedAt: "2026-04-21T10:00:00.000Z",
      }),
    ];
    const result = evaluateBudgetGate(task, runs);
    expect(result).toEqual({
      ok: false,
      reason: "budget_exceeded",
      over: { usd: 0.09 },
    });
  });

  it("ignores runs from other tasks", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1,
        maxModelCostUsd: 0.01,
      },
    });
    const runs = [
      buildAgentRun({
        taskId: "cccccccc-dddd-4eee-8fff-999999999999",
        costUsd: 999,
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });

  it("treats missing caps as permissive (undefined means no limit)", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1_000_000,
        // maxModelCostUsd and maxPromptTokens deliberately omitted
      },
    });
    const runs = [
      buildAgentRun({
        costUsd: 99999,
        inputTokens: 9_999_999,
        startedAt: "2026-04-21T10:00:00.000Z",
        completedAt: "2026-04-21T10:05:00.000Z",
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });

  it("handles malformed timestamps by not counting wall-clock", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1,
        maxModelCostUsd: 100,
      },
    });
    const runs = [
      buildAgentRun({
        startedAt: "not-an-iso-string",
        completedAt: "also-bogus",
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });

  it("does not credit negative wall-clock (completed before started)", () => {
    const task = buildTask({
      budget: {
        maxWallClockMinutes: 1,
      },
    });
    const runs = [
      buildAgentRun({
        startedAt: "2026-04-21T10:10:00.000Z",
        completedAt: "2026-04-21T10:05:00.000Z",
      }),
    ];
    expect(evaluateBudgetGate(task, runs)).toEqual({ ok: true });
  });
});
