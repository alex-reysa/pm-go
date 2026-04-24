/**
 * Process-backed runner factories.
 *
 * Each `create*ProcessRunner` factory returns an object that satisfies the
 * matching runner interface from `@pm-go/executor-claude`.  The runners
 * wire together:
 *   - `spawnClaude`       — launches the Claude CLI as a child process
 *   - `mapClaudeStream`   — consumes the JSONL stdout into accumulators
 *   - `PolicyBridgeServer` — HTTP MCP server that enforces role + fileScope
 *
 * Unlike the SDK-backed runners these factories do NOT import
 * `@anthropic-ai/claude-agent-sdk`; they interact with the Claude binary
 * directly via `node:child_process`.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  AgentRun,
  AgentStopReason,
  CompletionAuditReport,
  PhaseAuditReport,
  Plan,
  ReviewReport,
} from "@pm-go/contracts";

import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
  type AgentRunFailureSink,
  type CompletionAuditorRunner,
  type CompletionAuditorRunnerInput,
  type CompletionAuditorRunnerResult,
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

import { spawnClaude, type SpawnClaudeOptions } from "./claude/spawn.js";
import { mapClaudeStream } from "./claude/stream-mapper.js";
import {
  createPolicyBridgeServer,
  type PolicyBridgeSink,
} from "./claude/policy-bridge.js";

export type { AgentRunFailureSink };

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared config base
// ---------------------------------------------------------------------------

export interface ProcessRunnerConfig {
  /**
   * Override the Claude CLI executable path. Defaults to `"claude"`.
   * Useful in tests / environments where the binary lives elsewhere.
   */
  executablePath?: string;
  /** Startup timeout forwarded to `spawnClaude`. Defaults to 30 000 ms. */
  startupTimeoutMs?: number;
  /** Called just before the runner re-throws a classified error. */
  onFailure?: AgentRunFailureSink;
  /** Receives `tool_call` + `policy_decision` events from the policy bridge. */
  eventSink?: PolicyBridgeSink;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the standard CLI args for a single-shot `claude --print` invocation
 * with stream-json output and an MCP server URL for the policy bridge.
 */
function buildClaudeArgs(opts: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  mcpServerUrl: string;
  outputFormat?: "stream-json" | "json" | undefined;
  maxTurns?: number | undefined;
}): string[] {
  const args: string[] = [
    "--print",
    "--output-format",
    opts.outputFormat ?? "stream-json",
    "--model",
    opts.model,
    "--system-prompt",
    opts.systemPrompt,
    "--mcp-server-url",
    opts.mcpServerUrl,
    "--disallow-tools",
    // Block native write-class tools so every write must flow through the
    // MCP policy bridge (mcp__*).  Do NOT include "mcp__*" here — that glob
    // would disable the bridge's own tools, defeating policy enforcement.
    "WebSearch,WebFetch,Write,Edit,NotebookEdit,Bash",
  ];

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  // The user prompt is passed as the positional argument.
  args.push(opts.userPrompt);

  return args;
}

/** Convert a `StreamMapResult.stopReason` to `AgentStopReason`. */
function resolveStopReason(
  mapped: AgentStopReason,
  isError: boolean,
): AgentStopReason {
  if (isError && mapped === "completed") return "error";
  return mapped;
}

/** If the stream contained a content-filter error, surface it via `classifyExecutorError`. */
function maybeThrowContentFilterError(contentFilterError: {
  status: number;
  message: string;
} | undefined): void {
  if (!contentFilterError) return;
  const err = Object.assign(new Error(contentFilterError.message), {
    status: contentFilterError.status,
  });
  throw classifyExecutorError(err);
}

/** Best-effort: read HEAD sha in the worktree. */
async function tryReadHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Planner process runner
// ---------------------------------------------------------------------------

export interface ClaudeProcessPlannerRunnerConfig extends ProcessRunnerConfig {}

export function createClaudeProcessPlannerRunner(
  config: ClaudeProcessPlannerRunnerConfig = {},
): PlannerRunner {
  return {
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const startedAt = new Date().toISOString();

      const bridge = await createPolicyBridgeServer({
        role: "planner",
        ...(config.eventSink !== undefined ? { sink: config.eventSink } : {}),
      });

      const spawnOpts: SpawnClaudeOptions = {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(config.startupTimeoutMs !== undefined ? { startupTimeoutMs: config.startupTimeoutMs } : {}),
        ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
      };

      const userPrompt = buildPlannerUserPrompt(input);
      const args = buildClaudeArgs({
        systemPrompt: input.systemPrompt,
        userPrompt,
        model: input.model,
        mcpServerUrl: bridge.url,
        outputFormat: "stream-json",
        ...(input.maxTurnsCap !== undefined ? { maxTurns: input.maxTurnsCap } : {}),
      });

      let plan: Plan | undefined;
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      try {
        const child = await spawnClaude(args, spawnOpts);
        // Drain stderr so a large stderr output never deadlocks the child.
        child.stderr?.resume();
        const mapped = await mapClaudeStream(child.stdout!);

        sessionId = mapped.sessionId;
        inputTokens = mapped.inputTokens;
        outputTokens = mapped.outputTokens;
        cacheCreationTokens = mapped.cacheCreationTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        costUsd = mapped.costUsd;
        turns = mapped.turns;
        stopReason = resolveStopReason(mapped.stopReason, mapped.isError);

        maybeThrowContentFilterError(mapped.contentFilterError);

        if (mapped.structuredOutput !== undefined) {
          plan = mapped.structuredOutput as Plan;
        }
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = buildAgentRun({
          role: "planner",
          depth: 0,
          status: "failed",
          riskLevel: "low",
          sessionId,
          model: input.model,
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
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
        });
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      } finally {
        await bridge.close().catch(() => undefined);
      }

      if (!plan) {
        throw new Error(
          "createClaudeProcessPlannerRunner: no structured Plan in stream output",
        );
      }

      const agentRun = buildAgentRun({
        role: "planner",
        depth: 0,
        status: "completed",
        riskLevel: "low",
        sessionId,
        model: input.model,
        promptVersion: input.promptVersion,
        budgetUsdCap: input.budgetUsdCap,
        maxTurnsCap: input.maxTurnsCap,
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        outputFormatSchemaRef: "Plan@1",
        startedAt,
      });

      return { plan, agentRun };
    },
  };
}

// ---------------------------------------------------------------------------
// Implementer process runner
// ---------------------------------------------------------------------------

export interface ClaudeProcessImplementerRunnerConfig
  extends ProcessRunnerConfig {}

export function createClaudeProcessImplementerRunner(
  config: ClaudeProcessImplementerRunnerConfig = {},
): ImplementerRunner {
  return {
    async run(
      input: ImplementerRunnerInput,
    ): Promise<ImplementerRunnerResult> {
      const startedAt = new Date().toISOString();
      const cwd = input.worktreePath;

      const bridge = await createPolicyBridgeServer({
        role: "implementer",
        fileScope: input.task.fileScope,
        worktreePath: cwd,
        sink: config.eventSink,
      });

      const preRunHeadSha = await tryReadHeadSha(cwd);

      const spawnOpts: SpawnClaudeOptions = {
        cwd,
        startupTimeoutMs: config.startupTimeoutMs,
        executablePath: config.executablePath,
      };

      const userPrompt = buildImplementerUserPrompt(input);
      const args = buildClaudeArgs({
        systemPrompt: input.systemPrompt,
        userPrompt,
        model: input.model,
        mcpServerUrl: bridge.url,
        outputFormat: "stream-json",
        maxTurns: input.maxTurnsCap,
      });

      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      try {
        const child = await spawnClaude(args, spawnOpts);
        // Drain stderr so a large stderr output never deadlocks the child.
        child.stderr?.resume();
        const mapped = await mapClaudeStream(child.stdout!);

        sessionId = mapped.sessionId;
        inputTokens = mapped.inputTokens;
        outputTokens = mapped.outputTokens;
        cacheCreationTokens = mapped.cacheCreationTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        costUsd = mapped.costUsd;
        turns = mapped.turns;
        stopReason = resolveStopReason(mapped.stopReason, mapped.isError);

        maybeThrowContentFilterError(mapped.contentFilterError);
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = buildAgentRun({
          role: "implementer",
          depth: 1,
          status: "failed",
          riskLevel: input.task.riskLevel,
          taskId: input.task.id,
          sessionId,
          model: input.model,
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          turns,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          costUsd,
          stopReason: "error",
          errorReason: errorReasonFromClassified(classified),
          startedAt,
        });
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      } finally {
        await bridge.close().catch(() => undefined);
      }

      const postRunHeadSha = await tryReadHeadSha(cwd);
      const finalCommitSha =
        postRunHeadSha !== undefined && postRunHeadSha !== preRunHeadSha
          ? postRunHeadSha
          : undefined;

      const agentRun = buildAgentRun({
        role: "implementer",
        depth: 1,
        status: "completed",
        riskLevel: input.task.riskLevel,
        taskId: input.task.id,
        sessionId,
        model: input.model,
        promptVersion: input.promptVersion,
        budgetUsdCap: input.budgetUsdCap,
        maxTurnsCap: input.maxTurnsCap,
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        startedAt,
      });

      return finalCommitSha !== undefined
        ? { agentRun, finalCommitSha }
        : { agentRun };
    },
  };
}

// ---------------------------------------------------------------------------
// Reviewer process runner
// ---------------------------------------------------------------------------

export interface ClaudeProcessReviewerRunnerConfig
  extends ProcessRunnerConfig {}

export function createClaudeProcessReviewerRunner(
  config: ClaudeProcessReviewerRunnerConfig = {},
): ReviewerRunner {
  return {
    async run(input: ReviewerRunnerInput): Promise<ReviewerRunnerResult> {
      const startedAt = new Date().toISOString();
      const cwd = input.worktreePath;

      const bridge = await createPolicyBridgeServer({
        role: "reviewer",
        sink: config.eventSink,
      });

      const spawnOpts: SpawnClaudeOptions = {
        cwd,
        startupTimeoutMs: config.startupTimeoutMs,
        executablePath: config.executablePath,
      };

      const userPrompt = buildReviewerUserPrompt(input);
      const args = buildClaudeArgs({
        systemPrompt: input.systemPrompt,
        userPrompt,
        model: input.model,
        mcpServerUrl: bridge.url,
        outputFormat: "stream-json",
        maxTurns: input.maxTurnsCap,
      });

      let reportPayload: ReviewReport | undefined;
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      try {
        const child = await spawnClaude(args, spawnOpts);
        // Drain stderr so a large stderr output never deadlocks the child.
        child.stderr?.resume();
        const mapped = await mapClaudeStream(child.stdout!);

        sessionId = mapped.sessionId;
        inputTokens = mapped.inputTokens;
        outputTokens = mapped.outputTokens;
        cacheCreationTokens = mapped.cacheCreationTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        costUsd = mapped.costUsd;
        turns = mapped.turns;
        stopReason = resolveStopReason(mapped.stopReason, mapped.isError);

        maybeThrowContentFilterError(mapped.contentFilterError);

        if (mapped.structuredOutput !== undefined) {
          reportPayload = mapped.structuredOutput as ReviewReport;
        }
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = buildAgentRun({
          role: "auditor",
          depth: 2,
          status: "failed",
          riskLevel: input.task.riskLevel,
          taskId: input.task.id,
          sessionId,
          model: input.model,
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
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
        });
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      } finally {
        await bridge.close().catch(() => undefined);
      }

      if (!reportPayload) {
        throw new Error(
          "createClaudeProcessReviewerRunner: no structured ReviewReport in stream output",
        );
      }

      const reviewerRunId = randomUUID();
      const report: ReviewReport = {
        ...(reportPayload as ReviewReport),
        id: randomUUID(),
        taskId: input.task.id,
        reviewerRunId,
      };

      const agentRun = buildAgentRun({
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: input.task.riskLevel,
        taskId: input.task.id,
        sessionId,
        model: input.model,
        promptVersion: input.promptVersion,
        budgetUsdCap: input.budgetUsdCap,
        maxTurnsCap: input.maxTurnsCap,
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        outputFormatSchemaRef: "ReviewReport@1",
        startedAt,
      });
      agentRun.id = reviewerRunId;

      return { report, agentRun };
    },
  };
}

// ---------------------------------------------------------------------------
// Phase auditor process runner
// ---------------------------------------------------------------------------

export interface ClaudeProcessPhaseAuditorRunnerConfig
  extends ProcessRunnerConfig {}

export function createClaudeProcessPhaseAuditorRunner(
  config: ClaudeProcessPhaseAuditorRunnerConfig = {},
): PhaseAuditorRunner {
  return {
    async run(
      input: PhaseAuditorRunnerInput,
    ): Promise<PhaseAuditorRunnerResult> {
      const startedAt = new Date().toISOString();
      const cwd = input.worktreePath;

      const bridge = await createPolicyBridgeServer({
        role: "phase-auditor",
        sink: config.eventSink,
      });

      const spawnOpts: SpawnClaudeOptions = {
        cwd,
        startupTimeoutMs: config.startupTimeoutMs,
        executablePath: config.executablePath,
      };

      const userPrompt = JSON.stringify({
        plan: input.plan,
        phase: input.phase,
        mergeRun: input.mergeRun,
        evidence: input.evidence,
      });

      const args = buildClaudeArgs({
        systemPrompt: input.systemPrompt,
        userPrompt,
        model: input.model,
        mcpServerUrl: bridge.url,
        outputFormat: "stream-json",
        maxTurns: input.maxTurnsCap,
      });

      let reportPayload: PhaseAuditReport | undefined;
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      try {
        const child = await spawnClaude(args, spawnOpts);
        // Drain stderr so a large stderr output never deadlocks the child.
        child.stderr?.resume();
        const mapped = await mapClaudeStream(child.stdout!);

        sessionId = mapped.sessionId;
        inputTokens = mapped.inputTokens;
        outputTokens = mapped.outputTokens;
        cacheCreationTokens = mapped.cacheCreationTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        costUsd = mapped.costUsd;
        turns = mapped.turns;
        stopReason = resolveStopReason(mapped.stopReason, mapped.isError);

        maybeThrowContentFilterError(mapped.contentFilterError);

        if (mapped.structuredOutput !== undefined) {
          reportPayload = mapped.structuredOutput as PhaseAuditReport;
        }
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = buildAgentRun({
          role: "auditor",
          depth: 2,
          status: "failed",
          riskLevel: "medium",
          sessionId,
          model: input.model,
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
          turns,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          costUsd,
          stopReason: "error",
          errorReason: errorReasonFromClassified(classified),
          outputFormatSchemaRef: "PhaseAuditReport@1",
          startedAt,
        });
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      } finally {
        await bridge.close().catch(() => undefined);
      }

      if (!reportPayload) {
        throw new Error(
          "createClaudeProcessPhaseAuditorRunner: no structured PhaseAuditReport in stream output",
        );
      }

      const agentRun = buildAgentRun({
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: "medium",
        sessionId,
        model: input.model,
        promptVersion: input.promptVersion,
        budgetUsdCap: input.budgetUsdCap,
        maxTurnsCap: input.maxTurnsCap,
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        outputFormatSchemaRef: "PhaseAuditReport@1",
        startedAt,
      });

      return { report: reportPayload, agentRun };
    },
  };
}

// ---------------------------------------------------------------------------
// Completion auditor process runner
// ---------------------------------------------------------------------------

export interface ClaudeProcessCompletionAuditorRunnerConfig
  extends ProcessRunnerConfig {}

export function createClaudeProcessCompletionAuditorRunner(
  config: ClaudeProcessCompletionAuditorRunnerConfig = {},
): CompletionAuditorRunner {
  return {
    async run(
      input: CompletionAuditorRunnerInput,
    ): Promise<CompletionAuditorRunnerResult> {
      const startedAt = new Date().toISOString();
      const cwd = input.worktreePath;

      const bridge = await createPolicyBridgeServer({
        role: "completion-auditor",
        sink: config.eventSink,
      });

      const spawnOpts: SpawnClaudeOptions = {
        cwd,
        startupTimeoutMs: config.startupTimeoutMs,
        executablePath: config.executablePath,
      };

      const userPrompt = JSON.stringify({
        plan: input.plan,
        finalPhase: input.finalPhase,
        finalMergeRun: input.finalMergeRun,
        evidence: input.evidence,
      });

      const args = buildClaudeArgs({
        systemPrompt: input.systemPrompt,
        userPrompt,
        model: input.model,
        mcpServerUrl: bridge.url,
        outputFormat: "stream-json",
        maxTurns: input.maxTurnsCap,
      });

      let reportPayload: CompletionAuditReport | undefined;
      let sessionId: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let costUsd = 0;
      let turns = 0;
      let stopReason: AgentStopReason = "completed";

      try {
        const child = await spawnClaude(args, spawnOpts);
        // Drain stderr so a large stderr output never deadlocks the child.
        child.stderr?.resume();
        const mapped = await mapClaudeStream(child.stdout!);

        sessionId = mapped.sessionId;
        inputTokens = mapped.inputTokens;
        outputTokens = mapped.outputTokens;
        cacheCreationTokens = mapped.cacheCreationTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        costUsd = mapped.costUsd;
        turns = mapped.turns;
        stopReason = resolveStopReason(mapped.stopReason, mapped.isError);

        maybeThrowContentFilterError(mapped.contentFilterError);

        if (mapped.structuredOutput !== undefined) {
          reportPayload = mapped.structuredOutput as CompletionAuditReport;
        }
      } catch (err) {
        stopReason = "error";
        const classified = classifyExecutorError(err);
        const failedRun: AgentRun = buildAgentRun({
          role: "auditor",
          depth: 2,
          status: "failed",
          riskLevel: "medium",
          sessionId,
          model: input.model,
          promptVersion: input.promptVersion,
          budgetUsdCap: input.budgetUsdCap,
          maxTurnsCap: input.maxTurnsCap,
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
        });
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      } finally {
        await bridge.close().catch(() => undefined);
      }

      if (!reportPayload) {
        throw new Error(
          "createClaudeProcessCompletionAuditorRunner: no structured CompletionAuditReport in stream output",
        );
      }

      const agentRun = buildAgentRun({
        role: "auditor",
        depth: 2,
        status: "completed",
        riskLevel: "medium",
        sessionId,
        model: input.model,
        promptVersion: input.promptVersion,
        budgetUsdCap: input.budgetUsdCap,
        maxTurnsCap: input.maxTurnsCap,
        turns,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        stopReason,
        outputFormatSchemaRef: "CompletionAuditReport@1",
        startedAt,
      });

      return { report: reportPayload, agentRun };
    },
  };
}

// ---------------------------------------------------------------------------
// AgentRun builder
// ---------------------------------------------------------------------------

interface AgentRunBuilderInput {
  role: AgentRun["role"];
  depth: AgentRun["depth"];
  status: AgentRun["status"];
  riskLevel: AgentRun["riskLevel"];
  taskId?: AgentRun["taskId"] | undefined;
  sessionId?: string | undefined;
  model: string;
  promptVersion: string;
  budgetUsdCap?: number | undefined;
  maxTurnsCap?: number | undefined;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  stopReason: AgentStopReason;
  errorReason?: string | undefined;
  outputFormatSchemaRef?: string | undefined;
  startedAt: string;
}

function buildAgentRun(b: AgentRunBuilderInput): AgentRun {
  const run: AgentRun = {
    id: randomUUID(),
    workflowRunId: b.sessionId ?? randomUUID(),
    role: b.role,
    depth: b.depth,
    status: b.status,
    riskLevel: b.riskLevel,
    executor: "claude",
    model: b.model,
    promptVersion: b.promptVersion,
    permissionMode: "default",
    turns: b.turns,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    cacheReadTokens: b.cacheReadTokens,
    costUsd: b.costUsd,
    stopReason: b.stopReason,
    startedAt: b.startedAt,
    completedAt: new Date().toISOString(),
  };

  if (b.taskId !== undefined) run.taskId = b.taskId;
  if (b.sessionId !== undefined) run.sessionId = b.sessionId;
  if (b.budgetUsdCap !== undefined) run.budgetUsdCap = b.budgetUsdCap;
  if (b.maxTurnsCap !== undefined) run.maxTurnsCap = b.maxTurnsCap;
  if (b.errorReason !== undefined) run.errorReason = b.errorReason;
  if (b.outputFormatSchemaRef !== undefined)
    run.outputFormatSchemaRef = b.outputFormatSchemaRef;

  return run;
}

// ---------------------------------------------------------------------------
// User-prompt builders (minimal; the full system prompt provides context)
// ---------------------------------------------------------------------------

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
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildImplementerUserPrompt(input: ImplementerRunnerInput): string {
  const task = input.task;
  return [
    `# Task (id ${task.id})`,
    `Title: ${task.title}`,
    `Slug: ${task.slug}`,
    "",
    "## Summary",
    task.summary,
    "",
    "## fileScope",
    `includes: ${JSON.stringify(task.fileScope.includes)}`,
    `excludes: ${JSON.stringify(task.fileScope.excludes ?? [])}`,
    "",
    `## Worktree`,
    `- cwd: ${input.worktreePath}`,
    `- baseSha: ${input.baseSha}`,
  ].join("\n");
}

function buildReviewerUserPrompt(input: ReviewerRunnerInput): string {
  return [
    `# Task under review (id ${input.task.id})`,
    `Title: ${input.task.title}`,
    `Review cycle: ${input.cycleNumber}`,
    `Strictness: ${input.strictness}`,
    "",
    "## Summary",
    input.task.summary,
    "",
    `## Git context`,
    `- baseSha: ${input.baseSha}`,
    `- headSha: ${input.headSha}`,
  ].join("\n");
}
