import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentRun,
  Plan,
  RepoSnapshot,
  SpecDocument,
  Task,
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

export interface ImplementerRunnerInput {
  task: Task;
  worktreePath: string;
  baseSha: string;
  systemPrompt: string;
  promptVersion: string;
  model: string;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
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
   */
  writeFile?: { relativePath: string; contents: string };
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

      if (options.writeFile) {
        const relPath = options.writeFile.relativePath;
        const absTarget = path.resolve(input.worktreePath, relPath);
        if (!isInsideCwdImpl(absTarget, input.worktreePath)) {
          throw new Error(
            `createStubImplementerRunner: writeFile.relativePath '${relPath}' escapes worktreePath`,
          );
        }
        await mkdir(path.dirname(absTarget), { recursive: true });
        await writeFile(absTarget, options.writeFile.contents, "utf8");

        const commitMessage =
          options.commitMessage ??
          `feat(${input.task.slug}): stub implementer placeholder`;

        await execFileAsync("git", ["add", "--", relPath], {
          cwd: input.worktreePath,
        });
        await execFileAsync("git", ["commit", "-m", commitMessage], {
          cwd: input.worktreePath,
        });
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: input.worktreePath,
        });
        finalCommitSha = stdout.trim();
      }

      const completedAt = new Date().toISOString();

      const agentRun: AgentRun = {
        id: randomUUID(),
        workflowRunId: "stub-workflow-run",
        role: "implementer",
        depth: 1,
        status: "completed",
        riskLevel: "low",
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

export { createClaudeImplementerRunner } from "./implementer-runner.js";
export type { ClaudeImplementerRunnerConfig } from "./implementer-runner.js";
