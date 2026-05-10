import { randomUUID } from "node:crypto";

import type { AgentRun, AgentStopReason, UUID } from "@pm-go/contracts";

import { OPERATOR_ORCHESTRATOR_PROMPT_VERSION } from "./prompt.js";
import type { OperatorAgentOptions, ToolCallRecord } from "./types.js";

export interface AgentRunPersistence {
  createRun(input: {
    options: OperatorAgentOptions;
    startedAt: string;
  }): Promise<AgentRun>;
  updateRun(input: {
    agentRunId: UUID;
    sessionId?: string;
    status: "completed" | "failed" | "canceled" | "timed_out";
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd?: number;
    stopReason?: AgentStopReason;
    errorReason?: string;
    completedAt: string;
  }): Promise<void>;
  linkRunToPlan(input: {
    agentRunId: UUID;
    planId: UUID;
  }): Promise<void>;
  createToolCall(input: ToolCallRecord): Promise<void>;
  updateToolCall(input: ToolCallRecord): Promise<void>;
}

export class ApiAgentRunPersistence implements AgentRunPersistence {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiUrl: string;

  constructor(input: {
    apiUrl: string;
    fetchImpl?: typeof globalThis.fetch;
  }) {
    this.apiUrl = input.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async createRun(input: {
    options: OperatorAgentOptions;
    startedAt: string;
  }): Promise<AgentRun> {
    const run: AgentRun = {
      id: randomUUID(),
      ...(input.options.resumeSessionId !== undefined
        ? { parentSessionId: input.options.resumeSessionId }
        : {}),
      workflowRunId: `operator-${randomUUID()}`,
      role: "orchestrator",
      depth: 0,
      status: "running",
      riskLevel: "low",
      executor: "claude",
      model: input.options.model ?? "claude-opus-4-7",
      promptVersion: OPERATOR_ORCHESTRATOR_PROMPT_VERSION,
      permissionMode: "default",
      ...(typeof input.options.maxBudgetUsd === "number"
        ? { budgetUsdCap: input.options.maxBudgetUsd }
        : {}),
      ...(typeof input.options.maxTurns === "number"
        ? { maxTurnsCap: input.options.maxTurns }
        : {}),
      startedAt: input.startedAt,
    };

    const res = await this.fetchImpl(`${this.apiUrl}/agent-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(run),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST /agent-runs -> ${res.status}: ${text}`);
    }
    return run;
  }

  async updateRun(input: {
    agentRunId: UUID;
    sessionId?: string;
    status: "completed" | "failed" | "canceled" | "timed_out";
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd?: number;
    stopReason?: AgentStopReason;
    errorReason?: string;
    completedAt: string;
  }): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/agent-runs/${input.agentRunId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PATCH /agent-runs/${input.agentRunId} -> ${res.status}: ${text}`);
    }
  }

  async linkRunToPlan(input: {
    agentRunId: UUID;
    planId: UUID;
  }): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/agent-runs/${input.agentRunId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: input.planId }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PATCH /agent-runs/${input.agentRunId} -> ${res.status}: ${text}`);
    }
  }

  async createToolCall(input: ToolCallRecord): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/agent-runs/${input.agentRunId}/tool-calls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `POST /agent-runs/${input.agentRunId}/tool-calls -> ${res.status}: ${text}`,
      );
    }
  }

  async updateToolCall(input: ToolCallRecord): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/agent-runs/${input.agentRunId}/tool-calls/${input.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `PATCH /agent-runs/${input.agentRunId}/tool-calls/${input.id} -> ${res.status}: ${text}`,
      );
    }
  }
}

export class MemoryAgentRunPersistence implements AgentRunPersistence {
  readonly runs: AgentRun[] = [];
  readonly toolCalls: ToolCallRecord[] = [];

  async createRun(input: {
    options: OperatorAgentOptions;
    startedAt: string;
  }): Promise<AgentRun> {
    const run: AgentRun = {
      id: randomUUID(),
      ...(input.options.resumeSessionId !== undefined
        ? { parentSessionId: input.options.resumeSessionId }
        : {}),
      workflowRunId: `operator-${randomUUID()}`,
      role: "orchestrator",
      depth: 0,
      status: "running",
      riskLevel: "low",
      executor: "claude",
      model: input.options.model ?? "claude-opus-4-7",
      promptVersion: OPERATOR_ORCHESTRATOR_PROMPT_VERSION,
      permissionMode: "default",
      startedAt: input.startedAt,
    };
    this.runs.push(run);
    return run;
  }

  async updateRun(input: {
    agentRunId: UUID;
    sessionId?: string;
    status: "completed" | "failed" | "canceled" | "timed_out";
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd?: number;
    stopReason?: AgentStopReason;
    errorReason?: string;
    completedAt: string;
  }): Promise<void> {
    const idx = this.runs.findIndex((r) => r.id === input.agentRunId);
    if (idx < 0) return;
    this.runs[idx] = {
      ...this.runs[idx]!,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      status: input.status,
      turns: input.turns,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      cacheReadTokens: input.cacheReadTokens,
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      ...(input.errorReason !== undefined ? { errorReason: input.errorReason } : {}),
      completedAt: input.completedAt,
    };
  }

  async linkRunToPlan(input: {
    agentRunId: UUID;
    planId: UUID;
  }): Promise<void> {
    const idx = this.runs.findIndex((r) => r.id === input.agentRunId);
    if (idx < 0) return;
    this.runs[idx] = {
      ...this.runs[idx]!,
      planId: input.planId,
    };
  }

  async createToolCall(input: ToolCallRecord): Promise<void> {
    this.toolCalls.push(input);
  }

  async updateToolCall(input: ToolCallRecord): Promise<void> {
    const idx = this.toolCalls.findIndex((c) => c.id === input.id);
    if (idx < 0) {
      this.toolCalls.push(input);
      return;
    }
    this.toolCalls[idx] = input;
  }
}
