/**
 * Policy bridge for the Claude CLI process runner.
 *
 * Provides two things:
 *
 * 1. A pure `evaluatePolicyGate` function that encodes the same role-based
 *    and fileScope-based access rules used in the SDK-backed implementer
 *    runner's `canUseTool` callback.  This is the testable core.
 *
 * 2. A `createPolicyBridgeServer` factory that wraps the gate in a plain
 *    `node:http` MCP server (JSON-RPC 2.0, Streamable HTTP transport) so
 *    the spawned Claude CLI can be pointed at it via `--mcp-server-url`.
 *    The server intercepts every `tools/call` request, runs the gate, emits
 *    `tool_call` + `policy_decision` events to the passed-in sink, and
 *    either proxies allowed calls or returns an MCP error for denied ones.
 */

import http from "node:http";
import path from "node:path";

// ---------------------------------------------------------------------------
// Role type
// ---------------------------------------------------------------------------

export type PolicyBridgeRole =
  | "planner"
  | "implementer"
  | "reviewer"
  | "phase-auditor"
  | "completion-auditor";

// ---------------------------------------------------------------------------
// Event sink types
// ---------------------------------------------------------------------------

export interface ToolCallEvent {
  kind: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
}

export interface PolicyDecisionEvent {
  kind: "policy_decision";
  toolName: string;
  allowed: boolean;
  reason: string;
}

export type PolicyBridgeEvent = ToolCallEvent | PolicyDecisionEvent;

export type PolicyBridgeSink = (
  event: PolicyBridgeEvent,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Policy gate
// ---------------------------------------------------------------------------

export interface PolicyBridgeConfig {
  role: PolicyBridgeRole;
  /** fileScope from the active Task.  Undefined means no scope restriction. */
  fileScope?: { includes: readonly string[]; excludes?: readonly string[] | undefined } | undefined;
  /** Absolute path to the worktree root.  Required when fileScope is set. */
  worktreePath?: string | undefined;
  /** Sink that receives tool_call + policy_decision events. */
  sink?: PolicyBridgeSink | undefined;
}

export interface PolicyGateResult {
  allowed: boolean;
  reason: string;
}

/** Write-class tools — these are gated by role and fileScope. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** Read-class tools — always allowed for all roles (within worktree). */
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Roles that may only read — write-class tool calls are always denied. */
const READ_ONLY_ROLES = new Set<PolicyBridgeRole>([
  "planner",
  "reviewer",
  "phase-auditor",
  "completion-auditor",
]);

/**
 * Pure policy gate: given a tool call, the active role, and the optional
 * fileScope, return whether the call is allowed and why.
 *
 * Does NOT invoke the sink — callers are responsible for emitting events.
 */
export function evaluatePolicyGate(
  toolName: string,
  input: Record<string, unknown>,
  config: PolicyBridgeConfig,
): PolicyGateResult {
  // --- Read-only role check ---
  if (READ_ONLY_ROLES.has(config.role) && WRITE_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${config.role} role is read-only; ${toolName} is denied`,
    };
  }

  // --- Write-tool fileScope check (implementer role) ---
  if (WRITE_TOOLS.has(toolName) && config.fileScope) {
    const target = extractTargetPath(input);
    if (!target) {
      return {
        allowed: false,
        reason: `${toolName} call is missing a target path`,
      };
    }

    const abs = config.worktreePath
      ? path.resolve(config.worktreePath, target)
      : path.resolve(target);

    // Must stay inside the worktree.
    if (config.worktreePath && !isInsideDir(abs, config.worktreePath)) {
      return {
        allowed: false,
        reason: `${toolName} target '${target}' is outside worktree ${config.worktreePath}`,
      };
    }

    const relPath = config.worktreePath
      ? path.relative(config.worktreePath, abs)
      : target;
    const relPosix = toPosix(relPath);

    // .git/** is always off-limits.
    if (relPosix === ".git" || relPosix.startsWith(".git/")) {
      return {
        allowed: false,
        reason: `${toolName} target '${relPosix}' is inside .git/ (off-limits)`,
      };
    }

    // fileScope.excludes win over includes.
    const excludes = config.fileScope.excludes ?? [];
    if (matchesAnyPattern(relPosix, excludes)) {
      return {
        allowed: false,
        reason: `${toolName} target '${relPosix}' matches fileScope.excludes`,
      };
    }

    if (!matchesAnyPattern(relPosix, config.fileScope.includes)) {
      return {
        allowed: false,
        reason: `${toolName} target '${relPosix}' is not inside fileScope.includes`,
      };
    }
  }

  // --- Read tools: allowed for all roles if they stay inside the worktree ---
  if (READ_TOOLS.has(toolName) && config.worktreePath) {
    const target = extractTargetPath(input);
    if (target) {
      const abs = path.resolve(config.worktreePath, target);
      if (!isInsideDir(abs, config.worktreePath)) {
        return {
          allowed: false,
          reason: `${toolName} target '${target}' is outside worktree ${config.worktreePath}`,
        };
      }
    }
  }

  return { allowed: true, reason: "allowed" };
}

/**
 * Evaluate the policy gate AND emit events to the sink.
 *
 * Emits a `tool_call` event first (always), then a `policy_decision` event.
 * Returns the gate result so the caller can proxy or reject the call.
 */
export async function evaluatePolicyGateWithSink(
  toolName: string,
  input: Record<string, unknown>,
  config: PolicyBridgeConfig,
): Promise<PolicyGateResult> {
  // Emit tool_call event.
  if (config.sink) {
    const event: ToolCallEvent = { kind: "tool_call", toolName, input };
    await config.sink(event);
  }

  const result = evaluatePolicyGate(toolName, input, config);

  // Emit policy_decision event.
  if (config.sink) {
    const event: PolicyDecisionEvent = {
      kind: "policy_decision",
      toolName,
      allowed: result.allowed,
      reason: result.reason,
    };
    await config.sink(event);
  }

  return result;
}

// ---------------------------------------------------------------------------
// HTTP MCP server (Streamable HTTP / JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export interface PolicyBridgeServer {
  /** The port the server is listening on (assigned by the OS when 0). */
  port: number;
  /** URL callers should pass as `--mcp-server-url`. */
  url: string;
  /** Stop accepting new connections and close the server. */
  close(): Promise<void>;
}

type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface CreatePolicyBridgeServerOptions extends PolicyBridgeConfig {
  /**
   * The underlying tool implementation to proxy allowed calls to.
   * When undefined, allowed calls return an empty success result.
   */
  toolHandler?: ToolHandler;
}

/**
 * Start a minimal HTTP MCP server on a random port.  The spawned Claude
 * CLI should be invoked with `--mcp-server-url <server.url>`.
 *
 * Supported JSON-RPC methods:
 *   - `initialize`      → capability handshake
 *   - `tools/list`      → advertise available tools
 *   - `tools/call`      → policy-gated tool invocation
 */
export function createPolicyBridgeServer(
  opts: CreatePolicyBridgeServerOptions,
): Promise<PolicyBridgeServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        handleMcpRequest(body, opts)
          .then((responseBody) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(responseBody));
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error ? err.message : "internal error";
            res.writeHead(500).end(message);
          });
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("createPolicyBridgeServer: unexpected address format"));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        port,
        url,
        close(): Promise<void> {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP request handler
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function handleMcpRequest(
  rawBody: string,
  opts: CreatePolicyBridgeServerOptions,
): Promise<JsonRpcResponse> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }

  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "pm-go-policy-bridge", version: "0.0.0" },
        },
      };
    }

    case "notifications/initialized": {
      // No response needed for notifications.
      return { jsonrpc: "2.0", id };
    }

    case "tools/list": {
      // Advertise the standard Claude tool set so the CLI can call them
      // through the bridge.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
            { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
            { name: "Edit", description: "Edit a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
            { name: "Grep", description: "Search files", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
            { name: "Glob", description: "Glob files", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
            { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
          ],
        },
      };
    }

    case "tools/call": {
      const params = req.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      } | undefined;
      const toolName = params?.name ?? "";
      const toolInput = params?.arguments ?? {};

      const gate = await evaluatePolicyGateWithSink(toolName, toolInput, opts);

      if (!gate.allowed) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Policy denied: ${gate.reason}` }],
            isError: true,
          },
        };
      }

      // Proxy to the underlying handler.
      if (opts.toolHandler) {
        try {
          const toolResult = await opts.toolHandler(toolName, toolInput);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    typeof toolResult === "string"
                      ? toolResult
                      : JSON.stringify(toolResult),
                },
              ],
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "tool error";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: message }],
              isError: true,
            },
          };
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "" }] },
      };
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from executor-claude to avoid cross-package dep on
// internal (non-exported) utilities)
// ---------------------------------------------------------------------------

function isInsideDir(target: string, dir: string): boolean {
  const absTarget = path.resolve(target);
  const absDir = path.resolve(dir);
  if (absTarget === absDir) return true;
  return absTarget.startsWith(absDir + path.sep);
}

function extractTargetPath(input: Record<string, unknown>): string {
  if (typeof input["file_path"] === "string") return input["file_path"];
  if (typeof input["path"] === "string") return input["path"];
  if (typeof input["notebook_path"] === "string") return input["notebook_path"];
  return "";
}

function matchesAnyPattern(
  relPath: string,
  patterns: readonly string[],
): boolean {
  for (const pat of patterns) {
    if (globMatches(relPath, pat)) return true;
  }
  return false;
}

function globMatches(relPath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relPath);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (/[.+^$(){}|\\[\]]/.test(ch!)) {
      re += `\\${ch}`;
      i += 1;
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
