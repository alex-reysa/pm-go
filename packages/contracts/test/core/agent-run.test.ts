import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AgentRun } from "../../src/execution.js";
import { agentRunFixturePath } from "../../src/fixtures/core/index.js";
import {
  AgentRunSchema,
  validateAgentRun,
  type AgentRunStatic
} from "../../src/validators/core/agent-run.js";

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

  it("rejects a fixture whose `executor` is not the literal 'claude'", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["executor"] = "openai";
    expect(validateAgentRun(fixture)).toBe(false);
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
