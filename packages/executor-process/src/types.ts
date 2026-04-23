/**
 * Canonical JSONL event discriminated union emitted by
 * `claude --output-format stream-json`. Each line of the process stdout
 * should be parsed as one of these variants.
 *
 * References:
 *   https://docs.anthropic.com/en/docs/claude-code/sdk#streaming-json-output
 */

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** A single content block inside an assistant or user message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    };

/** Token usage reported inside an assistant message. */
export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Event variants
// ---------------------------------------------------------------------------

/**
 * `system` — emitted once at the start of the stream. Contains session
 * metadata and the list of tools / MCP servers the agent has access to.
 */
export interface ClaudeStreamSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
}

/**
 * `assistant` — an assistant turn, wrapping a full Messages-API message
 * object. May contain text blocks and/or tool-use blocks.
 */
export interface ClaudeStreamAssistantEvent {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
    stop_sequence: string | null;
    usage: MessageUsage;
  };
}

/**
 * `user` — a user turn injected by the harness (e.g. tool results returned
 * to the agent after a tool-use block).
 */
export interface ClaudeStreamUserEvent {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
}

/**
 * `result` — emitted once at the end of the stream with aggregate cost
 * and duration metrics. `subtype` discriminates success from error paths.
 */
export interface ClaudeStreamResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_turn";
  session_id: string;
  /** Total cost of the session in USD. */
  cost_usd: number;
  /** Wall-clock duration of the full session in ms. */
  duration_ms: number;
  /** Cumulative Anthropic API call time in ms. */
  duration_api_ms: number;
  /** True when the session ended in an error state. */
  is_error: boolean;
  /** Number of conversation turns completed. */
  num_turns: number;
  /** The final assistant text output (last text block), if any. */
  result: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * `ClaudeStreamEvent` is the discriminated union of every JSONL event line
 * produced by `claude --output-format stream-json`. Discriminant: `type`.
 */
export type ClaudeStreamEvent =
  | ClaudeStreamSystemEvent
  | ClaudeStreamAssistantEvent
  | ClaudeStreamUserEvent
  | ClaudeStreamResultEvent;
