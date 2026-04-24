import { randomUUID } from "node:crypto";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentRun,
  AgentStopReason,
  Plan,
} from "@pm-go/contracts";

import type {
  AgentRunFailureSink,
  PlannerRunner,
  PlannerRunnerInput,
  PlannerRunnerResult,
} from "./index.js";
import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
} from "./errors.js";

/**
 * Config for {@link createClaudePlannerRunner}. The API key defaults to
 * `process.env.ANTHROPIC_API_KEY`. When no key is provided the SDK
 * handles missing credentials at call time (OAuth fallthrough).
 */
export interface ClaudePlannerRunnerConfig {
  apiKey?: string;
  /** See `ClaudeImplementerRunnerConfig.onFailure`. */
  onFailure?: AgentRunFailureSink;
}

/**
 * Build a `PlannerRunner` backed by the real `@anthropic-ai/claude-agent-sdk`.
 *
 * The runner:
 * - Uses the system prompt you give it verbatim (loaded in
 *   `@pm-go/planner`'s `runPlanner`).
 * - Restricts the agent to read-only tools (`Read`, `Grep`, `Glob`) via
 *   the `allowedTools` option and a belt-and-braces `canUseTool`
 *   callback that denies writes and Bash.
 * - Pins `outputFormat` to the `Plan` JSON Schema so the model emits a
 *   structured Plan object, which we return unmodified. The SDK's own
 *   structured-output retry handles shape mismatches.
 * - Accumulates token, cost, and turn counters from the message stream
 *   and synthesizes an `AgentRun` record for the planner role.
 *
 * The runner is intentionally not covered by unit tests — there is no
 * API key in CI. It is exercised by the end-of-phase smoke test.
 */
export function createClaudePlannerRunner(
  config: ClaudePlannerRunnerConfig = {},
): PlannerRunner {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    _runtimeKind: "sdk" as const,
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const userPrompt = buildUserPrompt(input);

      // Dynamic-module indirection keeps the vitest bundler (used by
      // the foundation-lane stub runner test) from eagerly resolving
      // `@pm-go/contracts`'s `dist/` entry, which is not produced by
      // `pnpm test` alone. The import is evaluated only on the live-API
      // path; unit tests never take this code path.
      const contractsModule: string = "@pm-go/contracts";
      const { PlanSchema } = (await import(contractsModule)) as {
        PlanSchema: Record<string, unknown>;
      };

      // The Claude Code CLI's JSON Schema validator does not support the
      // `format` keyword (e.g. "uuid", "date-time"). When present, schema
      // validation always fails and `structured_output` is omitted from the
      // result. Strip `format` (and TypeBox's `$id`) before passing to the
      // SDK so the validator only checks structural constraints.
      const cleanSchema = stripSchemaAnnotations(PlanSchema);

      let plan: unknown;
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      const startedAt = new Date().toISOString();

      try {
        // Capture the input shape locally so the closure below doesn't
        // depend on the outer `input` being stable across microtasks.
        const cwd = input.cwd;

        const iter = query({
          prompt: userPrompt,
          options: {
            systemPrompt: input.systemPrompt,
            model: input.model,
            permissionMode: "default",
            allowedTools: ["Read", "Grep", "Glob"],
            disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
            settingSources: [],
            outputFormat: {
              type: "json_schema",
              schema: cleanSchema,
            },
            ...(typeof input.budgetUsdCap === "number"
              ? { maxBudgetUsd: input.budgetUsdCap }
              : {}),
            ...(typeof input.maxTurnsCap === "number"
              ? { maxTurns: input.maxTurnsCap }
              : {}),
            cwd,
            canUseTool: async (tool, toolInput) => {
              if (["Write", "Edit", "NotebookEdit", "Bash"].includes(tool)) {
                return { behavior: "deny", message: "planner is read-only" };
              }
              const targetPath = extractPathFromToolInput(toolInput);
              if (targetPath && !isInsideCwd(targetPath, cwd)) {
                return {
                  behavior: "deny",
                  message: `planner may not read outside ${cwd}`,
                };
              }
              return { behavior: "allow", updatedInput: toolInput };
            },
          },
        });

        for await (const message of iter) {
          // Track session id as soon as any message carries it.
          if ("session_id" in message && typeof message.session_id === "string") {
            sessionId = message.session_id;
          }
          // Assistant/user messages count as turns. Result messages
          // carry final usage/cost.
          if (message.type === "assistant" || message.type === "user") {
            turns += 1;
          }
          // Incremental usage on assistant messages (BetaMessage.usage).
          if (
            message.type === "assistant" &&
            "message" in message &&
            message.message &&
            typeof message.message === "object" &&
            "usage" in message.message &&
            message.message.usage
          ) {
            const usage = message.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
            inputTokens += usage.input_tokens ?? 0;
            outputTokens += usage.output_tokens ?? 0;
            cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
            cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          }
          // The result message carries total_cost_usd, usage totals, and
          // structured_output. Prefer its totals over the running sum.
          if (message.type === "result") {
            if (typeof message.total_cost_usd === "number") {
              costUsd = message.total_cost_usd;
            }
            if ("usage" in message && message.usage) {
              const usage = message.usage as {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
              if (typeof usage.input_tokens === "number") {
                inputTokens = usage.input_tokens;
              }
              if (typeof usage.output_tokens === "number") {
                outputTokens = usage.output_tokens;
              }
              if (typeof usage.cache_creation_input_tokens === "number") {
                cacheCreationTokens = usage.cache_creation_input_tokens;
              }
              if (typeof usage.cache_read_input_tokens === "number") {
                cacheReadTokens = usage.cache_read_input_tokens;
              }
            }
            if (
              message.subtype === "success" &&
              "structured_output" in message &&
              message.structured_output !== undefined
            ) {
              plan = message.structured_output;
            }
            if (typeof message.subtype === "string") {
              const st = message.subtype;
              if (st.includes("budget")) stopReason = "budget_exceeded";
              else if (st.includes("turn")) stopReason = "turns_exceeded";
              else if (st.includes("error")) stopReason = "error";
            }
          }
        }
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = {
          id: randomUUID(),
          workflowRunId: sessionId ?? randomUUID(),
          role: "planner",
          depth: 0,
          status: "failed",
          riskLevel: "low",
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
          ...(sessionId !== undefined ? { sessionId } : {}),
          permissionMode: "default",
          ...(typeof input.budgetUsdCap === "number"
            ? { budgetUsdCap: input.budgetUsdCap }
            : {}),
          ...(typeof input.maxTurnsCap === "number"
            ? { maxTurnsCap: input.maxTurnsCap }
            : {}),
          turns,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          costUsd,
          stopReason: "error",
          errorReason: errorReasonFromClassified(classified),
          outputFormatSchemaRef: "Plan@1",
          startedAt,
          completedAt: new Date().toISOString(),
        };
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      }

      if (plan === undefined || plan === null) {
        throw new Error(
          "createClaudePlannerRunner: SDK returned no structured_output Plan",
        );
      }

      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: randomUUID(),
        workflowRunId: sessionId ?? randomUUID(),
        role: "planner",
        depth: 0,
        status: "completed",
        riskLevel: "low",
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        ...(sessionId !== undefined ? { sessionId } : {}),
        permissionMode: "default",
        ...(typeof input.budgetUsdCap === "number"
          ? { budgetUsdCap: input.budgetUsdCap }
          : {}),
        ...(typeof input.maxTurnsCap === "number"
          ? { maxTurnsCap: input.maxTurnsCap }
          : {}),
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        outputFormatSchemaRef: "Plan@1",
        startedAt,
        completedAt,
      };

      return { plan: plan as Plan, agentRun };
    },
  };
}

/**
 * Build the user-turn text fed to the Claude Agent SDK. We keep it
 * simple and deterministic: the spec body, then a compact JSON
 * RepoSnapshot the model can cross-reference before it starts globbing.
 */
function buildUserPrompt(input: PlannerRunnerInput): string {
  const snapshot = input.repoSnapshot;
  const condensed = {
    repoRoot: snapshot.repoRoot,
    defaultBranch: snapshot.defaultBranch,
    headSha: snapshot.headSha,
    languageHints: snapshot.languageHints,
    frameworkHints: snapshot.frameworkHints,
    buildCommands: snapshot.buildCommands,
    testCommands: snapshot.testCommands,
    ciConfigPaths: snapshot.ciConfigPaths,
  };
  return [
    `# Specification (id ${input.specDocument.id})`,
    `Title: ${input.specDocument.title}`,
    "",
    input.specDocument.body,
    "",
    `# RepoSnapshot (id ${input.repoSnapshot.id})`,
    "```json",
    JSON.stringify(condensed, null, 2),
    "```",
    "",
    "Emit a structured Plan JSON object per the system prompt. ",
    `Echo specDocumentId="${input.specDocument.id}" and repoSnapshotId="${input.repoSnapshot.id}" on the Plan.`,
  ].join("\n");
}

function extractPathFromToolInput(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  return "";
}

/**
 * Resolve both paths to absolute, then check that `target` is exactly
 * `cwd` or a descendant (a naive `startsWith` accepts e.g. `/repo-evil`
 * when `cwd = /repo`). Segment boundary enforced via `path.sep`.
 */
export function isInsideCwd(target: string, cwd: string): boolean {
  const absTarget = path.resolve(target);
  const absCwd = path.resolve(cwd);
  if (absTarget === absCwd) return true;
  return absTarget.startsWith(absCwd + path.sep);
}

/**
 * Deep-strip JSON Schema annotation keywords that the Claude Code CLI's
 * built-in validator does not support. Leaving `format` ("uuid",
 * "date-time") or TypeBox's `$id` in the schema causes the validator to
 * reject every model response, so `structured_output` is never returned.
 * Removing them preserves all structural constraints (type, required,
 * additionalProperties, anyOf, …) while silencing the validator quirk.
 */
export function stripSchemaAnnotations(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return stripSchemaAnnotationsAt(schema) as Record<string, unknown>;
}

/**
 * JSON Schema keywords whose values are themselves sub-schemas.
 * We recurse into these and only these — anything else (including the
 * entries of `properties`) is treated as either a primitive or a
 * schema-position value on a case-by-case basis below. This is what
 * makes the walker position-aware rather than name-blind, so a user
 * property literally called `format` or `$id` under `properties` is
 * preserved verbatim.
 */
const SCHEMA_VALUED_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** Keyword values that are arrays of sub-schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

/** Keyword values that are maps from name → sub-schema. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

function stripSchemaAnnotationsAt(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  if (Array.isArray(node)) return node.map((v) => stripSchemaAnnotationsAt(v));

  const obj = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Strip the two annotations that break the CLI's validator, at the
    // current schema position. Entries of `properties`, `patternProperties`,
    // etc. are recursed into via the branches below — their NAMED keys
    // ("format" / "$id" as property names) survive because we never look
    // at them here.
    if (key === "$id" || key === "format") continue;

    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      // { propName: subSchema, ... } — recurse into each value as a schema.
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const mapped: Record<string, unknown> = {};
        for (const [name, subSchema] of Object.entries(
          value as Record<string, unknown>,
        )) {
          mapped[name] = stripSchemaAnnotationsAt(subSchema);
        }
        result[key] = mapped;
      } else {
        result[key] = value;
      }
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
      // [ subSchema, ... ] — recurse into each element.
      result[key] = Array.isArray(value)
        ? value.map((v) => stripSchemaAnnotationsAt(v))
        : value;
    } else if (SCHEMA_VALUED_KEYWORDS.has(key)) {
      // Single sub-schema (or occasionally a tuple for legacy `items`).
      result[key] = stripSchemaAnnotationsAt(value);
    } else {
      // Any other key (type, required, enum, const, title, description,
      // minLength, …) — keep verbatim, do not descend. This is the key
      // property-preserving step: primitives pass through, and objects
      // that happen to live under keywords like `enum` or `const` are
      // not schemas and must not be rewritten.
      result[key] = value;
    }
  }
  return result;
}
