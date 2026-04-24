/**
 * AC-cpa-05: content-filter error classification.
 *
 * Verifies that executor errors originating from the Claude CLI stream path
 * pass through `classifyExecutorError` and surface the same
 * `CONTENT_FILTER_ERROR_NAME` when the stream result carries a
 * content-filter subtype.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { CONTENT_FILTER_ERROR_NAME } from "@pm-go/contracts";

import {
  ContentFilterError,
  classifyExecutorError,
} from "@pm-go/executor-claude";

import { mapClaudeStream } from "../claude/stream-mapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(lines: string[]): Readable {
  return Readable.from(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("content-filter error passthrough (AC-cpa-05)", () => {
  it(
    "classifyExecutorError returns ContentFilterError when stream result contains content-filter message",
    async () => {
      const lines = [
        JSON.stringify({
          type: "result",
          subtype: "error_during_turn",
          session_id: "sess-filter",
          cost_usd: 0,
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: true,
          num_turns: 0,
          result: "Output blocked by content filtering policy",
        }),
      ];

      const mapped = await mapClaudeStream(makeStream(lines));

      // The stream mapper should have populated contentFilterError.
      expect(mapped.contentFilterError).toBeDefined();

      // Construct the Error the same way create-process-runners.ts would.
      const rawErr = Object.assign(
        new Error(mapped.contentFilterError!.message),
        { status: mapped.contentFilterError!.status },
      );

      const classified = classifyExecutorError(rawErr);

      expect(classified.name).toBe(CONTENT_FILTER_ERROR_NAME);
      expect(classified).toBeInstanceOf(ContentFilterError);
    },
  );

  it("classifyExecutorError preserves CONTENT_FILTER_ERROR_NAME constant value", () => {
    // Belt-and-braces: the constant must match the class name used by
    // Temporal's nonRetryableErrorNames list.
    expect(CONTENT_FILTER_ERROR_NAME).toBe("ContentFilterError");
  });

  it("classifyExecutorError does NOT classify a non-filter 400 as ContentFilterError", () => {
    const err = Object.assign(new Error("Bad request: invalid model"), {
      status: 400,
    });
    const classified = classifyExecutorError(err);
    expect(classified.name).not.toBe(CONTENT_FILTER_ERROR_NAME);
  });

  it("classifyExecutorError leaves plain Errors unchanged when no pattern matches", () => {
    const plain = new Error("network timeout");
    const classified = classifyExecutorError(plain);
    expect(classified).toBe(plain);
    expect(classified.name).toBe("Error");
  });

  it(
    "stream mapper does NOT populate contentFilterError for non-filter error results",
    async () => {
      const lines = [
        JSON.stringify({
          type: "result",
          subtype: "error_during_turn",
          session_id: "sess-other",
          cost_usd: 0,
          duration_ms: 50,
          duration_api_ms: 30,
          is_error: true,
          num_turns: 0,
          result: "An unexpected internal error occurred",
        }),
      ];
      const mapped = await mapClaudeStream(makeStream(lines));
      expect(mapped.contentFilterError).toBeUndefined();
    },
  );
});
