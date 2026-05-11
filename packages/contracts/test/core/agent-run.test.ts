import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AgentRun, AgentToolCall } from "../../src/execution.js";
import { agentRunFixturePath } from "../../src/fixtures/core/index.js";
import {
  AgentRunSchema,
  validateAgentRun,
  type AgentRunStatic
} from "../../src/validators/core/agent-run.js";
import {
  AgentToolCallSchema,
  validateAgentToolCall,
  type AgentToolCallStatic
} from "../../src/validators/core/agent-tool-call.js";

function loadFixture(): unknown {
  return JSON.parse(readFileSync(agentRunFixturePath, "utf8"));
}

describe("AgentRun contract", () => {
  it("accepts the canonical fixture", () => {
    const fixture = loadFixture();
    expect(validateAgentRun(fixture)).toBe(true);
  });

  it("rejects a fixture whose `role` is not a known AgentRole", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["role"] = "some-rogue-role";
    expect(validateAgentRun(fixture)).toBe(false);
  });

  it("rejects a fixture whose `depth` is outside 0 | 1 | 2", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["depth"] = 3;
    expect(validateAgentRun(fixture)).toBe(false);
  });

  it("rejects a fixture whose `executor` is not a known executor", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["executor"] = "openai";
    expect(validateAgentRun(fixture)).toBe(false);
  });

  it("accepts codex as an executor", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["executor"] = "codex";
    fixture["model"] = "codex-cli-default";
    expect(validateAgentRun(fixture)).toBe(true);
  });

  it("rejects a fixture missing the required `permissionMode`", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    delete fixture["permissionMode"];
    expect(validateAgentRun(fixture)).toBe(false);
  });

  it("rejects a fixture whose `status` is not a known AgentRunStatus", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["status"] = "paused";
    expect(validateAgentRun(fixture)).toBe(false);
  });

  it("accepts a minimal run with only the required fields present", () => {
    const minimal: Record<string, unknown> = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      workflowRunId: "wf-minimal",
      role: "planner",
      depth: 0,
      status: "queued",
      riskLevel: "low",
      executor: "claude",
      model: "claude-sonnet-4-6",
      promptVersion: "planner@1",
      permissionMode: "plan"
    };
    expect(validateAgentRun(minimal)).toBe(true);
  });

  it("accepts an orchestrator run scoped to a plan", () => {
    const run: Record<string, unknown> = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      planId: "7b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      workflowRunId: "wf-orchestrator",
      role: "orchestrator",
      depth: 0,
      status: "running",
      riskLevel: "low",
      executor: "claude",
      model: "claude-sonnet-4-6",
      promptVersion: "orchestrator@1",
      permissionMode: "plan"
    };
    expect(validateAgentRun(run)).toBe(true);
  });

  it("exposes a TypeBox schema with the expected $id", () => {
    expect(AgentRunSchema.$id).toBe("AgentRun");
  });

  it("has a Static<> type structurally compatible with AgentRun", () => {
    const sample: AgentRunStatic = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      workflowRunId: "wf-minimal",
      role: "implementer",
      depth: 1,
      status: "completed",
      riskLevel: "low",
      executor: "claude",
      model: "claude-sonnet-4-6",
      promptVersion: "implementer@1",
      permissionMode: "default"
    };
    const asContract: AgentRun = sample;
    expect(asContract.id).toBe(sample.id);
  });
});

describe("AgentToolCall contract", () => {
  it("accepts a completed tool call with optional references", () => {
    const toolCall: Record<string, unknown> = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      agentRunId: "7b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      sequence: 1,
      toolName: "plan.read",
      sanitizedInput: { planId: "8b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f" },
      summarizedOutput: { tasks: 3 },
      status: "completed",
      startedAt: "2026-04-18T10:40:00.000Z",
      completedAt: "2026-04-18T10:40:01.000Z",
      planId: "8b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f"
    };
    expect(validateAgentToolCall(toolCall)).toBe(true);
  });

  it("rejects a tool call whose status is not known", () => {
    const toolCall: Record<string, unknown> = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      agentRunId: "7b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      toolName: "plan.read",
      sanitizedInput: {},
      status: "queued",
      startedAt: "2026-04-18T10:40:00.000Z"
    };
    expect(validateAgentToolCall(toolCall)).toBe(false);
  });

  it("exposes a TypeBox schema with the expected $id", () => {
    expect(AgentToolCallSchema.$id).toBe("AgentToolCall");
  });

  it("has a Static<> type structurally compatible with AgentToolCall", () => {
    const sample: AgentToolCallStatic = {
      id: "6b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      agentRunId: "7b1d9c0e-3f7a-4c2d-8e5b-1a2b3c4d5e6f",
      toolName: "plan.read",
      sanitizedInput: {},
      status: "running",
      startedAt: "2026-04-18T10:40:00.000Z"
    };
    const asContract: AgentToolCall = sample;
    expect(asContract.id).toBe(sample.id);
  });
});
