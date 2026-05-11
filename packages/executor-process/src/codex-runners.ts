import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRun,
  AgentStopReason,
  CompletionAuditReport,
  CompletionAuditSummary,
  CompletionChecklistItem,
  MilestoneManifest,
  PhaseAuditReport,
  Plan,
  ReviewFinding,
  ReviewOutcome,
  ReviewReport,
} from "@pm-go/contracts";
import {
  CompletionAuditReportJsonSchema,
  MilestoneManifestJsonSchema,
  PhaseAuditReportJsonSchema,
  PlanJsonSchema,
  validateCompletionAuditReport,
  validateMilestoneManifest,
  validatePhaseAuditReport,
  validatePlan,
  validateReviewReport,
} from "@pm-go/contracts";
import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
  type AgentRunFailureSink,
  type CompletionAuditorRunner,
  type CompletionAuditorRunnerInput,
  type CompletionAuditorRunnerResult,
  type DecomposerRunner,
  type DecomposerRunnerInput,
  type DecomposerRunnerResult,
  type ImplementerRunner,
  type ImplementerRunnerInput,
  type ImplementerRunnerResult,
  type PhaseAuditorRunner,
  type PhaseAuditorRunnerInput,
  type PhaseAuditorRunnerResult,
  type PlannerRunner,
  type PlannerRunnerInput,
  type PlannerRunnerResult,
  type ReviewerRunner,
  type ReviewerRunnerInput,
  type ReviewerRunnerResult,
} from "@pm-go/executor-claude";

export interface CodexProcessRunnerConfig {
  /** Codex CLI executable path. Defaults to `codex`. */
  executablePath?: string;
  /** Optional model override. When absent, the Codex CLI profile default is used. */
  model?: string;
  /** Maximum stdout/stderr bytes captured before the subprocess is killed. */
  maxOutputBytes?: number;
  /** Called just before a classified subprocess/validation error is re-thrown. */
  onFailure?: AgentRunFailureSink;
}

interface CodexExecOptions {
  cwd: string;
  prompt: string;
  model?: string | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  sandbox: "read-only" | "workspace-write";
  config: CodexProcessRunnerConfig;
}

interface CodexExecResult {
  sessionId?: string;
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
}

type ReviewPayload = Pick<ReviewReport, "outcome" | "findings">;
type PhaseAuditPayload = Pick<
  PhaseAuditReport,
  "outcome" | "checklist" | "findings" | "summary"
>;
type CompletionAuditPayload = Pick<
  CompletionAuditReport,
  "outcome" | "checklist" | "findings" | "summary"
>;

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const REVIEW_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "findings"],
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "changes_requested", "blocked"],
    },
    findings: { type: "array", items: reviewFindingSchema() },
  },
};

const PHASE_AUDIT_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "checklist", "findings", "summary"],
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "changes_requested", "blocked"],
    },
    checklist: { type: "array", items: checklistItemSchema() },
    findings: { type: "array", items: reviewFindingSchema() },
    summary: { type: "string" },
  },
};

const COMPLETION_AUDIT_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "checklist", "findings", "summary"],
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "changes_requested", "blocked"],
    },
    checklist: { type: "array", items: checklistItemSchema() },
    findings: { type: "array", items: reviewFindingSchema() },
    summary: completionSummarySchema(),
  },
};

export function createCodexProcessPlannerRunner(
  config: CodexProcessRunnerConfig = {},
): PlannerRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.cwd,
          prompt: combinePrompt(input.systemPrompt, buildPlannerUserPrompt(input)),
          model,
          sandbox: "read-only",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        const plan = normalizePlanCandidate(parseJsonText(result.finalText, "Plan"));
        if (!validatePlan(plan)) {
          throw new Error("createCodexProcessPlannerRunner: Plan schema validation failed");
        }
        return {
          plan,
          agentRun: buildAgentRun({
            role: "planner",
            depth: 0,
            status: "completed",
            riskLevel: "low",
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            outputFormatSchemaRef: "Plan@1",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "planner",
          depth: 0,
          riskLevel: "low",
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          outputFormatSchemaRef: "Plan@1",
          startedAt,
        });
      }
    },
  };
}

export function createCodexProcessDecomposerRunner(
  config: CodexProcessRunnerConfig = {},
): DecomposerRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(input: DecomposerRunnerInput): Promise<DecomposerRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.cwd,
          prompt: combinePrompt(input.systemPrompt, buildDecomposerUserPrompt(input)),
          model,
          sandbox: "read-only",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        const manifest = parseJsonText(result.finalText, "MilestoneManifest");
        if (!validateMilestoneManifest(manifest)) {
          throw new Error(
            "createCodexProcessDecomposerRunner: MilestoneManifest schema validation failed",
          );
        }
        return {
          manifest,
          agentRun: buildAgentRun({
            role: "planner",
            depth: 0,
            status: "completed",
            riskLevel: "low",
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            outputFormatSchemaRef: "MilestoneManifest@1",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "planner",
          depth: 0,
          riskLevel: "low",
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          outputFormatSchemaRef: "MilestoneManifest@1",
          startedAt,
        });
      }
    },
  };
}

export function createCodexProcessImplementerRunner(
  config: CodexProcessRunnerConfig = {},
): ImplementerRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(input: ImplementerRunnerInput): Promise<ImplementerRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.worktreePath,
          prompt: combinePrompt(
            applyFixModePreamble(input.systemPrompt, input.reviewFeedback),
            buildImplementerUserPrompt(input),
          ),
          model,
          sandbox: "workspace-write",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        return {
          agentRun: buildAgentRun({
            role: "implementer",
            depth: 1,
            status: "completed",
            riskLevel: input.task.riskLevel,
            taskId: input.task.id,
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "implementer",
          depth: 1,
          riskLevel: input.task.riskLevel,
          taskId: input.task.id,
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          startedAt,
        });
      }
    },
  };
}

export function createCodexProcessReviewerRunner(
  config: CodexProcessRunnerConfig = {},
): ReviewerRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.worktreePath,
          prompt: combinePrompt(input.systemPrompt, buildReviewerUserPrompt(input)),
          model,
          outputSchema: REVIEW_PAYLOAD_SCHEMA,
          sandbox: "read-only",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        const payload = parseReviewPayload(result.finalText);
        const reviewerRunId = randomUUID();
        const report: ReviewReport = {
          id: randomUUID(),
          taskId: input.task.id,
          reviewerRunId,
          outcome: payload.outcome,
          findings: payload.findings,
          createdAt: new Date().toISOString(),
        };
        if (!validateReviewReport(report)) {
          throw new Error("createCodexProcessReviewerRunner: ReviewReport schema validation failed");
        }
        return {
          report,
          agentRun: buildAgentRun({
            id: reviewerRunId,
            role: "auditor",
            depth: 2,
            status: "completed",
            riskLevel: input.task.riskLevel,
            taskId: input.task.id,
            workflowRunId: input.workflowRunId,
            parentSessionId: input.parentSessionId,
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            outputFormatSchemaRef: "ReviewReport@1",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "auditor",
          depth: 2,
          riskLevel: input.task.riskLevel,
          taskId: input.task.id,
          workflowRunId: input.workflowRunId,
          parentSessionId: input.parentSessionId,
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          outputFormatSchemaRef: "ReviewReport@1",
          startedAt,
        });
      }
    },
  };
}

export function createCodexProcessPhaseAuditorRunner(
  config: CodexProcessRunnerConfig = {},
): PhaseAuditorRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(input: PhaseAuditorRunnerInput): Promise<PhaseAuditorRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.worktreePath,
          prompt: combinePrompt(input.systemPrompt, buildPhaseAuditUserPrompt(input)),
          model,
          outputSchema: PHASE_AUDIT_PAYLOAD_SCHEMA,
          sandbox: "read-only",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        const payload = parsePhaseAuditPayload(result.finalText);
        const auditorRunId = randomUUID();
        const mergedHeadSha = requireSha(
          input.mergeRun.integrationHeadSha,
          "mergeRun.integrationHeadSha",
        );
        const report: PhaseAuditReport = {
          id: randomUUID(),
          phaseId: input.phase.id,
          planId: input.plan.id,
          mergeRunId: input.mergeRun.id,
          auditorRunId,
          mergedHeadSha,
          outcome: payload.outcome,
          checklist: payload.checklist,
          findings: payload.findings,
          summary: payload.summary,
          createdAt: new Date().toISOString(),
        };
        if (!validatePhaseAuditReport(report)) {
          throw new Error(
            "createCodexProcessPhaseAuditorRunner: PhaseAuditReport schema validation failed",
          );
        }
        return {
          report,
          agentRun: buildAgentRun({
            id: auditorRunId,
            role: "auditor",
            depth: 2,
            status: "completed",
            riskLevel: "medium",
            workflowRunId: input.workflowRunId,
            parentSessionId: input.parentSessionId,
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            outputFormatSchemaRef: "PhaseAuditReport@1",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "auditor",
          depth: 2,
          riskLevel: "medium",
          workflowRunId: input.workflowRunId,
          parentSessionId: input.parentSessionId,
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          outputFormatSchemaRef: "PhaseAuditReport@1",
          startedAt,
        });
      }
    },
  };
}

export function createCodexProcessCompletionAuditorRunner(
  config: CodexProcessRunnerConfig = {},
): CompletionAuditorRunner {
  return {
    _runtimeKind: "codex-process" as const,
    async run(
      input: CompletionAuditorRunnerInput,
    ): Promise<CompletionAuditorRunnerResult> {
      const startedAt = new Date().toISOString();
      const model = resolveCodexModel(input.model, config);
      let sessionId: string | undefined;
      let usage = zeroUsage();

      try {
        const result = await runCodexExec({
          cwd: input.worktreePath,
          prompt: combinePrompt(
            input.systemPrompt,
            buildCompletionAuditUserPrompt(input),
          ),
          model,
          outputSchema: COMPLETION_AUDIT_PAYLOAD_SCHEMA,
          sandbox: "read-only",
          config,
        });
        sessionId = result.sessionId;
        usage = result;
        const payload = parseCompletionAuditPayload(result.finalText);
        const auditorRunId = randomUUID();
        const auditedHeadSha = requireSha(
          input.finalMergeRun.integrationHeadSha,
          "finalMergeRun.integrationHeadSha",
        );
        const report: CompletionAuditReport = {
          id: randomUUID(),
          planId: input.plan.id,
          finalPhaseId: input.finalPhase.id,
          mergeRunId: input.finalMergeRun.id,
          auditorRunId,
          auditedHeadSha,
          outcome: payload.outcome,
          checklist: payload.checklist,
          findings: payload.findings,
          summary: payload.summary,
          createdAt: new Date().toISOString(),
        };
        if (!validateCompletionAuditReport(report)) {
          throw new Error(
            "createCodexProcessCompletionAuditorRunner: CompletionAuditReport schema validation failed",
          );
        }
        return {
          report,
          agentRun: buildAgentRun({
            id: auditorRunId,
            role: "auditor",
            depth: 2,
            status: "completed",
            riskLevel: "high",
            workflowRunId: input.workflowRunId,
            parentSessionId: input.parentSessionId,
            sessionId,
            model: model ?? "codex-cli-default",
            promptVersion: input.promptVersion,
            budgetUsdCap: input.budgetUsdCap,
            maxTurnsCap: input.maxTurnsCap,
            usage,
            stopReason: "completed",
            outputFormatSchemaRef: "CompletionAuditReport@1",
            startedAt,
          }),
        };
      } catch (err) {
        return await persistFailure(config, {
          err,
          role: "auditor",
          depth: 2,
          riskLevel: "high",
          workflowRunId: input.workflowRunId,
          parentSessionId: input.parentSessionId,
          sessionId,
          model: model ?? "codex-cli-default",
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          usage,
          outputFormatSchemaRef: "CompletionAuditReport@1",
          startedAt,
        });
      }
    },
  };
}

async function runCodexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  const executable = options.config.executablePath ?? "codex";
  const maxOutputBytes =
    options.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const schemaDir =
    options.outputSchema !== undefined
      ? await mkdtemp(path.join(tmpdir(), "pmgo-codex-schema-"))
      : undefined;
  const schemaPath =
    schemaDir !== undefined ? path.join(schemaDir, "schema.json") : undefined;

  if (schemaPath !== undefined && options.outputSchema !== undefined) {
    await writeFile(schemaPath, JSON.stringify(options.outputSchema), "utf8");
  }

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "--cd",
    options.cwd,
    "--sandbox",
    options.sandbox,
    ...(options.model !== undefined ? ["--model", options.model] : []),
    ...(schemaPath !== undefined ? ["--output-schema", schemaPath] : []),
    "-",
  ];

  try {
    const { stdout, stderr } = await spawnAndCollect({
      executable,
      args,
      cwd: options.cwd,
      input: options.prompt,
      maxOutputBytes,
    });
    return parseCodexJsonl(stdout, stderr);
  } finally {
    if (schemaDir !== undefined) {
      await rm(schemaDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function spawnAndCollect(input: {
  executable: string;
  args: string[];
  cwd: string;
  input: string;
  maxOutputBytes: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForBuffer = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > input.maxOutputBytes) {
        killedForBuffer = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > input.maxOutputBytes) {
        killedForBuffer = true;
        child.kill("SIGTERM");
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (killedForBuffer) {
        reject(new Error(`codex exec exceeded ${input.maxOutputBytes} bytes of output`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `codex exec failed with code ${code ?? "null"} signal ${signal ?? "null"}\n` +
              tailText(stderr || stdout, 4000),
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input.input);
  });
}

function parseCodexJsonl(stdout: string, stderr: string): CodexExecResult {
  let sessionId: string | undefined;
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let turns = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
      continue;
    }
    if (event.type === "turn.completed" && isRecord(event.usage)) {
      turns += 1;
      inputTokens = readNumber(event.usage.input_tokens) ?? inputTokens;
      outputTokens = readNumber(event.usage.output_tokens) ?? outputTokens;
      cacheReadTokens =
        readNumber(event.usage.cached_input_tokens) ?? cacheReadTokens;
      continue;
    }
    if (event.type === "item.completed" && isRecord(event.item)) {
      if (
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        finalText = event.item.text;
      }
    }
  }

  if (finalText.trim().length === 0) {
    throw new Error(
      "codex exec produced no final agent_message text\n" +
        tailText(stderr || stdout, 4000),
    );
  }

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    finalText,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    turns,
  };
}

function combinePrompt(systemPrompt: string, userPrompt: string): string {
  return [
    "# System instructions",
    systemPrompt,
    "",
    "# pm-go runner input",
    userPrompt,
  ].join("\n");
}

function resolveCodexModel(
  inputModel: string,
  config: CodexProcessRunnerConfig,
): string | undefined {
  if (config.model !== undefined && config.model.trim().length > 0) {
    return config.model;
  }
  if (inputModel.trim().length === 0 || inputModel.startsWith("claude-")) {
    return undefined;
  }
  return inputModel;
}

function parseJsonText(text: string, label: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse Codex ${label} JSON: ${message}\n${tailText(text, 1000)}`);
  }
}

function parseReviewPayload(text: string): ReviewPayload {
  const value = parseJsonText(text, "ReviewReport payload");
  if (!isRecord(value)) throw new Error("ReviewReport payload must be an object");
  return {
    outcome: readOutcome(value.outcome),
    findings: readFindings(value.findings),
  };
}

function parsePhaseAuditPayload(text: string): PhaseAuditPayload {
  const value = parseJsonText(text, "PhaseAuditReport payload");
  if (!isRecord(value)) throw new Error("PhaseAuditReport payload must be an object");
  return {
    outcome: readAuditOutcome(value.outcome),
    checklist: readChecklist(value.checklist),
    findings: readFindings(value.findings),
    summary: readString(value.summary, "summary"),
  };
}

function parseCompletionAuditPayload(text: string): CompletionAuditPayload {
  const value = parseJsonText(text, "CompletionAuditReport payload");
  if (!isRecord(value)) {
    throw new Error("CompletionAuditReport payload must be an object");
  }
  return {
    outcome: readAuditOutcome(value.outcome),
    checklist: readChecklist(value.checklist),
    findings: readFindings(value.findings),
    summary: readCompletionSummary(value.summary),
  };
}

function readOutcome(value: unknown): ReviewOutcome {
  if (value === "pass" || value === "changes_requested" || value === "blocked") {
    return value;
  }
  throw new Error(`invalid review outcome: ${String(value)}`);
}

function readAuditOutcome(value: unknown): "pass" | "changes_requested" | "blocked" {
  return readOutcome(value);
}

function readFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) throw new Error("findings must be an array");
  return value.map((finding, index) => {
    if (!isRecord(finding)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    const normalized = { ...finding };
    if (normalized.startLine === null) delete normalized.startLine;
    if (normalized.endLine === null) delete normalized.endLine;
    return normalized as unknown as ReviewFinding;
  });
}

function readChecklist(value: unknown): CompletionChecklistItem[] {
  if (!Array.isArray(value)) throw new Error("checklist must be an array");
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`checklist[${index}] must be an object`);
    }
    const normalized = { ...item };
    if (normalized.relatedTaskIds === null) delete normalized.relatedTaskIds;
    if (normalized.notes === null) delete normalized.notes;
    return normalized as unknown as CompletionChecklistItem;
  });
}

function readCompletionSummary(value: unknown): CompletionAuditSummary {
  if (!isRecord(value)) throw new Error("summary must be an object");
  const summary = value as unknown as CompletionAuditSummary;
  if (
    !Array.isArray(summary.acceptanceCriteriaPassed) ||
    !Array.isArray(summary.acceptanceCriteriaMissing) ||
    !Array.isArray(summary.openFindingIds) ||
    !Array.isArray(summary.unresolvedPolicyDecisionIds)
  ) {
    throw new Error("summary has invalid completion audit arrays");
  }
  return summary;
}

interface FailureInput {
  err: unknown;
  role: AgentRun["role"];
  depth: AgentRun["depth"];
  riskLevel: AgentRun["riskLevel"];
  taskId?: string | undefined;
  workflowRunId?: string | undefined;
  parentSessionId?: string | undefined;
  sessionId?: string | undefined;
  model: string;
  promptVersion: string;
  budgetUsdCap?: number | undefined;
  maxTurnsCap?: number | undefined;
  usage: CodexExecResult;
  outputFormatSchemaRef?: string | undefined;
  startedAt: string;
}

async function persistFailure(
  config: CodexProcessRunnerConfig,
  input: FailureInput,
): Promise<never> {
  const classified = classifyExecutorError(input.err);
  await safeInvokeFailureSink(
    config.onFailure,
    buildAgentRun({
      role: input.role,
      depth: input.depth,
      status: "failed",
      riskLevel: input.riskLevel,
      taskId: input.taskId,
      workflowRunId: input.workflowRunId,
      parentSessionId: input.parentSessionId,
      sessionId: input.sessionId,
      model: input.model,
      promptVersion: input.promptVersion,
      budgetUsdCap: input.budgetUsdCap,
      maxTurnsCap: input.maxTurnsCap,
      usage: input.usage,
      stopReason: "error",
      errorReason: errorReasonFromClassified(classified),
      outputFormatSchemaRef: input.outputFormatSchemaRef,
      startedAt: input.startedAt,
    }),
  );
  throw classified;
}

interface AgentRunBuilderInput {
  id?: string | undefined;
  role: AgentRun["role"];
  depth: AgentRun["depth"];
  status: AgentRun["status"];
  riskLevel: AgentRun["riskLevel"];
  taskId?: string | undefined;
  workflowRunId?: string | undefined;
  parentSessionId?: string | undefined;
  sessionId?: string | undefined;
  model: string;
  promptVersion: string;
  budgetUsdCap?: number | undefined;
  maxTurnsCap?: number | undefined;
  usage: CodexExecResult;
  stopReason: AgentStopReason;
  errorReason?: string | undefined;
  outputFormatSchemaRef?: string | undefined;
  startedAt: string;
}

function buildAgentRun(input: AgentRunBuilderInput): AgentRun {
  const run: AgentRun = {
    id: input.id ?? randomUUID(),
    workflowRunId: input.workflowRunId ?? input.sessionId ?? randomUUID(),
    role: input.role,
    depth: input.depth,
    status: input.status,
    riskLevel: input.riskLevel,
    executor: "codex",
    model: input.model,
    promptVersion: input.promptVersion,
    permissionMode: "default",
    turns: input.usage.turns,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: input.usage.cacheReadTokens,
    costUsd: 0,
    stopReason: input.stopReason,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
  };
  if (input.taskId !== undefined) run.taskId = input.taskId;
  if (input.parentSessionId !== undefined) {
    run.parentSessionId = input.parentSessionId;
  }
  if (input.sessionId !== undefined) run.sessionId = input.sessionId;
  if (input.budgetUsdCap !== undefined) run.budgetUsdCap = input.budgetUsdCap;
  if (input.maxTurnsCap !== undefined) run.maxTurnsCap = input.maxTurnsCap;
  if (input.errorReason !== undefined) run.errorReason = input.errorReason;
  if (input.outputFormatSchemaRef !== undefined) {
    run.outputFormatSchemaRef = input.outputFormatSchemaRef;
  }
  return run;
}

function zeroUsage(): CodexExecResult {
  return {
    finalText: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
  };
}

function buildPlannerUserPrompt(input: PlannerRunnerInput): string {
  return [
    `# Specification (id ${input.specDocument.id})`,
    `Title: ${input.specDocument.title}`,
    "",
    input.specDocument.body,
    "",
    `# RepoSnapshot (id ${input.repoSnapshot.id})`,
    JSON.stringify(
      {
        repoRoot: input.repoSnapshot.repoRoot,
        defaultBranch: input.repoSnapshot.defaultBranch,
        headSha: input.repoSnapshot.headSha,
        languageHints: input.repoSnapshot.languageHints,
        frameworkHints: input.repoSnapshot.frameworkHints,
        manifestPaths: input.repoSnapshot.manifestPaths ?? [],
      },
      null,
      2,
    ),
    "",
    "## Plan@1 JSON schema",
    JSON.stringify(PlanJsonSchema, null, 2),
    "",
    [
      "Return only a Plan JSON object accepted by this schema.",
      "Use UUID strings for every id field and ISO-8601 strings for timestamps.",
      "Keep phase.taskIds, phase.mergeOrder, dependency edges, and task.phaseId values internally consistent.",
      "Set reviewerPolicy.reviewerWriteAccess to false.",
      "For optional fields, omit the property when unknown; never use null for optional properties.",
      "For full-spec plans, omit decompositionId, milestoneId, and predecessorPlanId unless the runner input explicitly provides milestone context.",
      "Do not wrap the JSON in Markdown fences or explanatory text.",
    ].join(" "),
  ].join("\n");
}

function normalizePlanCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const plan = omitNullOptionals({ ...value }, [
    "autoApproveLowRisk",
    "decompositionId",
    "milestoneId",
    "predecessorPlanId",
  ]);

  if (Array.isArray(plan.phases)) {
    plan.phases = plan.phases.map((phase) => {
      if (!isRecord(phase)) return phase;
      return omitNullOptionals({ ...phase }, [
        "phaseAuditReportId",
        "startedAt",
        "completedAt",
      ]);
    });
  }

  if (Array.isArray(plan.tasks)) {
    plan.tasks = plan.tasks.map((task) => {
      if (!isRecord(task)) return task;
      const normalizedTask = omitNullOptionals({ ...task }, [
        "sizeHint",
        "branchName",
        "worktreePath",
      ]);
      if (isRecord(normalizedTask.fileScope)) {
        normalizedTask.fileScope = omitNullOptionals(
          { ...normalizedTask.fileScope },
          ["excludes", "packageScopes", "maxFiles"],
        );
      }
      if (isRecord(normalizedTask.budget)) {
        normalizedTask.budget = omitNullOptionals(
          { ...normalizedTask.budget },
          ["maxModelCostUsd", "maxPromptTokens"],
        );
      }
      return normalizedTask;
    });
  }

  return plan;
}

function omitNullOptionals<T extends Record<string, unknown>>(
  value: T,
  keys: readonly string[],
): T {
  for (const key of keys) {
    if (value[key] === null) delete value[key];
  }
  return value;
}

function buildDecomposerUserPrompt(input: DecomposerRunnerInput): string {
  return [
    `# Specification (id ${input.specDocument.id})`,
    `Title: ${input.specDocument.title}`,
    "",
    input.specDocument.body,
    "",
    `# RepoSnapshot (id ${input.repoSnapshot.id})`,
    JSON.stringify(
      {
        repoRoot: input.repoSnapshot.repoRoot,
        defaultBranch: input.repoSnapshot.defaultBranch,
        headSha: input.repoSnapshot.headSha,
        languageHints: input.repoSnapshot.languageHints,
        frameworkHints: input.repoSnapshot.frameworkHints,
        manifestPaths: input.repoSnapshot.manifestPaths ?? [],
      },
      null,
      2,
    ),
    "",
    "## MilestoneManifest@1 JSON schema",
    JSON.stringify(MilestoneManifestJsonSchema, null, 2),
    "",
    [
      "Return only a MilestoneManifest JSON object accepted by this schema.",
      "Use the exact specDocumentId and repoSnapshotId shown above.",
      "Use mNN-slug milestone ids, topologically order milestones, and keep dependsOn references pointed only at earlier milestone ids.",
      "Do not wrap the JSON in Markdown fences or explanatory text.",
    ].join(" "),
  ].join("\n");
}

function buildImplementerUserPrompt(input: ImplementerRunnerInput): string {
  const task = input.task;
  const acceptance =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria
          .map(
            (ac) =>
              `- [${ac.required ? "required" : "optional"}] ${ac.id}: ${ac.description}` +
              (ac.verificationCommands.length > 0
                ? `\n  verify: ${ac.verificationCommands.join(" && ")}`
                : ""),
          )
          .join("\n")
      : "- (none declared)";
  const tests =
    task.testCommands.length > 0
      ? task.testCommands.map((c) => `- \`${c}\``).join("\n")
      : "- (none declared)";

  return [
    `# Task (id ${task.id})`,
    `Title: ${task.title}`,
    `Slug: ${task.slug}`,
    `Kind: ${task.kind}`,
    `Risk level: ${task.riskLevel}`,
    "",
    "## Summary",
    task.summary,
    "",
    "## fileScope",
    `includes: ${JSON.stringify(task.fileScope.includes)}`,
    `excludes: ${JSON.stringify(task.fileScope.excludes ?? [])}`,
    "",
    "## Acceptance criteria",
    acceptance,
    "",
    "## Test commands",
    tests,
    "",
    "## Worktree",
    `- cwd: ${input.worktreePath}`,
    `- baseSha: ${input.baseSha}`,
    "",
    "Work only inside the cwd above. Do not run git commit; pm-go will stage and commit pending changes after you finish. Keep edits inside fileScope. Run the declared verification commands when feasible. End with a short implementation summary.",
  ].join("\n");
}

function buildReviewerUserPrompt(input: ReviewerRunnerInput): string {
  return [
    `# Task under review (id ${input.task.id})`,
    `Title: ${input.task.title}`,
    `Slug: ${input.task.slug}`,
    `Review cycle: ${input.cycleNumber}`,
    `Strictness: ${input.strictness}`,
    "",
    "## Summary",
    input.task.summary,
    "",
    "## Git context",
    `- baseSha: ${input.baseSha}`,
    `- headSha: ${input.headSha}`,
    "",
    "Inspect the worktree read-only. Return JSON with outcome and findings. Use outcome pass only when the task satisfies its acceptance criteria without material regressions.",
  ].join("\n");
}

function buildPhaseAuditUserPrompt(input: PhaseAuditorRunnerInput): string {
  return [
    `# Phase audit`,
    `Plan: ${input.plan.id} ${input.plan.title}`,
    `Phase: ${input.phase.id} index=${input.phase.index} ${input.phase.title}`,
    `MergeRun: ${input.mergeRun.id}`,
    `Base SHA: ${input.baseSha}`,
    `Merged head SHA: ${input.mergeRun.integrationHeadSha}`,
    "",
    "## Evidence",
    JSON.stringify(input.evidence, null, 2),
    "",
    "Audit the merged phase against the plan, task acceptance criteria, review reports, policy decisions, and diff summary. Return JSON with outcome, checklist, findings, and summary.",
  ].join("\n");
}

function buildCompletionAuditUserPrompt(
  input: CompletionAuditorRunnerInput,
): string {
  return [
    "# Completion audit",
    `Plan: ${input.plan.id} ${input.plan.title}`,
    `Final phase: ${input.finalPhase.id} index=${input.finalPhase.index}`,
    `Final merge run: ${input.finalMergeRun.id}`,
    `Base SHA: ${input.baseSha}`,
    `Audited head SHA: ${input.finalMergeRun.integrationHeadSha}`,
    "",
    "## Evidence",
    JSON.stringify(input.evidence, null, 2),
    "",
    "Audit the full plan for release readiness. Return JSON with outcome, checklist, findings, and summary.",
  ].join("\n");
}

function applyFixModePreamble(
  systemPrompt: string,
  reviewFeedback: ImplementerRunnerInput["reviewFeedback"],
): string {
  if (!reviewFeedback) return systemPrompt;
  const findings = reviewFeedback.findings
    .map(
      (f) =>
        `- ${f.id} [${f.severity}] ${f.title}: ${f.summary}\n  file: ${f.filePath}` +
        (f.startLine !== undefined ? `:${f.startLine}` : "") +
        `\n  suggested fix: ${f.suggestedFixDirection}`,
    )
    .join("\n");
  return [
    systemPrompt,
    "",
    "# Fix mode",
    `This is fix cycle ${reviewFeedback.cycleNumber}/${reviewFeedback.maxCycles}.`,
    `Review report: ${reviewFeedback.reportId}`,
    findings.length > 0 ? findings : "- No concrete findings supplied.",
  ].join("\n");
}

function reviewFindingSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "severity",
      "title",
      "summary",
      "filePath",
      "startLine",
      "endLine",
      "confidence",
      "suggestedFixDirection",
    ],
    properties: {
      id: { type: "string" },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      title: { type: "string" },
      summary: { type: "string" },
      filePath: { type: "string" },
      startLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
      endLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
      confidence: { type: "number" },
      suggestedFixDirection: { type: "string" },
    },
  };
}

function checklistItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "title",
      "status",
      "evidenceArtifactIds",
      "relatedTaskIds",
      "notes",
    ],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      status: {
        type: "string",
        enum: ["passed", "failed", "not_verified", "waived"],
      },
      evidenceArtifactIds: { type: "array", items: { type: "string" } },
      relatedTaskIds: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "null" },
        ],
      },
      notes: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
}

function completionSummarySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "acceptanceCriteriaPassed",
      "acceptanceCriteriaMissing",
      "openFindingIds",
      "unresolvedPolicyDecisionIds",
    ],
    properties: {
      acceptanceCriteriaPassed: { type: "array", items: { type: "string" } },
      acceptanceCriteriaMissing: { type: "array", items: { type: "string" } },
      openFindingIds: { type: "array", items: { type: "string" } },
      unresolvedPolicyDecisionIds: { type: "array", items: { type: "string" } },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a 40-character lowercase git SHA`);
  }
  return value;
}

function tailText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}
