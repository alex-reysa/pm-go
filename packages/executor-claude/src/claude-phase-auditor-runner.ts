import { randomUUID } from "node:crypto";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AcceptanceCriterion,
  AgentRun,
  AgentStopReason,
  FileScope,
  PhaseAuditReport,
  StoredReviewReport,
  Task,
} from "@pm-go/contracts";

import { REVIEWER_FORBIDDEN_BASH_PATTERNS } from "./claude-reviewer-runner.js";
import { findForbiddenBashPatternAgainst } from "./implementer-runner.js";
import { isInsideCwd } from "./planner-runner.js";

/**
 * Auditor-only Bash containment patterns. The auditors (phase +
 * completion) are strictly read-only AND worktree-scoped — they have
 * no legitimate reason to touch paths outside the integration
 * worktree, dump environment variables, or operate on a different
 * repository via `git -C`. The reviewer's forbidden list blocks
 * *writes*; this list blocks *reads and introspection outside the
 * intended scope*.
 *
 * These patterns are deliberately narrow and explicit: we deny
 * well-known leak vectors rather than try to parse arbitrary shell
 * syntax, and we stop short of matching every `../` in a command
 * string (tests and tools legitimately use relative parent refs
 * *inside* the worktree via arguments like `git log -- path/../other`).
 *
 * Exported so both auditor runners share the same policy — the
 * completion auditor runner imports this list.
 */
export const AUDITOR_CONTAINMENT_PATTERNS: Array<{
  name: string;
  re: RegExp;
}> = [
  // `git -C <path>` lets the agent jump to an arbitrary repository.
  // The auditor's cwd is the integration worktree; use plain `git ...`
  // without the -C argument to stay in it.
  { name: "git -C (cross-repo)", re: /\bgit\s+-C\b/ },
  // Environment dump — auditors should never need process env.
  { name: "printenv", re: /\bprintenv\b/ },
  // `env` with no args dumps everything; `env VAR=val cmd` is uncommon
  // inside an auditor. Block broadly — if a legitimate use surfaces
  // the policy can relax.
  { name: "env", re: /\benv\b/ },
  // Absolute-path reads via the usual file-dump utilities. The
  // `[^|;&\n]*` tolerates intervening flags/args (e.g. `tail -n 100
  // /var/log/x`) before the absolute path. Allow `/dev/null`,
  // `/dev/stdin`, `/dev/stdout`, `/dev/stderr` as legitimate device
  // targets.
  {
    name: "read absolute path",
    re: /\b(?:cat|head|tail|less|more|nl|xxd|od|strings|base64)\b[^|;&\n]*\s\/(?!dev\/(?:null|stdin|stdout|stderr)\b)/,
  },
  // `find` walking an absolute path (anywhere under `/`) or the
  // worktree's parent. Auditors can still run `find .`, `find ./sub`,
  // `find -name` (cwd default).
  { name: "find absolute", re: /\bfind\s+\// },
  { name: "find parent", re: /\bfind\s+\.\.(?:$|\/|\s)/ },
  // `ls` on an absolute path. Allow `ls -la /dev/null` style only via
  // the /dev device exception.
  {
    name: "ls absolute path",
    re: /\bls\b[^|;&\n]*\s\/(?!dev\/(?:null|stdin|stdout|stderr)\b)/,
  },
];

/**
 * Composite forbidden-Bash policy for both auditor runners: the
 * reviewer's read-only list (which already extends the implementer's
 * write-blocking list) plus the auditor-only containment patterns.
 */
export const AUDITOR_FORBIDDEN_BASH_PATTERNS: Array<{
  name: string;
  re: RegExp;
}> = [...REVIEWER_FORBIDDEN_BASH_PATTERNS, ...AUDITOR_CONTAINMENT_PATTERNS];
import type {
  PhaseAuditorRunner,
  PhaseAuditorRunnerInput,
  PhaseAuditorRunnerResult,
} from "./phase-auditor-runner.js";

/**
 * Config for {@link createClaudePhaseAuditorRunner}. The API key
 * defaults to `process.env.ANTHROPIC_API_KEY`. The constructor throws
 * if no key is available so callers see a clean failure up-front.
 */
export interface ClaudePhaseAuditorRunnerConfig {
  apiKey?: string;
}

/**
 * Thrown when the Claude-backed phase auditor returns a payload that
 * does not conform to `PhaseAuditReportSchema`. Fatal / non-retryable —
 * the activity layer translates this to
 * `ApplicationFailure.nonRetryable` so Temporal never retries a
 * malformed model output.
 */
export class PhaseAuditValidationError extends Error {
  constructor(
    message: string,
    public readonly rawPayload: unknown,
  ) {
    super(message);
    this.name = "PhaseAuditValidationError";
  }
}

/**
 * Build a `PhaseAuditorRunner` backed by the real
 * `@anthropic-ai/claude-agent-sdk`. Mirrors `createClaudeReviewerRunner`
 * — same read-only tool set, same host-id rewriting discipline, same
 * fatal-validation-error translation path — but pinned to
 * `PhaseAuditReportSchema` for `outputFormat` and to the phase-scoped
 * evidence bundle for the user turn.
 *
 * The runner:
 * - Uses the system prompt you give it verbatim (loaded in the
 *   phase-audit activity by `@pm-go/planner`).
 * - Restricts the agent to `Read`, `Grep`, `Glob`, `Bash` via
 *   `allowedTools`/`disallowedTools` + a belt-and-braces `canUseTool`
 *   that denies every write-class tool and every mutating Bash verb
 *   (the reviewer's forbidden list, which already extends the
 *   implementer's list with all git write verbs).
 * - Pins `outputFormat` to the `PhaseAuditReport` JSON Schema so the
 *   model emits a structured report which we validate before
 *   returning.
 * - Rewrites every model-emitted primary key / foreign key
 *   (`report.id`, `auditorRunId`, `planId`, `phaseId`, `mergeRunId`,
 *   `mergedHeadSha`) with host-generated values before persistence —
 *   the P1 lesson from the Phase 4 reviewer hardening carried forward
 *   to phase audits.
 * - Refuses to invoke the SDK if the caller hands in a
 *   `mergeRun.integrationHeadSha === undefined`. Auditing an in-flight
 *   merge is a workflow bug, not something the model can recover from.
 * - Synthesizes an `AgentRun` with `role='auditor'`, `depth=2`,
 *   `taskId: undefined` (phase audits are not task-scoped) and the
 *   accumulated token / cost / turn counters.
 *
 * The runner is not unit-tested against the live API — CI has no API
 * key. The end-of-phase smoke exercises it with
 * `PHASE_AUDITOR_EXECUTOR_MODE=live`.
 */
export function createClaudePhaseAuditorRunner(
  config: ClaudePhaseAuditorRunnerConfig = {},
): PhaseAuditorRunner {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "createClaudePhaseAuditorRunner: ANTHROPIC_API_KEY not set",
    );
  }

  return {
    async run(
      input: PhaseAuditorRunnerInput,
    ): Promise<PhaseAuditorRunnerResult> {
      if (!input.mergeRun.integrationHeadSha) {
        // Defensive: the workflow layer should never hand us an
        // in-flight merge, but we fail loud if it happens so the
        // auditor budget isn't wasted on a logically-unauditable
        // input.
        throw new PhaseAuditValidationError(
          "createClaudePhaseAuditorRunner: mergeRun.integrationHeadSha is not set — refusing to audit an in-flight merge",
          input.mergeRun,
        );
      }

      const userPrompt = buildUserPrompt(input);
      const cwd = input.worktreePath;

      // Dynamic-module indirection matches the reviewer / planner
      // pattern. Keeps vitest from eagerly resolving the contracts
      // package entry when only stub-runner tests are loaded.
      const contractsModule: string = "@pm-go/contracts";
      const { PhaseAuditReportJsonSchema, validatePhaseAuditReport } =
        (await import(contractsModule)) as {
          PhaseAuditReportJsonSchema: Record<string, unknown>;
          validatePhaseAuditReport: (v: unknown) => boolean;
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
              schema: PhaseAuditReportJsonSchema,
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
        throw err;
      }

      if (reportPayload === undefined || reportPayload === null) {
        throw new PhaseAuditValidationError(
          "createClaudePhaseAuditorRunner: SDK returned no structured_output PhaseAuditReport",
          reportPayload,
        );
      }
      if (!validatePhaseAuditReport(reportPayload)) {
        throw new PhaseAuditValidationError(
          "createClaudePhaseAuditorRunner: structured_output failed PhaseAuditReport schema validation",
          reportPayload,
        );
      }

      // Never trust model-emitted primary keys or foreign keys. The
      // schema-validated payload carries `id`, `auditorRunId`, `planId`,
      // `phaseId`, `mergeRunId`, `mergedHeadSha`, but those came from
      // the model — a hallucinated duplicate UUID would overwrite an
      // existing agent_runs row or silently no-op the audit insert
      // while the workflow proceeds with drifted state. Rewrite them
      // all with host-known values before anything downstream sees the
      // report.
      const validatedPayload = reportPayload as PhaseAuditReport;
      const auditorRunId = randomUUID();
      const report: PhaseAuditReport = {
        ...validatedPayload,
        id: randomUUID(),
        phaseId: input.phase.id,
        planId: input.plan.id,
        mergeRunId: input.mergeRun.id,
        auditorRunId,
        mergedHeadSha: input.mergeRun.integrationHeadSha,
      };
      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: auditorRunId,
        workflowRunId: input.workflowRunId ?? sessionId ?? randomUUID(),
        role: "auditor",
        depth: 2,
        status: "completed",
        // Phase audits carry a conservative risk level — the audit is
        // high-stakes regardless of any single task's individual risk,
        // but `medium` keeps the default retry policy sane (high-risk
        // classification triggers human-approval gates in Phase 7+).
        riskLevel: "medium",
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
        outputFormatSchemaRef: "PhaseAuditReport@1",
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
      message: `phase auditor is read-only; tool '${tool}' is forbidden`,
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
        message: `Bash command blocked by phase-auditor policy (${forbidden})`,
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

  // Anything else (sub-agents, MCP, web fetch) is denied.
  return {
    behavior: "deny",
    message: `tool '${tool}' is not on the phase-auditor allowlist`,
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

function buildUserPrompt(input: PhaseAuditorRunnerInput): string {
  const { plan, phase, mergeRun, baseSha, evidence } = input;

  const phaseTaskBlocks =
    evidence.tasks.length > 0
      ? evidence.tasks.map((t) => renderTaskBlock(t)).join("\n\n")
      : "- (no tasks)";

  const mergeOrderLine = phase.mergeOrder
    .map((taskId) => `  - ${taskId}`)
    .join("\n");

  const reviewReportBullets = evidence.reviewReports.length > 0
    ? evidence.reviewReports.map(renderStoredReviewReport).join("\n")
    : "- (no review reports)";

  const policyDecisionBullets =
    evidence.policyDecisions.length > 0
      ? evidence.policyDecisions
          .map(
            (d) =>
              `- ${d.id} [${d.subjectType}:${d.subjectId}] ${d.decision} (${d.reason})`,
          )
          .join("\n")
      : "- (no policy decisions)";

  return [
    `# Plan under audit (id ${plan.id})`,
    `Title: ${plan.title}`,
    "",
    `## Phase under audit (id ${phase.id}, index ${phase.index})`,
    `Title: ${phase.title}`,
    `Summary: ${phase.summary}`,
    `Integration branch: ${phase.integrationBranch}`,
    `Base snapshot id: ${phase.baseSnapshotId}`,
    "",
    "## Merge order (expected)",
    mergeOrderLine.length > 0 ? mergeOrderLine : "  - (none)",
    "",
    `## MergeRun under audit (id ${mergeRun.id})`,
    `- integrationBranch: ${mergeRun.integrationBranch}`,
    `- baseSha (from input): ${baseSha}`,
    `- integrationHeadSha: ${mergeRun.integrationHeadSha}`,
    `- mergedTaskIds: ${JSON.stringify(mergeRun.mergedTaskIds)}`,
    `- failedTaskId: ${mergeRun.failedTaskId ?? "(none)"}`,
    `- startedAt: ${mergeRun.startedAt}`,
    `- completedAt: ${mergeRun.completedAt ?? "(in flight — this is a workflow bug)"}`,
    `- audit diff range: \`git diff ${baseSha}..${mergeRun.integrationHeadSha}\``,
    "",
    "## Tasks in scope",
    phaseTaskBlocks,
    "",
    "## Review reports (reviewed commit range in brackets)",
    reviewReportBullets,
    "",
    "## Policy decisions",
    policyDecisionBullets,
    "",
    "## Diff summary",
    "```",
    evidence.diffSummary.length > 0 ? evidence.diffSummary : "(empty)",
    "```",
    "",
    "Emit a structured PhaseAuditReport JSON object per the schema. Do not emit prose outside the JSON.",
  ].join("\n");
}

/**
 * Render every auditable facet of a task: identity, scope, acceptance
 * criteria, and the test commands that are meant to validate it. The
 * auditor's checklist items (`check-phase-acceptance-criteria`,
 * `check-phase-tasks-merged`) depend on this information being in the
 * user turn — rendering only id/status would force the model to guess.
 */
function renderTaskBlock(t: Task): string {
  return [
    `- ${t.id} [${t.status}] ${t.slug}: ${t.title} (risk=${t.riskLevel}, kind=${t.kind})`,
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

function renderStoredReviewReport(r: StoredReviewReport): string {
  const findingCount = r.findings.length;
  return [
    `- ${r.id} taskId=${r.taskId} cycle=${r.cycleNumber} outcome=${r.outcome} findings=${findingCount}`,
    `  reviewed-range: ${r.reviewedBaseSha}..${r.reviewedHeadSha}`,
  ].join("\n");
}
