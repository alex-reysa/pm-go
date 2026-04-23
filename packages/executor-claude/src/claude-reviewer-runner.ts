import { randomUUID } from "node:crypto";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentRun,
  AgentStopReason,
  ReviewFinding,
  ReviewReport,
} from "@pm-go/contracts";

import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
} from "./errors.js";
import type { AgentRunFailureSink } from "./index.js";
import {
  FORBIDDEN_BASH_PATTERNS,
  findForbiddenBashPatternAgainst,
} from "./implementer-runner.js";
import { isInsideCwd, stripSchemaAnnotations } from "./planner-runner.js";
import type {
  ReviewerRunner,
  ReviewerRunnerInput,
  ReviewerRunnerResult,
} from "./reviewer-runner.js";

/**
 * Config for {@link createClaudeReviewerRunner}. The API key defaults to
 * `process.env.ANTHROPIC_API_KEY`. The constructor throws if no key is
 * available so callers see a clean failure rather than an SDK error at
 * first-request time.
 */
export interface ClaudeReviewerRunnerConfig {
  apiKey?: string;
  /** See `ClaudeImplementerRunnerConfig.onFailure`. */
  onFailure?: AgentRunFailureSink;
}

/**
 * Thrown when the Claude-backed reviewer returns a payload that does not
 * conform to `ReviewReportSchema`. Fatal / non-retryable — the workflow
 * layer catches and surfaces as a failed run.
 */
export class ReviewValidationError extends Error {
  constructor(
    message: string,
    public readonly rawPayload: unknown,
  ) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

/**
 * Build a `ReviewerRunner` backed by the real `@anthropic-ai/claude-agent-sdk`.
 *
 * The runner:
 * - Uses the system prompt you give it verbatim (loaded in
 *   `@pm-go/planner`'s `runReviewer` wrapper — note: that wrapper lands in
 *   the API+Smoke lane; for Foundation/Reviewer work it is called directly
 *   by the activity).
 * - Restricts the agent to read-only tools (`Read`, `Grep`, `Glob`, `Bash`)
 *   via `allowedTools` + `disallowedTools` + a belt-and-braces `canUseTool`
 *   that denies every write-class tool and every mutating Bash verb.
 * - Pins `outputFormat` to the `ReviewReport` JSON Schema so the model
 *   emits a structured `ReviewReport`, which we validate before returning.
 * - Synthesizes an `AgentRun` with `role='auditor'`, `depth=2`, and the
 *   accumulated token / cost / turn counters.
 *
 * The runner is not unit-tested against the live API — CI has no API key.
 * The end-of-phase smoke exercises it with `REVIEWER_EXECUTOR_MODE=live`.
 */
export function createClaudeReviewerRunner(
  config: ClaudeReviewerRunnerConfig = {},
): ReviewerRunner {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    async run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult> {
      const userPrompt = buildUserPrompt(input);
      const cwd = input.worktreePath;

      // See planner-runner.ts for the rationale on the dynamic-module
      // indirection: keeps vitest from eagerly resolving the contracts
      // package entry when only the stub runner is under test.
      const contractsModule: string = "@pm-go/contracts";
      const { ReviewReportJsonSchema, validateReviewReport } = (await import(
        contractsModule
      )) as {
        ReviewReportJsonSchema: Record<string, unknown>;
        validateReviewReport: (v: unknown) => boolean;
      };

      // See planner-runner.ts: Claude Code CLI's JSON Schema validator rejects
      // `format` ("uuid", "date-time") and TypeBox's `$id`, causing
      // `structured_output` to be omitted from every result.
      const cleanSchema = stripSchemaAnnotations(ReviewReportJsonSchema);

      let reportPayload: unknown;
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
        const iter = query({
          prompt: userPrompt,
          options: {
            systemPrompt: input.systemPrompt,
            model: input.model,
            permissionMode: "default",
            allowedTools: ["Read", "Grep", "Glob", "Bash"],
            disallowedTools: ["Write", "Edit", "NotebookEdit"],
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
              return gateReviewerToolUse(tool, toolInput, cwd);
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
              reportPayload = message.structured_output;
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
          workflowRunId: sessionId ?? input.workflowRunId ?? randomUUID(),
          role: "auditor",
          depth: 2,
          status: "failed",
          riskLevel: input.task.riskLevel,
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
          taskId: input.task.id,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(input.parentSessionId !== undefined
            ? { parentSessionId: input.parentSessionId }
            : {}),
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
          outputFormatSchemaRef: "ReviewReport@1",
          startedAt,
          completedAt: new Date().toISOString(),
        };
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      }

      if (reportPayload === undefined || reportPayload === null) {
        throw new ReviewValidationError(
          "createClaudeReviewerRunner: SDK returned no structured_output ReviewReport",
          reportPayload,
        );
      }
      if (!validateReviewReport(reportPayload)) {
        throw new ReviewValidationError(
          "createClaudeReviewerRunner: structured_output failed ReviewReport schema validation",
          reportPayload,
        );
      }

      // Never trust model-emitted primary keys. The schema-validated
      // payload has `id` and `reviewerRunId` fields, but those came from
      // the model and a hallucinated duplicate would either overwrite an
      // existing agent_runs row (via persistAgentRun's upsert) or no-op
      // a persistReviewReport insert while the workflow proceeds with
      // drifted in-memory state. Rewrite both fields with host-generated
      // UUIDs before anything downstream sees them. Also rewrite
      // taskId — the reviewer saw the task id in the user turn, but a
      // misaligned payload must not bind to a different task.
      const validatedPayload = reportPayload as ReviewReport;
      const reviewerRunId = randomUUID();
      const report: ReviewReport = {
        ...validatedPayload,
        id: randomUUID(),
        taskId: input.task.id,
        reviewerRunId,
      };
      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: reviewerRunId,
        taskId: input.task.id,
        workflowRunId: input.workflowRunId ?? sessionId ?? randomUUID(),
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: input.task.riskLevel,
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
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
        outputFormatSchemaRef: "ReviewReport@1",
        startedAt,
        completedAt,
      };

      return { report, agentRun };
    },
  };
}

/**
 * Forbidden-Bash patterns for the reviewer. Inherits everything the
 * implementer denies (redirect-writes, in-place editors, inline scripting,
 * tee, curl/wget, pnpm-install, rm -rf, kill/pkill, git commit/push/merge/
 * reset/checkout/rebase/branch), plus the remaining git-write verbs since
 * the reviewer has no commit authority whatsoever.
 *
 * Exported so the Phase 5 phase auditor + completion auditor can reuse
 * the same read-only Bash policy — they are structurally identical
 * read-only agents operating on the post-merge tree.
 */
export const REVIEWER_FORBIDDEN_BASH_PATTERNS: Array<{
  name: string;
  re: RegExp;
}> = [
  ...FORBIDDEN_BASH_PATTERNS,
  { name: "git add", re: /\bgit\s+add\b/ },
  { name: "git tag", re: /\bgit\s+tag\b/ },
  { name: "git stash", re: /\bgit\s+stash\b/ },
  { name: "git clean", re: /\bgit\s+clean\b/ },
  { name: "git worktree", re: /\bgit\s+worktree\b/ },
];

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

async function gateReviewerToolUse(
  tool: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
> {
  if (WRITE_TOOLS.has(tool)) {
    return {
      behavior: "deny",
      message: `reviewer is read-only; tool '${tool}' is forbidden`,
    };
  }

  if (tool === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === undefined) {
      return { behavior: "deny", message: "Bash call missing command" };
    }
    const forbidden = findForbiddenBashPatternAgainst(
      command,
      REVIEWER_FORBIDDEN_BASH_PATTERNS,
    );
    if (forbidden) {
      return {
        behavior: "deny",
        message: `Bash command blocked by reviewer policy (${forbidden})`,
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  if (READ_TOOLS.has(tool)) {
    const target = extractPathFromToolInput(toolInput);
    if (!target) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    const abs = path.resolve(cwd, target);
    if (!isInsideCwd(abs, cwd)) {
      return {
        behavior: "deny",
        message: `${tool} target '${target}' is outside worktree ${cwd}`,
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  // Anything else (sub-agents, MCP, web fetch) is denied.
  return {
    behavior: "deny",
    message: `tool '${tool}' is not on the reviewer allowlist`,
  };
}

function extractBashCommand(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  return undefined;
}

function extractPathFromToolInput(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.notebook_path === "string") return obj.notebook_path;
  return "";
}

function buildUserPrompt(input: ReviewerRunnerInput): string {
  const task = input.task;
  const acceptanceBullets = task.acceptanceCriteria
    .map(
      (ac) =>
        `- [${ac.required ? "required" : "optional"}] ${ac.id}: ${ac.description}`,
    )
    .join("\n");
  const testCommandsBlock =
    task.testCommands.length > 0
      ? task.testCommands.map((c) => `- \`${c}\``).join("\n")
      : "- (none declared)";
  const prevFindingsBlock = renderPreviousFindings(input.previousFindings);

  return [
    `# Task under review (id ${task.id})`,
    `Title: ${task.title}`,
    `Slug: ${task.slug}`,
    `Risk level: ${task.riskLevel}`,
    `Review strictness: ${input.strictness}`,
    `Review cycle: ${input.cycleNumber}`,
    "",
    "## Summary",
    task.summary,
    "",
    "## fileScope",
    `includes: ${JSON.stringify(task.fileScope.includes)}`,
    `excludes: ${JSON.stringify(task.fileScope.excludes ?? [])}`,
    "",
    "## Acceptance criteria",
    acceptanceBullets.length > 0 ? acceptanceBullets : "- (none declared)",
    "",
    "## Test commands (run these before emitting `pass`)",
    testCommandsBlock,
    "",
    "## Git context",
    `- baseSha: ${input.baseSha}`,
    `- headSha: ${input.headSha}`,
    `- diff: \`git diff ${input.baseSha}..${input.headSha}\``,
    "",
    ...(prevFindingsBlock ? ["## Previous-cycle findings", prevFindingsBlock, ""] : []),
    "Emit a structured ReviewReport JSON object per the schema. Do not emit prose outside the JSON.",
  ].join("\n");
}

function renderPreviousFindings(
  prev: ReviewFinding[] | undefined,
): string | undefined {
  if (!prev || prev.length === 0) return undefined;
  return prev
    .map(
      (f) =>
        `- [${f.severity}] ${f.id}: ${f.title} — ${f.filePath}${
          typeof f.startLine === "number" ? `:${f.startLine}` : ""
        }\n  ${f.summary}`,
    )
    .join("\n");
}
