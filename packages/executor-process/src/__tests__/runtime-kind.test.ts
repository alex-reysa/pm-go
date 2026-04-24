/**
 * AC-d8-02: _runtimeKind discriminant test.
 *
 * Verifies that:
 *   1. createClaudeProcessPlannerRunner()._runtimeKind === 'process'
 *   2. The SDK-backed planner runner exposes _runtimeKind === 'sdk'
 *
 * The external SDK and contracts packages are mocked so we can import the
 * runner factories without requiring a live API key, SDK binary, or TypeBox.
 */

import { vi, describe, expect, it } from "vitest";

// Mock the Claude Agent SDK so the planner-runner module can be imported
// without the native binary being present.  The factory only calls `query`
// inside `.run()`, which we never invoke here.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock @pm-go/contracts to avoid the TypeBox dependency that is not
// installed in the test-runner environment (only available in the main
// repo node_modules, not the worktree).  We only need the type
// definitions, which are erased at runtime anyway.
// Include CONTENT_FILTER_ERROR_NAME because errors.ts re-exports it.
vi.mock("@pm-go/contracts", () => ({
  CONTENT_FILTER_ERROR_NAME: "ContentFilterError",
}));

import { createClaudeProcessPlannerRunner } from "../create-process-runners.js";
import { createClaudePlannerRunner } from "@pm-go/executor-claude";

describe("_runtimeKind discriminant", () => {
  it("process planner runner has _runtimeKind === 'process'", () => {
    const runner = createClaudeProcessPlannerRunner();
    expect(runner._runtimeKind).toBe("process");
  });

  it("SDK planner runner has _runtimeKind === 'sdk'", () => {
    const runner = createClaudePlannerRunner();
    expect(runner._runtimeKind).toBe("sdk");
  });
});
