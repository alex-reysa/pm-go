import {
  query,
  type Options as ClaudeAgentOptions,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentStopReason } from "@pm-go/contracts";

import {
  OPERATOR_ORCHESTRATOR_SYSTEM_PROMPT,
  buildOperatorPrompt,
} from "./prompt.js";
import {
  ApiAgentRunPersistence,
  type AgentRunPersistence,
} from "./persistence.js";
import {
  PMGO_TOOL_NAMES,
  createPmGoSdkMcpServer,
  type PmGoToolHandlers,
} from "./tools.js";
import type { OperatorAgentOptions, OperatorAgentResult } from "./types.js";

export interface OperatorAgentDeps {
  queryFn?: typeof query;
  persistence?: AgentRunPersistence;
  fetchImpl?: typeof globalThis.fetch;
  handlers?: PmGoToolHandlers;
  now?: () => Date;
  log?: (line: string) => void;
  prompt?: string;
}

export async function runOperatorAgent(
  rawOptions: OperatorAgentOptions,
  deps: OperatorAgentDeps = {},
): Promise<OperatorAgentResult> {
  const options = normalizeOptions(rawOptions);
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const persistence =
    deps.persistence ??
    new ApiAgentRunPersistence({
      apiUrl: options.apiUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });

  const agentRun = await persistence.createRun({ options, startedAt });
  const queryFn = deps.queryFn ?? query;
  const mcpServer = createPmGoSdkMcpServer({
    agentRunId: agentRun.id,
    options,
    persistence,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.handlers !== undefined ? { handlers: deps.handlers } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  let sessionId: string | undefined;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let costUsd: number | undefined;
  let stopReason: AgentStopReason = "completed";
  let resultText = "";

  try {
    const promptInput = {
      ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
      ...(options.specPath !== undefined ? { specPath: options.specPath } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      runtime: options.runtime,
      approve: options.approve,
      ...(options.resumeSessionId !== undefined
        ? { resumeSessionId: options.resumeSessionId }
        : {}),
    };
    const queryOptions: ClaudeAgentOptions = {
      systemPrompt: OPERATOR_ORCHESTRATOR_SYSTEM_PROMPT,
      permissionMode: "default",
      settingSources: [],
      tools: [],
      mcpServers: {
        "pm-go": mcpServer,
      },
      allowedTools: allowedMcpToolNames(),
      disallowedTools: [
        "Task",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "NotebookEdit",
        "Grep",
        "Glob",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
      ],
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.resumeSessionId !== undefined
        ? { resume: options.resumeSessionId }
        : options.resume !== undefined
          ? { resume: options.resume }
          : {}),
      ...(typeof options.maxBudgetUsd === "number"
        ? { maxBudgetUsd: options.maxBudgetUsd }
        : {}),
      ...(typeof options.maxTurns === "number"
        ? { maxTurns: options.maxTurns }
        : {}),
      canUseTool: async (toolName, toolInput) => {
        if (allowedMcpToolNameSet.has(toolName)) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: `root orchestrator may only call typed pm-go tools; denied ${toolName}`,
        };
      },
    };

    const iter = queryFn({
      prompt: deps.prompt ?? buildOperatorPrompt({
        ...promptInput,
        ...(options.resumeSessionId === undefined && options.resume !== undefined
          ? { resumeSessionId: options.resume }
          : {}),
      }),
      options: queryOptions,
    });

    for await (const message of iter as AsyncIterable<SDKMessage>) {
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant" || message.type === "user") {
        turns += 1;
      }
      if (message.type === "assistant") {
        resultText += extractAssistantText(message);
        const usage = extractUsage(message);
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cacheCreationTokens += usage.cacheCreationTokens;
        cacheReadTokens += usage.cacheReadTokens;
      }
      if (message.type === "result") {
        const result = message as SDKMessage & {
          subtype?: string;
          result?: string;
          total_cost_usd?: number;
          usage?: unknown;
          num_turns?: number;
        };
        if (typeof result.result === "string") {
          resultText = result.result;
        }
        if (typeof result.total_cost_usd === "number") {
          costUsd = result.total_cost_usd;
        }
        if (typeof result.num_turns === "number") {
          turns = result.num_turns;
        }
        const usage = normalizeUsage(result.usage);
        if (usage.totalSeen) {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
          cacheCreationTokens = usage.cacheCreationTokens;
          cacheReadTokens = usage.cacheReadTokens;
        }
        if (typeof result.subtype === "string") {
          stopReason = mapStopReason(result.subtype);
        }
      }
    }

    await persistence.updateRun({
      agentRunId: agentRun.id,
      ...(sessionId !== undefined ? { sessionId } : {}),
      status: "completed",
      turns,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      stopReason,
      completedAt: now().toISOString(),
    });

    return {
      agentRunId: agentRun.id,
      ...(sessionId !== undefined ? { sessionId } : {}),
      status: "completed",
      turns,
      ...(costUsd !== undefined ? { costUsd } : {}),
      stopReason,
      text: resultText,
    };
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : String(err);
    await persistence.updateRun({
      agentRunId: agentRun.id,
      ...(sessionId !== undefined ? { sessionId } : {}),
      status: "failed",
      turns,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      stopReason: "error",
      errorReason,
      completedAt: now().toISOString(),
    });

    return {
      agentRunId: agentRun.id,
      ...(sessionId !== undefined ? { sessionId } : {}),
      status: "failed",
      turns,
      ...(costUsd !== undefined ? { costUsd } : {}),
      stopReason: "error",
      errorReason,
      text: errorReason,
    };
  }
}

export function normalizeOptions(
  options: OperatorAgentOptions,
): OperatorAgentOptions & { apiUrl: string } {
  const apiUrl =
    options.apiUrl?.replace(/\/+$/, "") ??
    `http://127.0.0.1:${options.apiPort ?? 3001}`;
  return {
    ...options,
    apiUrl,
    ...(options.resumeSessionId === undefined && options.resume !== undefined
      ? { resumeSessionId: options.resume }
      : {}),
  };
}

const allowedMcpToolNameSet = new Set(allowedMcpToolNames());

function allowedMcpToolNames(): string[] {
  return PMGO_TOOL_NAMES.flatMap((name) => [
    name,
    `mcp__pm-go__${name}`,
    `mcp__pm_go__${name}`,
  ]);
}

function extractAssistantText(message: SDKMessage): string {
  if (
    message.type !== "assistant" ||
    !("message" in message) ||
    !message.message ||
    typeof message.message !== "object"
  ) {
    return "";
  }
  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function extractUsage(message: SDKMessage) {
  if (
    message.type !== "assistant" ||
    !("message" in message) ||
    !message.message ||
    typeof message.message !== "object" ||
    !("usage" in message.message)
  ) {
    return emptyUsage();
  }
  return normalizeUsage((message.message as { usage?: unknown }).usage);
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalSeen: false,
  };
}

function normalizeUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const obj = usage as Record<string, unknown>;
  return {
    inputTokens: typeof obj.input_tokens === "number" ? obj.input_tokens : 0,
    outputTokens: typeof obj.output_tokens === "number" ? obj.output_tokens : 0,
    cacheCreationTokens:
      typeof obj.cache_creation_input_tokens === "number"
        ? obj.cache_creation_input_tokens
        : 0,
    cacheReadTokens:
      typeof obj.cache_read_input_tokens === "number"
        ? obj.cache_read_input_tokens
        : 0,
    totalSeen: true,
  };
}

function mapStopReason(subtype: string): AgentStopReason {
  if (subtype.includes("budget")) return "budget_exceeded";
  if (subtype.includes("turn")) return "turns_exceeded";
  if (subtype.includes("canceled")) return "canceled";
  if (subtype.includes("timeout")) return "timeout";
  if (subtype.includes("error")) return "error";
  return "completed";
}
