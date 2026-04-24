/**
 * AC-cpa-03: policy-bridge unit test.
 *
 * Verifies that:
 *   1. A planner-role bridge rejects a Write tool call with a policy_decision
 *      denial event.
 *   2. An implementer-role bridge allows a Write inside Task.fileScope but
 *      rejects one outside it.
 */

import { describe, expect, it } from "vitest";
import {
  evaluatePolicyGate,
  evaluatePolicyGateWithSink,
  type PolicyBridgeConfig,
  type PolicyBridgeEvent,
} from "../claude/policy-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvents(): {
  events: PolicyBridgeEvent[];
  sink: (e: PolicyBridgeEvent) => void;
} {
  const events: PolicyBridgeEvent[] = [];
  return {
    events,
    sink: (e) => events.push(e),
  };
}

const WORKTREE = "/workspace/repo";

const IMPLEMENTER_FILE_SCOPE = {
  includes: ["packages/executor-process/src/**"],
  excludes: [] as string[],
};

// ---------------------------------------------------------------------------
// Planner role: always read-only
// ---------------------------------------------------------------------------

describe("planner role policy gate", () => {
  it("denies Write tool calls", () => {
    const config: PolicyBridgeConfig = { role: "planner" };
    const result = evaluatePolicyGate(
      "Write",
      { file_path: "/workspace/repo/src/foo.ts", content: "hello" },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/read-only/i);
  });

  it("denies Edit tool calls", () => {
    const config: PolicyBridgeConfig = { role: "planner" };
    const result = evaluatePolicyGate(
      "Edit",
      {
        file_path: "/workspace/repo/src/foo.ts",
        old_string: "a",
        new_string: "b",
      },
      config,
    );
    expect(result.allowed).toBe(false);
  });

  it("allows Read tool calls", () => {
    const config: PolicyBridgeConfig = {
      role: "planner",
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Read",
      { file_path: `${WORKTREE}/src/index.ts` },
      config,
    );
    expect(result.allowed).toBe(true);
  });

  it("emits tool_call and policy_decision events for denied Write", async () => {
    const { events, sink } = makeEvents();
    const config: PolicyBridgeConfig = { role: "planner", sink };

    await evaluatePolicyGateWithSink(
      "Write",
      { file_path: "/workspace/repo/src/foo.ts", content: "x" },
      config,
    );

    const toolCallEvent = events.find((e) => e.kind === "tool_call");
    const policyDecisionEvent = events.find((e) => e.kind === "policy_decision");

    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent?.toolName).toBe("Write");

    expect(policyDecisionEvent).toBeDefined();
    if (policyDecisionEvent?.kind === "policy_decision") {
      expect(policyDecisionEvent.allowed).toBe(false);
      expect(policyDecisionEvent.toolName).toBe("Write");
    }
  });
});

// ---------------------------------------------------------------------------
// Reviewer role: read-only (same as planner)
// ---------------------------------------------------------------------------

describe("reviewer role policy gate", () => {
  it("denies Write tool calls", () => {
    const config: PolicyBridgeConfig = { role: "reviewer" };
    const result = evaluatePolicyGate(
      "Write",
      { file_path: "/workspace/repo/src/foo.ts", content: "" },
      config,
    );
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Implementer role: writes gated by fileScope
// ---------------------------------------------------------------------------

describe("implementer role policy gate", () => {
  it("allows Write inside fileScope.includes", () => {
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: IMPLEMENTER_FILE_SCOPE,
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Write",
      {
        file_path: "packages/executor-process/src/claude/my-new-file.ts",
        content: "// new",
      },
      config,
    );
    expect(result.allowed).toBe(true);
  });

  it("denies Write outside fileScope.includes", () => {
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: IMPLEMENTER_FILE_SCOPE,
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Write",
      {
        file_path: "packages/executor-claude/src/something.ts",
        content: "// bad",
      },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/fileScope\.includes/);
  });

  it("denies Write matching fileScope.excludes even when includes matches", () => {
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: {
        includes: ["packages/**"],
        excludes: ["packages/executor-process/src/secret/**"],
      },
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Write",
      {
        file_path: "packages/executor-process/src/secret/vault.ts",
        content: "x",
      },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/fileScope\.excludes/);
  });

  it("denies Write to .git directory", () => {
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: {
        includes: ["**"],
      },
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Write",
      { file_path: ".git/config", content: "" },
      config,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/\.git\//);
  });

  it("emits tool_call and policy_decision events for both allow and deny", async () => {
    const { events, sink } = makeEvents();
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: IMPLEMENTER_FILE_SCOPE,
      worktreePath: WORKTREE,
      sink,
    };

    // Allowed call
    await evaluatePolicyGateWithSink(
      "Write",
      {
        file_path: "packages/executor-process/src/claude/foo.ts",
        content: "x",
      },
      config,
    );

    // Denied call
    await evaluatePolicyGateWithSink(
      "Write",
      {
        file_path: "packages/executor-claude/src/forbidden.ts",
        content: "x",
      },
      config,
    );

    const decisionEvents = events.filter((e) => e.kind === "policy_decision");
    expect(decisionEvents).toHaveLength(2);

    const [allowed, denied] = decisionEvents;
    if (allowed?.kind === "policy_decision") {
      expect(allowed.allowed).toBe(true);
    }
    if (denied?.kind === "policy_decision") {
      expect(denied.allowed).toBe(false);
    }
  });

  it("allows Read calls within the worktree", () => {
    const config: PolicyBridgeConfig = {
      role: "implementer",
      fileScope: IMPLEMENTER_FILE_SCOPE,
      worktreePath: WORKTREE,
    };
    const result = evaluatePolicyGate(
      "Read",
      { file_path: `${WORKTREE}/src/index.ts` },
      config,
    );
    expect(result.allowed).toBe(true);
  });
});
