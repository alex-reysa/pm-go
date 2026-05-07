import { describe, expect, it, vi } from "vitest";

import { MemoryAgentRunPersistence } from "../src/persistence.js";
import { OPERATOR_ORCHESTRATOR_PROMPT_VERSION } from "../src/prompt.js";
import { runOperatorAgent } from "../src/runner.js";

const SESSION_ID = "55555555-6666-4777-8888-999999999999";

describe("runOperatorAgent", () => {
  it("persists a completed orchestrator run from SDK result messages", async () => {
    const persistence = new MemoryAgentRunPersistence();
    const seenParams: unknown[] = [];
    const queryFn = vi.fn((params: unknown) => {
      seenParams.push(params);
      return (async function* () {
        yield {
          type: "assistant",
          session_id: SESSION_ID,
          message: {
            content: [{ type: "text", text: "Working\n" }],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
            },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: SESSION_ID,
          result: "released",
          total_cost_usd: 0.25,
          num_turns: 2,
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        };
      })();
    });

    const result = await runOperatorAgent(
      {
        repoRoot: "/tmp/repo",
        specPath: "/tmp/spec.md",
        runtime: "stub",
        approve: "all",
        yes: true,
        maxTurns: 8,
        maxBudgetUsd: 1.5,
      },
      {
        persistence,
        queryFn: queryFn as never,
        now: () => new Date("2026-05-07T10:00:00.000Z"),
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        agentRunId: persistence.runs[0]!.id,
        sessionId: SESSION_ID,
        status: "completed",
        turns: 2,
        costUsd: 0.25,
        text: "released",
      }),
    );
    expect(persistence.runs[0]).toEqual(
      expect.objectContaining({
        role: "orchestrator",
        promptVersion: OPERATOR_ORCHESTRATOR_PROMPT_VERSION,
        status: "completed",
        sessionId: SESSION_ID,
        stopReason: "completed",
        turns: 2,
        inputTokens: 12,
        outputTokens: 5,
      }),
    );
    const params = seenParams[0] as {
      options: {
        tools?: unknown[];
        allowedTools?: string[];
        disallowedTools?: string[];
        maxTurns?: number;
        maxBudgetUsd?: number;
      };
    };
    expect(params.options.tools).toEqual([]);
    expect(params.options.allowedTools).toContain("pmgo_status");
    expect(params.options.disallowedTools).toContain("Bash");
    expect(params.options.maxTurns).toBe(8);
    expect(params.options.maxBudgetUsd).toBe(1.5);
  });

  it("maps resume aliases onto SDK resume and persisted parent session", async () => {
    const persistence = new MemoryAgentRunPersistence();
    const queryFn = vi.fn((_params: unknown) => {
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          session_id: SESSION_ID,
          result: "resumed",
          num_turns: 1,
        };
      })();
    });

    await runOperatorAgent(
      {
        repoRoot: "/tmp/repo",
        runtime: "stub",
        approve: "interactive",
        yes: false,
        resume: SESSION_ID,
      },
      {
        persistence,
        queryFn: queryFn as never,
      },
    );

    expect(persistence.runs[0]).toEqual(
      expect.objectContaining({
        parentSessionId: SESSION_ID,
      }),
    );
    expect(queryFn.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: SESSION_ID,
        }),
      }),
    );
  });

  it("persists failed runs when the SDK query throws", async () => {
    const persistence = new MemoryAgentRunPersistence();
    const queryFn = vi.fn(() => {
      throw new Error("sdk unavailable");
    });

    const result = await runOperatorAgent(
      {
        repoRoot: "/tmp/repo",
        runtime: "stub",
        approve: "interactive",
        yes: false,
      },
      {
        persistence,
        queryFn: queryFn as never,
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        stopReason: "error",
        errorReason: "sdk unavailable",
      }),
    );
    expect(persistence.runs[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        stopReason: "error",
        errorReason: "sdk unavailable",
      }),
    );
  });
});
