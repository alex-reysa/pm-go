import { randomUUID } from "node:crypto";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AcceptanceCriterion,
  AgentRun,
  AgentStopReason,
  CompletionAuditReport,
  FileScope,
  StoredReviewReport,
  Task,
} from "@pm-go/contracts";

import { AUDITOR_FORBIDDEN_BASH_PATTERNS } from "./claude-phase-auditor-runner.js";
import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
} from "./errors.js";
import type { AgentRunFailureSink } from "./index.js";
import { findForbiddenBashPatternAgainst } from "./implementer-runner.js";
import { isInsideCwd } from "./planner-runner.js";
import type {
  CompletionAuditorRunner,
  CompletionAuditorRunnerInput,
  CompletionAuditorRunnerResult,
} from "./completion-auditor-runner.js";

/**
 * Config for {@link createClaudeCompletionAuditorRunner}. The API key
 * defaults to `process.env.ANTHROPIC_API_KEY`. The constructor throws
 * if no key is available so callers see a clean failure up-front.
 */
export interface ClaudeCompletionAuditorRunnerConfig {
  apiKey?: string;
  /** See `ClaudeImplementerRunnerConfig.onFailure`. */
  onFailure?: AgentRunFailureSink;
}

/**
 * Thrown when the Claude-backed completion auditor returns a payload
 * that does not conform to `CompletionAuditReportSchema`. Fatal /
 * non-retryable — the activity layer translates this to
 * `ApplicationFailure.nonRetryable` so Temporal never retries a
 * malformed model output.
 */
export class CompletionAuditValidationError extends Error {
  constructor(
    message: string,
    public readonly rawPayload: unknown,
  ) {
    super(message);
    this.name = "CompletionAuditValidationError";
  }
}

/**
 * Build a `CompletionAuditorRunner` backed by the real
 * `@anthropic-ai/claude-agent-sdk`. Mirrors
 * `createClaudePhaseAuditorRunner` — same read-only tool set, same
 * host-id rewriting discipline, same fatal-validation-error
 * translation path — but pinned to `CompletionAuditReportSchema` for
 * `outputFormat` and to the plan-scoped evidence bundle for the user
 * turn.
 *
 * The runner:
 * - Rewrites every model-emitted primary key / foreign key
 *   (`report.id`, `auditorRunId`, `planId`, `finalPhaseId`,
 *   `mergeRunId`, `auditedHeadSha`) with host-generated values before
 *   persistence.
 * - Refuses to invoke the SDK if the caller hands in a
 *   `finalMergeRun.integrationHeadSha === undefined`. Release
 *   readiness against an in-flight merge is a workflow bug.
 * - Synthesizes an `AgentRun` with `role='auditor'`, `depth=2`,
 *   `riskLevel='high'` (completion audit is the release gate — the
 *   highest-stakes audit surface in the system).
 */
export function createClaudeCompletionAuditorRunner(
  config: ClaudeCompletionAuditorRunnerConfig = {},
): CompletionAuditorRunner {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "createClaudeCompletionAuditorRunner: ANTHROPIC_API_KEY not set",
    );
  }

  return {
    async run(
      input: CompletionAuditorRunnerInput,
    ): Promise<CompletionAuditorRunnerResult> {
      if (!input.finalMergeRun.integrationHeadSha) {
        throw new CompletionAuditValidationError(
          "createClaudeCompletionAuditorRunner: finalMergeRun.integrationHeadSha is not set — refusing to audit release-readiness against an in-flight merge",
          input.finalMergeRun,
        );
      }

      const userPrompt = buildUserPrompt(input);
      const cwd = input.worktreePath;

      const contractsModule: string = "@pm-go/contracts";
      const {
        CompletionAuditReportJsonSchema,
        validateCompletionAuditReport,
      } = (await import(contractsModule)) as {
        CompletionAuditReportJsonSchema: Record<string, unknown>;
        validateCompletionAuditReport: (v: unknown) => boolean;
      };

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
              schema: CompletionAuditReportJsonSchema,
            },
            ...(typeof input.budgetUsdCap === "number"
              ? { maxBudgetUsd: input.budgetUsdCap }
              : {}),
            ...(typeof input.maxTurnsCap === "number"
              ? { maxTurns: input.maxTurnsCap }
              : {}),
            cwd,
            canUseTool: async (tool, toolInput) => {
              return gateAuditorToolUse(tool, toolInput, cwd);
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
          workflowRunId: input.workflowRunId ?? sessionId ?? randomUUID(),
          role: "auditor",
          depth: 2,
          status: "failed",
          riskLevel: "high",
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
          stopReason: "error",
          errorReason: errorReasonFromClassified(classified),
          outputFormatSchemaRef: "CompletionAuditReport@1",
          startedAt,
          completedAt: new Date().toISOString(),
        };
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      }

      if (reportPayload === undefined || reportPayload === null) {
        throw new CompletionAuditValidationError(
          "createClaudeCompletionAuditorRunner: SDK returned no structured_output CompletionAuditReport",
          reportPayload,
        );
      }
      if (!validateCompletionAuditReport(reportPayload)) {
        throw new CompletionAuditValidationError(
          "createClaudeCompletionAuditorRunner: structured_output failed CompletionAuditReport schema validation",
          reportPayload,
        );
      }

      const validatedPayload = reportPayload as CompletionAuditReport;
      const auditorRunId = randomUUID();
      const report: CompletionAuditReport = {
        ...validatedPayload,
        id: randomUUID(),
        planId: input.plan.id,
        finalPhaseId: input.finalPhase.id,
        mergeRunId: input.finalMergeRun.id,
        auditorRunId,
        auditedHeadSha: input.finalMergeRun.integrationHeadSha,
      };
      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: auditorRunId,
        workflowRunId: input.workflowRunId ?? sessionId ?? randomUUID(),
        role: "auditor",
        depth: 2,
        status: "completed",
        // Completion audit is the release gate — the highest-stakes
        // audit surface in the system. `high` risk makes the Phase 7+
        // human-approval gates fire correctly even when individual
        // phases were medium.
        riskLevel: "high",
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
        outputFormatSchemaRef: "CompletionAuditReport@1",
        startedAt,
        completedAt,
      };

      return { report, agentRun };
    },
  };
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

async function gateAuditorToolUse(
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
      message: `completion auditor is read-only; tool '${tool}' is forbidden`,
    };
  }

  if (tool === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === undefined) {
      return { behavior: "deny", message: "Bash call missing command" };
    }
    const forbidden = findForbiddenBashPatternAgainst(
      command,
      AUDITOR_FORBIDDEN_BASH_PATTERNS,
    );
    if (forbidden) {
      return {
        behavior: "deny",
        message: `Bash command blocked by completion-auditor policy (${forbidden})`,
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
        message: `${tool} target '${target}' is outside integration worktree ${cwd}`,
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  return {
    behavior: "deny",
    message: `tool '${tool}' is not on the completion-auditor allowlist`,
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

function buildUserPrompt(input: CompletionAuditorRunnerInput): string {
  const { plan, finalPhase, finalMergeRun, baseSha, evidence } = input;

  const phaseBullets = evidence.phases
    .map(
      (p) =>
        `- ${p.id} (index ${p.index}) [${p.status}] ${p.title}${
          p.id === finalPhase.id ? " ← final phase" : ""
        }`,
    )
    .join("\n");

  // plan.tasks is the cross-phase union of every task in the plan.
  // Completion audit's `check-all-required-tasks-merged` +
  // `check-acceptance-criteria-evidence` + `check-repo-state-matches-release`
  // all need per-task scope + criteria visibility, so render each task
  // fully (same block shape the phase auditor uses).
  const taskBlocks =
    plan.tasks.length > 0
      ? plan.tasks.map((t) => renderTaskBlock(t)).join("\n\n")
      : "- (no tasks)";

  // Union of every phase's task fileScopes — the cross-phase file
  // ownership surface. `check-repo-state-matches-release` needs this
  // to sanity-check that the merged diff stays within declared scope.
  const fileScopeUnion = renderFileScopeUnion(plan.tasks);

  const phaseAuditBullets = evidence.phaseAuditReports
    .map(
      (r) =>
        `- ${r.id} phaseId=${r.phaseId} outcome=${r.outcome} mergedHeadSha=${r.mergedHeadSha}`,
    )
    .join("\n");

  const mergeRunBullets = evidence.mergeRuns
    .map(
      (m) =>
        `- ${m.id} phaseId=${m.phaseId} integrationHeadSha=${m.integrationHeadSha ?? "(null)"} mergedTaskIds=${m.mergedTaskIds.length} completedAt=${m.completedAt ?? "(in flight)"}`,
    )
    .join("\n");

  const reviewBullets =
    evidence.reviewReports.length > 0
      ? evidence.reviewReports.map(renderStoredReviewReport).join("\n")
      : "- (no review reports)";

  const policyBullets =
    evidence.policyDecisions.length > 0
      ? evidence.policyDecisions
          .map(
            (d) =>
              `- ${d.id} [${d.subjectType}:${d.subjectId}] ${d.decision} (${d.reason})`,
          )
          .join("\n")
      : "- (no policy decisions)";

  return [
    `# Plan under completion audit (id ${plan.id})`,
    `Title: ${plan.title}`,
    `Summary: ${plan.summary}`,
    `Plan baseSha (from input): ${baseSha}`,
    `Final audited head: ${finalMergeRun.integrationHeadSha}`,
    `Plan-wide diff range: \`git diff ${baseSha}..${finalMergeRun.integrationHeadSha}\``,
    "",
    "## Phases",
    phaseBullets.length > 0 ? phaseBullets : "- (no phases)",
    "",
    `## Final phase (id ${finalPhase.id}, index ${finalPhase.index})`,
    `Title: ${finalPhase.title}`,
    "",
    `## Final MergeRun (id ${finalMergeRun.id})`,
    `- integrationBranch: ${finalMergeRun.integrationBranch}`,
    `- integrationHeadSha: ${finalMergeRun.integrationHeadSha}`,
    `- mergedTaskIds: ${JSON.stringify(finalMergeRun.mergedTaskIds)}`,
    `- completedAt: ${finalMergeRun.completedAt ?? "(in flight — workflow bug)"}`,
    "",
    "## Tasks (cross-phase union — every task in the plan)",
    taskBlocks,
    "",
    "## fileScope union across the plan",
    fileScopeUnion,
    "",
    "## Phase audit reports",
    phaseAuditBullets.length > 0 ? phaseAuditBullets : "- (none)",
    "",
    "## All merge runs across the plan",
    mergeRunBullets.length > 0 ? mergeRunBullets : "- (none)",
    "",
    "## Review reports across all tasks (reviewed commit range in brackets)",
    reviewBullets,
    "",
    "## Policy decisions across the plan",
    policyBullets,
    "",
    "## Plan-level diff summary",
    "```",
    evidence.diffSummary.length > 0 ? evidence.diffSummary : "(empty)",
    "```",
    "",
    "Emit a structured CompletionAuditReport JSON object per the schema. Do not emit prose outside the JSON.",
  ].join("\n");
}

/**
 * Per-task rendering identical in shape to the phase auditor's so the
 * two auditors see the same task surface. Duplicated here rather than
 * importing from the phase auditor because cross-runner imports would
 * make the boundary between the two harder to reason about — each
 * runner is a self-contained read of the spec.
 */
function renderTaskBlock(t: Task): string {
  return [
    `- ${t.id} [${t.status}] ${t.slug}: ${t.title} (risk=${t.riskLevel}, kind=${t.kind}, phase=${t.phaseId})`,
    `  fileScope: ${renderFileScope(t.fileScope)}`,
    `  acceptanceCriteria: ${renderAcceptanceCriteria(t.acceptanceCriteria)}`,
    `  testCommands: ${
      t.testCommands.length > 0
        ? t.testCommands.map((c) => `\`${c}\``).join(", ")
        : "(none declared)"
    }`,
  ].join("\n");
}

function renderFileScope(scope: FileScope): string {
  const includes = scope.includes.length > 0
    ? scope.includes.map((p) => `\`${p}\``).join(", ")
    : "(empty)";
  const excludes = scope.excludes && scope.excludes.length > 0
    ? `; excludes=[${scope.excludes.map((p) => `\`${p}\``).join(", ")}]`
    : "";
  return `includes=[${includes}]${excludes}`;
}

function renderAcceptanceCriteria(acs: AcceptanceCriterion[]): string {
  if (acs.length === 0) return "(none declared)";
  return acs
    .map(
      (ac) =>
        `[${ac.required ? "required" : "optional"}] ${ac.id}: ${ac.description}`,
    )
    .join(" | ");
}

function renderFileScopeUnion(tasks: Task[]): string {
  const includes = new Set<string>();
  const excludes = new Set<string>();
  for (const t of tasks) {
    for (const p of t.fileScope.includes) includes.add(p);
    for (const p of t.fileScope.excludes ?? []) excludes.add(p);
  }
  const inc = Array.from(includes).sort();
  const exc = Array.from(excludes).sort();
  const incLine =
    inc.length > 0
      ? `- includes: ${inc.map((p) => `\`${p}\``).join(", ")}`
      : "- includes: (empty)";
  const excLine =
    exc.length > 0
      ? `- excludes: ${exc.map((p) => `\`${p}\``).join(", ")}`
      : "- excludes: (none)";
  return [incLine, excLine].join("\n");
}

function renderStoredReviewReport(r: StoredReviewReport): string {
  const findingCount = r.findings.length;
  return [
    `- ${r.id} taskId=${r.taskId} cycle=${r.cycleNumber} outcome=${r.outcome} findings=${findingCount}`,
    `  reviewed-range: ${r.reviewedBaseSha}..${r.reviewedHeadSha}`,
  ].join("\n");
}
