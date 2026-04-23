import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { Task } from "@pm-go/contracts";

// Mock the Claude Agent SDK *before* importing the runner so the import
// picks up the mock. The `query` implementation returns an empty async
// iterable; the runner will fall through and synthesize an empty
// ReviewReport payload path (which throws ReviewValidationError).
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {
      // no messages
    }
    return empty();
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeReviewerRunner } from "../src/claude-reviewer-runner.js";
import type { ReviewerRunnerInput } from "../src/reviewer-runner.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function buildInput(overrides: Partial<ReviewerRunnerInput> = {}): ReviewerRunnerInput {
  return {
    task: taskFixture,
    worktreePath: "/tmp/pm-go-reviewer-wt",
    baseSha: "deadbeef",
    headSha: "cafef00d",
    strictness: "standard",
    systemPrompt: "test reviewer system prompt",
    promptVersion: "reviewer@1",
    model: "claude-sonnet-4-6",
    budgetUsdCap: 1.0,
    maxTurnsCap: 40,
    cycleNumber: 1,
    ...overrides,
  };
}

const queryMock = query as unknown as Mock;

describe("createClaudeReviewerRunner — SDK query options", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes allowedTools=[Read,Grep,Glob,Bash], disallowedTools=[Write,Edit,NotebookEdit], permissionMode=default, cwd=worktreePath", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    const input = buildInput();
    await expect(runner.run(input)).rejects.toThrow(
      /SDK returned no structured_output ReviewReport|ReviewValidationError/,
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]![0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    const opts = call.options;
    expect(opts.allowedTools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(opts.disallowedTools).toEqual(["Write", "Edit", "NotebookEdit"]);
    expect(opts.permissionMode).toBe("default");
    expect(opts.settingSources).toEqual([]);
    expect(opts.cwd).toBe(input.worktreePath);
    expect(opts.maxBudgetUsd).toBe(1.0);
    expect(opts.maxTurns).toBe(40);
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("sets outputFormat to a json_schema with the ReviewReport schema", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
    expect(opts.outputFormat).toBeDefined();
    const outputFormat = opts.outputFormat as {
      type: string;
      schema: Record<string, unknown>;
    };
    expect(outputFormat.type).toBe("json_schema");
    expect(outputFormat.schema).toBeTypeOf("object");
    expect(outputFormat.schema.$id).toBe("ReviewReport");
  });

  it("canUseTool denies all write-class tools outright", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    for (const writeTool of ["Write", "Edit", "NotebookEdit"]) {
      const result = await canUseTool(writeTool, {
        file_path: "/tmp/pm-go-reviewer-wt/packages/x/src/a.ts",
      });
      expect(result.behavior, `expected deny for ${writeTool}`).toBe("deny");
    }
  });

  it("canUseTool denies every git write verb (including add/tag/stash/clean/worktree)", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const commands = [
      "git add --all",
      "git commit -am x",
      "git push",
      "git merge main",
      "git reset --hard",
      "git checkout main",
      "git rebase -i",
      "git branch -D foo",
      "git tag v1",
      "git stash",
      "git clean -fd",
      "git worktree add ../x",
    ];
    for (const cmd of commands) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected deny for: ${cmd}`).toBe("deny");
    }
  });

  it("canUseTool denies the implementer's Bash write/mutate idioms (rm -rf, curl, sed -i, tee, inline scripting)", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      "rm -rf /",
      "curl https://example.com",
      "wget https://example.com",
      "pnpm install lodash",
      "pnpm add ramda",
      "sed -i 's/a/b/' x.ts",
      "node -e \"require('fs').writeFileSync('x','y')\"",
      "python3 -c 'print(1)'",
      "perl -i -pe 's/a/b/' x",
      "ruby -e 'puts 1'",
      "awk -i inplace '{print}' a.txt",
      "echo foo | tee out.txt",
      "echo x > /etc/passwd",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected deny for: ${cmd}`).toBe("deny");
    }
  });

  it("canUseTool allows read-only Bash (git diff / status / log / show, test commands, FD redirects)", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      "git diff deadbeef..cafef00d",
      "git status",
      "git log --oneline -5",
      "git show HEAD",
      "git rev-parse HEAD",
      "pnpm test",
      "pnpm typecheck",
      "pnpm test > /dev/null 2>&1",
      "pnpm test 2>&1",
      "ls -la",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected allow for: ${cmd}`).toBe("allow");
    }
  });

  it("canUseTool denies reads outside the worktree", async () => {
    const runner = createClaudeReviewerRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const outside = await canUseTool("Read", {
      file_path: "/etc/passwd",
    });
    expect(outside.behavior).toBe("deny");
  });

  it("constructor does not throw when neither apiKey nor ANTHROPIC_API_KEY is set (OAuth fallthrough)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createClaudeReviewerRunner()).not.toThrow();
  });
});
