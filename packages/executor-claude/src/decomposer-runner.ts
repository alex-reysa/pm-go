import { randomUUID } from "node:crypto";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentRun,
  AgentStopReason,
  MilestoneManifest,
} from "@pm-go/contracts";

import type {
  AgentRunFailureSink,
  DecomposerRunner,
  DecomposerRunnerInput,
  DecomposerRunnerResult,
} from "./index.js";
import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
} from "./errors.js";
import { isInsideCwd, stripSchemaAnnotations } from "./planner-runner.js";

/**
 * Config for {@link createClaudeDecomposerRunner}. Mirrors
 * {@link createClaudePlannerRunner} — the API key defaults to
 * `process.env.ANTHROPIC_API_KEY` and missing credentials are deferred
 * to the SDK's OAuth fallthrough.
 */
export interface ClaudeDecomposerRunnerConfig {
  apiKey?: string;
  /** See `ClaudeImplementerRunnerConfig.onFailure`. */
  onFailure?: AgentRunFailureSink;
}

/**
 * Build a `DecomposerRunner` backed by the real
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * Same shape as {@link createClaudePlannerRunner}: read-only tools, a
 * `canUseTool` callback that denies writes / Bash, structured output
 * pinned to `MilestoneManifest@1`, and a synthesized `AgentRun` emitted
 * regardless of success or failure.
 *
 * Not unit-tested — there is no API key in CI. Exercised by the
 * decomposition smoke test.
 */
export function createClaudeDecomposerRunner(
  config: ClaudeDecomposerRunnerConfig = {},
): DecomposerRunner {
  // Touch `apiKey` to keep the optional config field load-bearing for
  // future env-precedence changes; the SDK reads ANTHROPIC_API_KEY itself.
  void config.apiKey;

  return {
    _runtimeKind: "sdk" as const,
    async run(
      input: DecomposerRunnerInput,
    ): Promise<DecomposerRunnerResult> {
      const userPrompt = buildUserPrompt(input);

      // Same dynamic-module indirection as planner-runner.ts — keeps
      // the vitest bundler from resolving `@pm-go/contracts`'s `dist/`
      // entry, which is not produced by `pnpm test` alone. Unit tests
      // never take this code path.
      const contractsModule: string = "@pm-go/contracts";
      const { MilestoneManifestSchema } = (await import(contractsModule)) as {
        MilestoneManifestSchema: Record<string, unknown>;
      };

      const cleanSchema = stripSchemaAnnotations(MilestoneManifestSchema);

      let manifest: unknown;
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
                return {
                  behavior: "deny",
                  message: "decomposer is read-only",
                };
              }
              const targetPath = extractPathFromToolInput(toolInput);
              if (targetPath && !isInsideCwd(targetPath, cwd)) {
                return {
                  behavior: "deny",
                  message: `decomposer may not read outside ${cwd}`,
                };
              }
              return { behavior: "allow", updatedInput: toolInput };
            },
          },
        });

        for await (const message of iter) {
          if (
            "session_id" in message &&
            typeof message.session_id === "string"
          ) {
            sessionId = message.session_id;
          }
          if (message.type === "assistant" || message.type === "user") {
            turns += 1;
          }
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
              manifest = message.structured_output;
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
          outputFormatSchemaRef: "MilestoneManifest@1",
          startedAt,
          completedAt: new Date().toISOString(),
        };
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      }

      if (manifest === undefined || manifest === null) {
        throw new Error(
          "createClaudeDecomposerRunner: SDK returned no structured_output MilestoneManifest",
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
        outputFormatSchemaRef: "MilestoneManifest@1",
        startedAt,
        completedAt,
      };

      return { manifest: manifest as MilestoneManifest, agentRun };
    },
  };
}

/**
 * Build the user-turn text fed to the Claude Agent SDK. Identical shape
 * to the planner's user prompt — spec body, condensed RepoSnapshot,
 * echoed ids — but asks for a `MilestoneManifest` rather than a `Plan`.
 */
function buildUserPrompt(input: DecomposerRunnerInput): string {
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
    "Emit a structured MilestoneManifest JSON object per the system prompt. ",
    `Echo specDocumentId="${input.specDocument.id}" and repoSnapshotId="${input.repoSnapshot.id}" on the manifest.`,
  ].join("\n");
}

function extractPathFromToolInput(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  return "";
}
