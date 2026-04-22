import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentRun,
  AgentStopReason,
  ReviewFinding,
  Task,
} from "@pm-go/contracts";

import type {
  AgentRunFailureSink,
  ImplementerReviewFeedback,
  ImplementerRunner,
  ImplementerRunnerInput,
  ImplementerRunnerResult,
} from "./index.js";
import {
  classifyExecutorError,
  errorReasonFromClassified,
  safeInvokeFailureSink,
} from "./errors.js";
import { isInsideCwd } from "./planner-runner.js";

const execFileAsync = promisify(execFile);

/**
 * Write-class tools filtered against `Task.fileScope`. The target path
 * input to these tools lives under the `file_path` / `path` / `notebook_path`
 * key depending on which SDK tool is invoked.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/**
 * Config for {@link createClaudeImplementerRunner}. The API key defaults
 * to `process.env.ANTHROPIC_API_KEY`. The constructor throws eagerly if no
 * key is available so callers get a clean failure up-front rather than a
 * confusing SDK error at first-request time.
 */
export interface ClaudeImplementerRunnerConfig {
  apiKey?: string;
  /**
   * Called with a synthesized `status: "failed"` AgentRun just before
   * the runner re-throws a classified error. Wired at worker boot to
   * `persistAgentRun` so every thrown error leaves a durable row.
   * Exceptions from the sink are swallowed; see `safeInvokeFailureSink`.
   */
  onFailure?: AgentRunFailureSink;
}

/**
 * Build an `ImplementerRunner` backed by the real `@anthropic-ai/claude-agent-sdk`.
 *
 * The runner:
 * - Uses the system prompt given by the caller verbatim (loaded by
 *   `@pm-go/planner`'s `runImplementer`).
 * - Allows the agent to use `Read`, `Grep`, `Glob`, `Write`, `Edit`,
 *   `NotebookEdit`, `Bash` — but gates every call through a `canUseTool`
 *   callback that enforces fileScope, worktree containment, and the
 *   forbidden-bash-shape list.
 * - Does NOT set `outputFormat`: the implementer produces filesystem
 *   state, not JSON.
 * - After the model finishes, tries to capture the git HEAD sha in the
 *   worktree via `git rev-parse HEAD`. Errors (e.g. the worktree is not
 *   a git repo) are swallowed and `finalCommitSha` is left undefined.
 * - Accumulates token, cost, and turn counters from the message stream
 *   and synthesizes an `AgentRun` record for the implementer role.
 */
export function createClaudeImplementerRunner(
  config: ClaudeImplementerRunnerConfig = {},
): ImplementerRunner {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "createClaudeImplementerRunner: ANTHROPIC_API_KEY not set",
    );
  }

  return {
    async run(input: ImplementerRunnerInput): Promise<ImplementerRunnerResult> {
      const userPrompt = buildUserPrompt(input);
      const systemPromptWithFixMode = applyFixModePreamble(
        input.systemPrompt,
        input.reviewFeedback,
      );
      const cwd = input.worktreePath;

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
            systemPrompt: systemPromptWithFixMode,
            model: input.model,
            permissionMode: "default",
            allowedTools: [
              "Read",
              "Grep",
              "Glob",
              "Write",
              "Edit",
              "NotebookEdit",
              "Bash",
            ],
            disallowedTools: [],
            settingSources: [],
            ...(typeof input.budgetUsdCap === "number"
              ? { maxBudgetUsd: input.budgetUsdCap }
              : {}),
            ...(typeof input.maxTurnsCap === "number"
              ? { maxTurns: input.maxTurnsCap }
              : {}),
            cwd,
            canUseTool: async (tool, toolInput) => {
              return gateToolUse(tool, toolInput, cwd, input.task);
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
          role: "implementer",
          depth: 1,
          status: "failed",
          riskLevel: input.task.riskLevel,
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
          taskId: input.task.id,
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
          startedAt,
          completedAt: new Date().toISOString(),
        };
        await safeInvokeFailureSink(config.onFailure, failedRun);
        throw classified;
      }

      const completedAt = new Date().toISOString();
      const finalCommitSha = await tryReadHeadSha(cwd);

      const agentRun: AgentRun = {
        id: randomUUID(),
        workflowRunId: sessionId ?? randomUUID(),
        role: "implementer",
        depth: 1,
        status: "completed",
        riskLevel: input.task.riskLevel,
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        taskId: input.task.id,
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
        startedAt,
        completedAt,
      };

      return finalCommitSha !== undefined
        ? { agentRun, finalCommitSha }
        : { agentRun };
    },
  };
}

/**
 * Prepend a deterministic "Fix mode" preamble to the system prompt when
 * the call is a review-triggered fix cycle. When `reviewFeedback` is
 * undefined, returns the system prompt unchanged — first-time implementer
 * runs see no preamble.
 *
 * The preamble:
 * - Names the triggering report + cycle number + cycle cap.
 * - Enumerates every ReviewFinding with severity, title, filePath:line,
 *   and suggestedFixDirection, so the model sees them verbatim.
 * - Restates the non-negotiable rules (every high/medium finding addressed,
 *   no rewriting unrelated code, re-run testCommands, surface invalid
 *   findings as blockers). The full "Fix mode" H2 in `implementer.v1.md`
 *   covers these in depth; the preamble is the short-form trigger that
 *   points the model at that section in context.
 */
export function applyFixModePreamble(
  systemPrompt: string,
  reviewFeedback: ImplementerReviewFeedback | undefined,
): string {
  if (!reviewFeedback) return systemPrompt;
  const preamble = buildFixModePreamble(reviewFeedback);
  return `${preamble}\n\n---\n\n${systemPrompt}`;
}

function buildFixModePreamble(feedback: ImplementerReviewFeedback): string {
  const findingsBlock = feedback.findings
    .map((f) => renderFindingBullet(f))
    .join("\n");
  return [
    `# Fix mode (cycle ${feedback.cycleNumber} of ${feedback.maxCycles})`,
    ``,
    `You are re-running on an existing implementer branch to address reviewer findings from report ${feedback.reportId}. Read the findings below, apply the fixes inside \`fileScope\`, re-run every \`testCommand\`, and commit via the orchestrator (do NOT run \`git commit\`).`,
    ``,
    `Address every finding with **severity=high** or **severity=medium**. Low-severity findings are advisory — address if cheap, skip otherwise.`,
    `Do NOT rewrite unrelated code. Touch only what the findings require.`,
    `If a finding is invalid or points outside \`fileScope\`, STOP and surface it as a blocker in your final message — do not silently ignore it and do not edit out-of-scope files.`,
    ``,
    `## Reviewer findings`,
    findingsBlock.length > 0 ? findingsBlock : "- (no findings — this should not happen in fix mode)",
  ].join("\n");
}

function renderFindingBullet(f: ReviewFinding): string {
  const loc =
    typeof f.startLine === "number"
      ? `:${f.startLine}${typeof f.endLine === "number" && f.endLine !== f.startLine ? `-${f.endLine}` : ""}`
      : "";
  return `- [${f.severity}] \`${f.id}\` — ${f.title}\n  file: \`${f.filePath}${loc}\`\n  summary: ${f.summary}\n  suggestedFixDirection: ${f.suggestedFixDirection}`;
}

/**
 * Build the user-turn text fed to the Claude Agent SDK. Deterministic and
 * compact — the model reads the task fields once, then relies on the
 * system prompt for behavioral rules.
 */
function buildUserPrompt(input: ImplementerRunnerInput): string {
  const task = input.task;
  const includes = task.fileScope.includes;
  const excludes = task.fileScope.excludes ?? [];
  const acceptanceBullets = task.acceptanceCriteria
    .map(
      (ac) =>
        `- [${ac.required ? "required" : "optional"}] ${ac.id}: ${ac.description}` +
        (ac.verificationCommands.length > 0
          ? `\n  verify: ${ac.verificationCommands.join(" && ")}`
          : ""),
    )
    .join("\n");
  const testCommandsBlock =
    task.testCommands.length > 0
      ? task.testCommands.map((c) => `- \`${c}\``).join("\n")
      : "- (none declared)";
  const budgetLines = [
    `- maxWallClockMinutes: ${task.budget.maxWallClockMinutes}`,
    typeof task.budget.maxModelCostUsd === "number"
      ? `- maxModelCostUsd: ${task.budget.maxModelCostUsd}`
      : undefined,
    typeof task.budget.maxPromptTokens === "number"
      ? `- maxPromptTokens: ${task.budget.maxPromptTokens}`
      : undefined,
  ]
    .filter((x): x is string => typeof x === "string")
    .join("\n");

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
    `includes: ${JSON.stringify(includes)}`,
    `excludes: ${JSON.stringify(excludes)}`,
    "",
    "## Acceptance criteria",
    acceptanceBullets.length > 0 ? acceptanceBullets : "- (none declared)",
    "",
    "## Test commands (run these before declaring done)",
    testCommandsBlock,
    "",
    "## Budget",
    budgetLines,
    "",
    "## Worktree",
    `- cwd: ${input.worktreePath}`,
    `- baseSha: ${input.baseSha}`,
    "",
    "Work inside the cwd above. Do not run `git commit` — the orchestrator commits for you. End with a final message whose first line is a conventional-commit title.",
  ].join("\n");
}

/**
 * Permission gate invoked by the SDK before every tool call. The gate is
 * the belt-and-braces enforcement of the rules documented in the
 * implementer system prompt; agents that try to violate them get a
 * `deny` back and can retry legitimately.
 */
async function gateToolUse(
  tool: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  task: Task,
): Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
> {
  if (tool === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === undefined) {
      return { behavior: "deny", message: "Bash call missing command" };
    }
    const forbidden = findForbiddenBashPattern(command);
    if (forbidden) {
      return {
        behavior: "deny",
        message: `Bash command blocked by implementer policy (${forbidden})`,
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = extractPathFromToolInput(toolInput);
    if (!target) {
      return { behavior: "deny", message: `${tool} call missing target path` };
    }
    const abs = path.resolve(cwd, target);
    if (!isInsideCwd(abs, cwd)) {
      return {
        behavior: "deny",
        message: `${tool} target '${target}' is outside worktree ${cwd}`,
      };
    }
    const relPath = path.relative(cwd, abs);
    // .git/** is always denied, even if an include glob would cover it.
    if (relPath === ".git" || relPath.startsWith(`.git${path.sep}`)) {
      return {
        behavior: "deny",
        message: `${tool} target '${relPath}' is inside .git/ (off-limits)`,
      };
    }
    const relPosix = toPosix(relPath);
    const excludes = task.fileScope.excludes ?? [];
    if (matchesAnyPattern(relPosix, excludes)) {
      return {
        behavior: "deny",
        message: `${tool} target '${relPosix}' matches fileScope.excludes`,
      };
    }
    if (!matchesAnyPattern(relPosix, task.fileScope.includes)) {
      return {
        behavior: "deny",
        message: `${tool} target '${relPosix}' is not inside fileScope.includes`,
      };
    }
    return { behavior: "allow", updatedInput: toolInput };
  }

  if (READ_TOOLS.has(tool)) {
    const target = extractPathFromToolInput(toolInput);
    if (!target) {
      // Some read tools (e.g. Grep with no path) default to cwd; allow.
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
  return { behavior: "deny", message: `tool '${tool}' is not on the implementer allowlist` };
}

export const FORBIDDEN_BASH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "git commit", re: /\bgit\s+commit\b/ },
  { name: "git push", re: /\bgit\s+push\b/ },
  { name: "git merge", re: /\bgit\s+merge\b/ },
  { name: "git reset", re: /\bgit\s+reset\b/ },
  { name: "git checkout", re: /\bgit\s+checkout\b/ },
  { name: "git rebase", re: /\bgit\s+rebase\b/ },
  { name: "git branch", re: /\bgit\s+branch\b/ },
  { name: "rm -rf", re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\b/ },
  { name: "curl", re: /\bcurl\b/ },
  { name: "wget", re: /\bwget\b/ },
  { name: "pnpm add", re: /\bpnpm\s+add\b/ },
  { name: "pnpm install", re: /\bpnpm\s+install\b/ },
  { name: "npm install", re: /\bnpm\s+install\b/ },
  { name: "yarn add", re: /\byarn\s+add\b/ },
  { name: "kill", re: /\bkill\b/ },
  { name: "pkill", re: /\bpkill\b/ },
  // Shell-level file writes that bypass the Write/Edit tool boundary.
  // Writes to `/dev/null` and the other standard device descriptors are
  // allowed; FD redirects (`>&1`, `>&2`, `2>&1`) are allowed. Anything
  // else is a path-level write and must go through Write/Edit so
  // `fileScope.includes`/`excludes` can be enforced.
  {
    name: "redirect to file",
    re: />{1,2}\s*(?!&|\/dev\/(?:null|stdin|stdout|stderr)\b)\S/,
  },
  // `sed -i` edits files in place; `tee` writes to its path args; inline
  // code-exec flags (`-e`/`-c`) in scripting runtimes trivially bypass
  // the allowed-tool set by invoking Node/Python/Perl/Ruby write APIs.
  { name: "sed -i", re: /\bsed\s+[^|;&]*-i\b/ },
  { name: "tee", re: /\btee\b/ },
  { name: "node -e", re: /\bnode\s+-e\b/ },
  { name: "python -c", re: /\bpython3?\s+-c\b/ },
  { name: "perl -e/-i", re: /\bperl\s+-[ei]\b/ },
  { name: "ruby -e", re: /\bruby\s+-e\b/ },
  { name: "awk -i", re: /\bawk\s+-i\b/ },
];

function findForbiddenBashPattern(command: string): string | undefined {
  return findForbiddenBashPatternAgainst(command, FORBIDDEN_BASH_PATTERNS);
}

export function findForbiddenBashPatternAgainst(
  command: string,
  patterns: ReadonlyArray<{ name: string; re: RegExp }>,
): string | undefined {
  for (const { name, re } of patterns) {
    if (re.test(command)) return name;
  }
  return undefined;
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

/**
 * Minimal glob matcher for the `**` any-segments and `*` within-segment
 * semantics used by `Task.fileScope`. Compatible with plain concrete paths
 * (e.g. `packages/foo/src/bar.ts`) and simple globs (`packages/foo/**`,
 * `**\/*.ts`). Does not implement brace expansion, negation, or `?`.
 */
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
  const re = globToRegExp(pattern);
  return re.test(relPath);
}

function globToRegExp(pattern: string): RegExp {
  // Convert the glob to a regex character-by-character. `**` matches any
  // number of path segments (including zero); `*` matches any run of
  // non-`/` characters within a single segment.
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // Handle `**/` (consume the trailing slash) and bare `**`.
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
