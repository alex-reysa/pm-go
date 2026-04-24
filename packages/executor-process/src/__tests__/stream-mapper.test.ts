/**
 * AC-cpa-02: stream-mapper unit test.
 *
 * Feeds a JSONL fixture matching the real `claude --output-format stream-json`
 * envelope and asserts the accumulated AgentRun fields equal expected values.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { mapClaudeStream } from "../claude/stream-mapper.js";

// ---------------------------------------------------------------------------
// Helper: build a Readable from an array of JSONL lines
// ---------------------------------------------------------------------------

function makeStream(lines: string[]): Readable {
  return Readable.from(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SUCCESS_LINES = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-abc123",
    tools: ["Read", "Grep", "Glob"],
    mcp_servers: [],
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-001",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Analyzing the repository…" }],
      model: "claude-opus-4-5-20251101",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 150,
        output_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "src/index.ts\nsrc/utils.ts\n",
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-002",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: '{"id":"plan-xyz","title":"refactor utils","phases":[]}',
        },
      ],
      model: "claude-opus-4-5-20251101",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 230,
        output_tokens: 95,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 120,
      },
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-abc123",
    cost_usd: 0.00125,
    duration_ms: 3000,
    duration_api_ms: 2200,
    is_error: false,
    num_turns: 2,
    result: '{"id":"plan-xyz","title":"refactor utils","phases":[]}',
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapClaudeStream", () => {
  it("accumulates inputTokens, outputTokens, costUsd, turns, and stopReason from a success stream", async () => {
    const stream = makeStream(FIXTURE_SUCCESS_LINES);
    const result = await mapClaudeStream(stream);

    // Session id comes from the system init event (and may be overridden by
    // the result event — both carry the same id here).
    expect(result.sessionId).toBe("sess-abc123");

    // num_turns from the result event is the authoritative value.
    expect(result.turns).toBe(2);

    // Token sums: 150+230 input, 40+95 output.
    expect(result.inputTokens).toBe(380);
    expect(result.outputTokens).toBe(135);
    expect(result.cacheCreationTokens).toBe(10);
    expect(result.cacheReadTokens).toBe(120);

    // Cost from the result event.
    expect(result.costUsd).toBe(0.00125);

    // Successful stream → completed.
    expect(result.stopReason).toBe("completed");
    expect(result.isError).toBe(false);
  });

  it("exposes the raw result string and parsed structuredOutput", async () => {
    const stream = makeStream(FIXTURE_SUCCESS_LINES);
    const result = await mapClaudeStream(stream);

    expect(result.result).toBe('{"id":"plan-xyz","title":"refactor utils","phases":[]}');
    expect(result.structuredOutput).toEqual({
      id: "plan-xyz",
      title: "refactor utils",
      phases: [],
    });
  });

  it("maps error_max_turns subtype to turns_exceeded stopReason", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        session_id: "sess-001",
        cost_usd: 0.002,
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: true,
        num_turns: 10,
        result: "",
      }),
    ];
    const result = await mapClaudeStream(makeStream(lines));
    expect(result.stopReason).toBe("turns_exceeded");
    expect(result.isError).toBe(true);
    expect(result.turns).toBe(10);
    expect(result.costUsd).toBe(0.002);
  });

  it("maps error_during_turn subtype to error stopReason", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        subtype: "error_during_turn",
        session_id: "sess-002",
        cost_usd: 0,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: true,
        num_turns: 0,
        result: "An unexpected error occurred",
      }),
    ];
    const result = await mapClaudeStream(makeStream(lines));
    expect(result.stopReason).toBe("error");
    expect(result.isError).toBe(true);
  });

  it("detects content-filter errors and populates contentFilterError", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        subtype: "error_during_turn",
        session_id: "sess-003",
        cost_usd: 0,
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: true,
        num_turns: 0,
        result: "Output blocked by content filtering policy",
      }),
    ];
    const result = await mapClaudeStream(makeStream(lines));
    expect(result.contentFilterError).toBeDefined();
    expect(result.contentFilterError?.status).toBe(400);
    expect(result.contentFilterError?.message).toMatch(/content.filter/i);
  });

  it("skips blank lines and non-JSON lines without throwing", async () => {
    const lines = [
      "",
      "not-json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "sess-004",
        cost_usd: 0.001,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        result: "done",
      }),
    ];
    const result = await mapClaudeStream(makeStream(lines));
    expect(result.costUsd).toBe(0.001);
    expect(result.sessionId).toBe("sess-004");
  });
});
