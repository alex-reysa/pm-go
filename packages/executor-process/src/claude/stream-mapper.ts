/**
 * Line-by-line JSONL stream mapper for `claude --output-format stream-json`.
 *
 * Reads the child process's stdout line by line, parses each line as a
 * `ClaudeStreamEvent`, and accumulates the token counters, cost, turn count,
 * stop reason, and final structured output that the caller needs to build an
 * `AgentRun` record.
 */

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { AgentStopReason } from "@pm-go/contracts";

import type { ClaudeStreamEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface StreamMapResult {
  /** Session id from the `system` init event (or the `result` event). */
  sessionId?: string;
  /**
   * Number of assistant + user message turns observed in the stream.
   * The `result` event's `num_turns` field overrides this if present.
   */
  turns: number;
  /** Cumulative input tokens (sum across all assistant messages). */
  inputTokens: number;
  /** Cumulative output tokens (sum across all assistant messages). */
  outputTokens: number;
  /** Cumulative cache-creation tokens. */
  cacheCreationTokens: number;
  /** Cumulative cache-read tokens. */
  cacheReadTokens: number;
  /** Total cost in USD from the `result` event. */
  costUsd: number;
  /** Derived stop reason. */
  stopReason: AgentStopReason;
  /** Raw text from `result.result` (final assistant message or JSON blob). */
  result?: string;
  /**
   * If `result` is valid JSON, this is the parsed value.  Used by runners
   * that invoke Claude with a `--output-format json` or structured-output
   * schema so the response can be returned as `plan` / `report`.
   */
  structuredOutput?: unknown;
  /** True when the stream ended in an error state (`result.is_error`). */
  isError: boolean;
  /**
   * When the result event signals an error whose text matches a known
   * content-filter pattern, we pre-build an object that
   * `classifyExecutorError` will recognise as a `ContentFilterError`.
   * The caller can throw this after the stream is exhausted.
   */
  contentFilterError?: { status: number; message: string };
}

// ---------------------------------------------------------------------------
// mapClaudeStream
// ---------------------------------------------------------------------------

/**
 * Consume a readable stream of JSONL events emitted by the Claude CLI
 * (`--output-format stream-json`) and return an accumulated result.
 *
 * Malformed / non-JSON lines are silently skipped so a partial debug line
 * at the end of a failed run does not crash the mapper.
 */
export async function mapClaudeStream(
  stream: Readable,
): Promise<StreamMapResult> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const acc: StreamMapResult = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    stopReason: "completed",
    isError: false,
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(trimmed) as ClaudeStreamEvent;
    } catch {
      continue;
    }

    accumulateEvent(acc, event);
  }

  return acc;
}

// ---------------------------------------------------------------------------
// Internal accumulator
// ---------------------------------------------------------------------------

function accumulateEvent(acc: StreamMapResult, event: ClaudeStreamEvent): void {
  switch (event.type) {
    case "system": {
      acc.sessionId = event.session_id;
      break;
    }

    case "assistant": {
      acc.turns += 1;
      const usage = event.message.usage;
      acc.inputTokens += usage.input_tokens;
      acc.outputTokens += usage.output_tokens;
      acc.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      // An early `max_tokens` stop on an assistant message signals turns
      // exceeded; the result event may override this below.
      if (event.message.stop_reason === "max_tokens") {
        acc.stopReason = "turns_exceeded";
      }
      break;
    }

    case "user": {
      acc.turns += 1;
      break;
    }

    case "result": {
      acc.sessionId = event.session_id;
      acc.costUsd = event.cost_usd;
      acc.isError = event.is_error;
      acc.result = event.result;

      // result.num_turns is the authoritative turn count.
      acc.turns = event.num_turns;

      // Map CLI subtype → AgentStopReason.
      switch (event.subtype) {
        case "success":
          acc.stopReason = "completed";
          break;
        case "error_max_turns":
          acc.stopReason = "turns_exceeded";
          break;
        case "error_during_turn":
          acc.stopReason = "error";
          acc.isError = true;
          break;
      }

      // Try to parse result as JSON for structured-output callers.
      if (event.result) {
        try {
          acc.structuredOutput = JSON.parse(event.result);
        } catch {
          /* result is plain text — leave structuredOutput undefined */
        }
      }

      // Detect content-filter errors: the CLI puts the filter message in
      // `result` and sets `is_error: true`.  We surface a shaped object so
      // callers can pass it to `classifyExecutorError` from
      // `@pm-go/executor-claude/src/errors`.
      if (
        acc.isError &&
        event.result &&
        /content[-_ ]?filter/i.test(event.result)
      ) {
        acc.contentFilterError = { status: 400, message: event.result };
      }

      break;
    }
  }
}
