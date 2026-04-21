import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentRun,
  Plan,
  RepoSnapshot,
  ReviewFinding,
  SpecDocument,
  Task,
  UUID,
} from "@pm-go/contracts";

import { isInsideCwd as isInsideCwdImpl } from "./planner-runner.js";

const execFileAsync = promisify(execFile);

export interface PlannerRunnerInput {
  specDocument: SpecDocument;
  repoSnapshot: RepoSnapshot;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  cwd: string;
}

export interface PlannerRunnerResult {
  plan: Plan;
  agentRun: AgentRun;
}

export interface PlannerRunner {
  run(input: PlannerRunnerInput): Promise<PlannerRunnerResult>;
}

/**
 * createStubPlannerRunner returns a PlannerRunner that ignores the real
 * Claude Agent SDK and always yields the provided fixture Plan plus a
 * synthesized AgentRun with role='planner', status='completed'. This is the
 * default executor for Phase 2 foundation-lane smoke flows so downstream
 * lanes can be built without an Anthropic API key.
 */
export function createStubPlannerRunner(fixture: Plan): PlannerRunner {
  return {
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      const now = new Date().toISOString();
      const agentRun: AgentRun = {
        id: randomUUID(),
        workflowRunId: "stub-workflow-run",
        role: "planner",
        depth: 0,
        status: "completed",
        riskLevel: "low",
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        sessionId: "stub-session",
        permissionMode: "default",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: "completed",
        startedAt: now,
        completedAt: now,
      };
      return { plan: fixture, agentRun };
    },
  };
}

export { createClaudePlannerRunner, isInsideCwd } from "./planner-runner.js";

/**
 * Fix-mode context. When present on `ImplementerRunnerInput.reviewFeedback`
 * the runner prepends a deterministic "Fix mode" preamble to the system
 * prompt so the implementer sees the reviewer's findings verbatim. Used by
 * `TaskFixWorkflow` in Phase 4; absent during the first implementer run.
 */
export interface ImplementerReviewFeedback {
  reportId: UUID;
  /** 1-indexed: this is the Nth fix pass. Matches `review_reports.cycle_number`. */
  cycleNumber: number;
  /** Max cycles allowed for this task (from `task.maxReviewFixCycles`). */
  maxCycles: number;
  findings: ReviewFinding[];
}

export interface ImplementerRunnerInput {
  task: Task;
  worktreePath: string;
  baseSha: string;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  /** Populated only on fix cycles (TaskFixWorkflow). Undefined on the first implementer run. */
  reviewFeedback?: ImplementerReviewFeedback;
}

export interface ImplementerRunnerResult {
  agentRun: AgentRun;
  /** Set when the implementer produced at least one commit on the task branch. */
  finalCommitSha?: string;
}

export interface ImplementerRunner {
  run(input: ImplementerRunnerInput): Promise<ImplementerRunnerResult>;
}

/**
 * Options for the Phase 3 stub implementer runner. The real
 * Claude-backed runner lands in the Implementer + Prompt lane.
 */
export interface CreateStubImplementerRunnerOptions {
  /**
   * Relative path inside the leased worktree to create and commit. The
   * path must not escape `worktreePath` (checked via `isInsideCwd`).
   * Used when every task should write to the same path (phase-3/4 smoke).
   */
  writeFile?: { relativePath: string; contents: string };
  /**
   * Per-slug path map. Phase 5 runs multiple tasks with disjoint
   * fileScopes inside a single worker boot; a global path would flag
   * any task whose fileScope doesn't include that path as
   * out-of-scope. When a task's slug is a key in `bySlug`, that path
   * wins; otherwise the resolver falls back to `writeFile`.
   */
  writeFileBySlug?: { bySlug: Record<string, string>; contents: string };
  /** Commit message override; defaults to `feat(<slug>): stub implementer placeholder`. */
  commitMessage?: string;
}

/**
 * Stub implementer runner. When `options.writeFile` is provided the stub
 * creates the file inside the leased worktree and commits it so downstream
 * diff-scope checks have something to verify. Without the option it is a
 * no-op success: synthesize the AgentRun only, return `finalCommitSha =
 * undefined`. Used by the Phase 3 foundation smoke flow so later lanes can
 * exercise the worktree plumbing without an Anthropic API key.
 */
export function createStubImplementerRunner(
  options: CreateStubImplementerRunnerOptions = {},
): ImplementerRunner {
  return {
    async run(input: ImplementerRunnerInput): Promise<ImplementerRunnerResult> {
      const startedAt = new Date().toISOString();
      let finalCommitSha: string | undefined;

      // Resolve the write path per-call so a single worker boot can serve
      // multiple tasks with disjoint fileScopes. Per-slug map wins over
      // the global path; either absence is a no-op (the legacy behavior).
      const resolved = resolveStubWriteFile(options, input.task.slug);
      if (resolved) {
        const relPath = resolved.relativePath;
        const absTarget = path.resolve(input.worktreePath, relPath);
        if (!isInsideCwdImpl(absTarget, input.worktreePath)) {
          throw new Error(
            `createStubImplementerRunner: write path '${relPath}' escapes worktreePath`,
          );
        }
        await mkdir(path.dirname(absTarget), { recursive: true });
        // On fix cycles the same stub may be called again with identical
        // contents. Append a cycle marker when reviewFeedback is present
        // so the second commit has a real diff — otherwise `git commit`
        // fails with "nothing to commit".
        const baseContents = resolved.contents;
        const contents = input.reviewFeedback
          ? `${baseContents}\n// fix cycle ${input.reviewFeedback.cycleNumber} — report ${input.reviewFeedback.reportId}\n`
          : baseContents;
        await writeFile(absTarget, contents, "utf8");

        const commitMessage =
          options.commitMessage ??
          (input.reviewFeedback
            ? `fix(${input.task.slug}): stub fix cycle ${input.reviewFeedback.cycleNumber}`
            : `feat(${input.task.slug}): stub implementer placeholder`);

        await execFileAsync("git", ["add", "--", relPath], {
          cwd: input.worktreePath,
        });
        try {
          // Force `LANG=C`/`LC_ALL=C` so the "nothing to commit" stdout
          // we parse on the recovery path is English regardless of the
          // developer's locale — otherwise a localized git message
          // bypasses the regex below and the fix cycle crashes on what
          // is really a no-op commit.
          await execFileAsync("git", ["commit", "-m", commitMessage], {
            cwd: input.worktreePath,
            env: { ...process.env, LANG: "C", LC_ALL: "C" },
          });
        } catch (err) {
          // Tolerate "nothing to commit, working tree clean" so retries
          // (Temporal, fix cycles) don't explode. All other commit errors
          // propagate unchanged.
          const message = extractCommitErrorMessage(err);
          if (!/nothing to commit|working tree clean/i.test(message)) {
            throw err;
          }
        }
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: input.worktreePath,
        });
        finalCommitSha = stdout.trim();
      }

      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: randomUUID(),
        taskId: input.task.id,
        workflowRunId: "stub-workflow-run",
        role: "implementer",
        depth: 1,
        status: "completed",
        riskLevel: input.task.riskLevel,
        executor: "claude",
        model: input.model,
        promptVersion: input.promptVersion,
        sessionId: `stub-implementer-${randomUUID()}`,
        permissionMode: "default",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: "completed",
        startedAt,
        completedAt,
      };

      return finalCommitSha !== undefined
        ? { agentRun, finalCommitSha }
        : { agentRun };
    },
  };
}

function extractCommitErrorMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const obj = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const parts: string[] = [];
  for (const v of [obj.stdout, obj.stderr, obj.message]) {
    if (typeof v === "string") parts.push(v);
  }
  return parts.join("\n");
}

/**
 * Pick the write path for a given task slug. Per-slug map beats the
 * global path so Phase 5 can run multiple tasks with disjoint
 * fileScopes inside a single worker boot. Returns `undefined` when no
 * write configured — the runner becomes a pure no-op.
 */
function resolveStubWriteFile(
  options: CreateStubImplementerRunnerOptions,
  slug: string,
): { relativePath: string; contents: string } | undefined {
  if (options.writeFileBySlug) {
    const bySlug = options.writeFileBySlug.bySlug[slug];
    if (bySlug !== undefined) {
      return { relativePath: bySlug, contents: options.writeFileBySlug.contents };
    }
  }
  if (options.writeFile) {
    return options.writeFile;
  }
  return undefined;
}

export { createClaudeImplementerRunner } from "./implementer-runner.js";
export type { ClaudeImplementerRunnerConfig } from "./implementer-runner.js";

export {
  createStubReviewerRunner,
  createClaudeReviewerRunner,
  type CreateStubReviewerRunnerOptions,
  type ReviewerRunner,
  type ReviewerRunnerInput,
  type ReviewerRunnerResult,
  type StubReviewerSequenceEntry,
  type ClaudeReviewerRunnerConfig,
} from "./reviewer-runner.js";

export {
  createStubPhaseAuditorRunner,
  createClaudePhaseAuditorRunner,
  PhaseAuditValidationError,
  type CreateStubPhaseAuditorRunnerOptions,
  type PhaseAuditEvidence,
  type PhaseAuditorRunner,
  type PhaseAuditorRunnerInput,
  type PhaseAuditorRunnerResult,
  type StubPhaseAuditorSequenceEntry,
  type ClaudePhaseAuditorRunnerConfig,
} from "./phase-auditor-runner.js";

export {
  createStubCompletionAuditorRunner,
  createClaudeCompletionAuditorRunner,
  CompletionAuditValidationError,
  type CreateStubCompletionAuditorRunnerOptions,
  type CompletionAuditEvidence,
  type CompletionAuditorRunner,
  type CompletionAuditorRunnerInput,
  type CompletionAuditorRunnerResult,
  type StubCompletionAuditorSequenceEntry,
  type ClaudeCompletionAuditorRunnerConfig,
} from "./completion-auditor-runner.js";

// Phase 7 W3 — stub failure-mode wrappers. Activated exclusively by env
// var; transparent pass-through when unset. See
// docs/phases/phase7-harness.md for the invocation contract.
export {
  wrapImplementerRunnerWithFailureMode,
  resolveImplementerStubFailureMode,
  tryMergeBranchOntoMain,
  type ImplementerStubFailureMode,
  type ImplementerStubFailureOptions,
} from "./implementer-stub-failures.js";

export {
  wrapReviewerRunnerWithFailureMode,
  resolveReviewerStubFailureMode,
  type ReviewerStubFailureMode,
  type ReviewerStubFailureOptions,
} from "./reviewer-stub-failures.js";
