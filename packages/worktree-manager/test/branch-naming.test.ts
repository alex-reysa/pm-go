import { describe, expect, it } from "vitest";

import { buildBranchName } from "../src/branch-naming.js";

// Short UUID-like placeholders so the `<planId>/<taskId>-` prefix fits
// inside the 80-char body cap and the slug survives the truncation.
// Real UUIDs are 36 chars and will force slug truncation on any task
// with a non-trivial slug — which is why the real fixture sets short IDs
// for branch-naming tests here; the 80-char hard cap is verified
// separately below.
const PLAN_ID = "plan-01";
const TASK_ID = "task-01";

describe("buildBranchName", () => {
  it("produces agent/<planId>/<taskId>-<slug> for well-formed input", () => {
    const name = buildBranchName({
      planId: PLAN_ID,
      taskId: TASK_ID,
      slug: "add-worktree-manager",
    });
    expect(name.startsWith("agent/")).toBe(true);
    // The `agent/` prefix is excluded from the 80-char cap.
    expect(name.length - "agent/".length).toBeLessThanOrEqual(80);
    expect(name).toContain(PLAN_ID);
    expect(name).toContain(TASK_ID);
    expect(name).toMatch(/-add-worktree-manager$/);
    expect(name).toBe("agent/plan-01/task-01-add-worktree-manager");
  });

  it("replaces spaces with dashes and lowercases", () => {
    const name = buildBranchName({
      planId: PLAN_ID,
      taskId: TASK_ID,
      slug: "Add Worktree Manager",
    });
    expect(name).toMatch(/-add-worktree-manager$/);
  });

  it("sanitizes unsafe characters", () => {
    const name = buildBranchName({
      planId: PLAN_ID,
      taskId: TASK_ID,
      slug: "feat/write-capable!!",
    });
    expect(name).toMatch(/-feat-write-capable$/);
    // agent/ prefix contains a slash — look only at the body.
    expect(name.slice("agent/".length)).not.toMatch(/[!]/);
  });

  it("truncates to 80 chars after the agent/ prefix", () => {
    const longSlug = "x".repeat(200);
    const name = buildBranchName({
      planId: PLAN_ID,
      taskId: TASK_ID,
      slug: longSlug,
    });
    expect(name.startsWith("agent/")).toBe(true);
    expect(name.length - "agent/".length).toBe(80);
  });
});
