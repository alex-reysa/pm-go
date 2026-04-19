import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReviewFinding, ReviewReport, Task } from "@pm-go/contracts";

import { evaluateReviewPolicy } from "../src/workflows/review-policy.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const baseTask: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function task(overrides: Partial<Task> = {}): Task {
  return {
    ...baseTask,
    ...overrides,
    reviewerPolicy: {
      ...baseTask.reviewerPolicy,
      ...(overrides.reviewerPolicy ?? {}),
    },
  };
}

function finding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    id: `f-${severity}-${Math.random().toString(36).slice(2, 6)}`,
    severity,
    title: "finding",
    summary: "test",
    filePath: "x.ts",
    confidence: 0.7,
    suggestedFixDirection: "fix it",
  };
}

function report(
  outcome: ReviewReport["outcome"],
  findings: ReviewFinding[] = [],
): ReviewReport {
  return {
    id: "11111111-aaaa-4bbb-8ccc-000000000001",
    taskId: baseTask.id,
    reviewerRunId: "22222222-aaaa-4bbb-8ccc-000000000002",
    outcome,
    findings,
    createdAt: "2026-04-19T10:00:00.000Z",
  };
}

describe("evaluateReviewPolicy", () => {
  it("branch: pass → ready_to_merge / approved", () => {
    const decision = evaluateReviewPolicy(report("pass"), task(), 1);
    expect(decision.nextStatus).toBe("ready_to_merge");
    expect(decision.decision).toBe("approved");
    expect(decision.reason).toBe("approved");
  });

  it("branch: blocked → blocked / rejected / reviewer_blocked (short-circuits cycle rules)", () => {
    const decision = evaluateReviewPolicy(
      report("blocked", [finding("high")]),
      // Even with cycle 1 and room left, blocked from reviewer goes straight
      // to `blocked`. Fix cycles don't get to decide the reviewer was wrong.
      task({ maxReviewFixCycles: 2 }),
      1,
    );
    expect(decision.nextStatus).toBe("blocked");
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toBe("reviewer_blocked");
  });

  it("branch: changes_requested + high-severity count > cap → blocked / rejected / high_severity_cap", () => {
    const t = task({
      maxReviewFixCycles: 2,
      reviewerPolicy: {
        ...baseTask.reviewerPolicy,
        stopOnHighSeverityCount: 1,
      },
    });
    // Two high-severity findings — exceeds stopOnHighSeverityCount=1.
    const decision = evaluateReviewPolicy(
      report("changes_requested", [finding("high"), finding("high"), finding("medium")]),
      t,
      1, // cycle 1, well below cap — but high-severity beats cycle
    );
    expect(decision.nextStatus).toBe("blocked");
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toBe("high_severity_cap");
  });

  it("branch: changes_requested + cycle >= cap (no high-severity cap hit) → blocked / retry_denied / cycle_cap", () => {
    const t = task({
      maxReviewFixCycles: 2,
      reviewerPolicy: {
        ...baseTask.reviewerPolicy,
        stopOnHighSeverityCount: 1,
      },
    });
    const decision = evaluateReviewPolicy(
      report("changes_requested", [finding("medium"), finding("medium")]),
      t,
      2, // already at cap
    );
    expect(decision.nextStatus).toBe("blocked");
    expect(decision.decision).toBe("retry_denied");
    expect(decision.reason).toBe("cycle_cap");
  });

  it("branch: changes_requested + cycle < cap + severity under cap → fixing / retry_allowed", () => {
    const t = task({
      maxReviewFixCycles: 2,
      reviewerPolicy: {
        ...baseTask.reviewerPolicy,
        stopOnHighSeverityCount: 1,
      },
    });
    const decision = evaluateReviewPolicy(
      report("changes_requested", [finding("medium"), finding("high")]),
      t,
      1,
    );
    expect(decision.nextStatus).toBe("fixing");
    expect(decision.decision).toBe("retry_allowed");
    expect(decision.reason).toBe("retry_allowed");
  });
});
