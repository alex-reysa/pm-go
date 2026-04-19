import { readFileSync } from "node:fs";
import path from "node:path";
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
// iterable; the runner's message-consumption loop will simply fall
// through and synthesize an empty AgentRun.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {
      // no messages
    }
    return empty();
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  createClaudeImplementerRunner,
  type ImplementerRunnerInput,
} from "../src/index.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function buildInput(overrides: Partial<ImplementerRunnerInput> = {}): ImplementerRunnerInput {
  const worktreePath = path.resolve("/tmp/pm-go-test-worktree");
  return {
    task: taskFixture,
    worktreePath,
    baseSha: "deadbeef",
    systemPrompt: "test system prompt",
    promptVersion: "implementer@1",
    model: "claude-sonnet-4-6",
    budgetUsdCap: 2.0,
    maxTurnsCap: 60,
    ...overrides,
  };
}

const queryMock = query as unknown as Mock;

describe("createClaudeImplementerRunner — SDK query options", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the expected allowedTools/disallowedTools/permissionMode/caps/cwd to the SDK query", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    const input = buildInput();
    await runner.run(input);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]![0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    const opts = call.options;
    expect(opts.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
    ]);
    expect(opts.disallowedTools).toEqual([]);
    expect(opts.permissionMode).toBe("default");
    expect(opts.settingSources).toEqual([]);
    expect(opts.cwd).toBe(input.worktreePath);
    expect(opts.maxBudgetUsd).toBe(2.0);
    expect(opts.maxTurns).toBe(60);
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("does NOT set outputFormat (the implementer produces filesystem state, not JSON)", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    await runner.run(buildInput());
    const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
    expect(opts.outputFormat).toBeUndefined();
    expect("outputFormat" in opts).toBe(false);
  });

  it("canUseTool denies forbidden Bash verbs (git commit, rm -rf) and allows benign ones (pnpm test)", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    await runner.run(buildInput());
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const deniedCommit = await canUseTool("Bash", {
      command: 'git commit -am "x"',
    });
    expect(deniedCommit.behavior).toBe("deny");

    const deniedRm = await canUseTool("Bash", { command: "rm -rf /" });
    expect(deniedRm.behavior).toBe("deny");

    const deniedCurl = await canUseTool("Bash", {
      command: "curl https://example.com",
    });
    expect(deniedCurl.behavior).toBe("deny");

    const deniedInstall = await canUseTool("Bash", {
      command: "pnpm install lodash",
    });
    expect(deniedInstall.behavior).toBe("deny");

    const allowedTest = await canUseTool("Bash", { command: "pnpm test" });
    expect(allowedTest.behavior).toBe("allow");
  });

  it("canUseTool denies Bash write idioms that bypass the Write/Edit tool boundary", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    await runner.run(buildInput());
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: Array<{ command: string; label: string }> = [
      { command: "echo 'x' > /etc/passwd", label: "redirect to /etc" },
      { command: "echo 'x' > /tmp/evil.sh", label: "redirect outside scope" },
      { command: "echo 'x' >> /tmp/evil.sh", label: "append redirect" },
      { command: "sed -i 's/foo/bar/' src/a.ts", label: "sed -i in-place" },
      { command: "node -e \"require('fs').writeFileSync('x','y')\"", label: "node -e" },
      { command: "python -c \"open('x','w').write('y')\"", label: "python -c" },
      { command: "python3 -c 'print(1)'", label: "python3 -c" },
      { command: "perl -i -pe 's/a/b/' x.txt", label: "perl -i" },
      { command: "perl -e 'print 1'", label: "perl -e" },
      { command: "ruby -e 'puts 1'", label: "ruby -e" },
      { command: "awk -i inplace '{print}' a.txt", label: "awk -i" },
      { command: "echo foo | tee out.txt", label: "tee" },
    ];

    for (const { command, label } of cases) {
      const result = await canUseTool("Bash", { command });
      expect(result.behavior, `expected deny for: ${label} (${command})`).toBe(
        "deny",
      );
    }
  });

  it("canUseTool permits Bash redirects to /dev/null and FD redirects", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    await runner.run(buildInput());
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    // /dev/null (and the other standard device descriptors) is a
    // recognised "discard" target and must stay allowed so the implementer
    // can silence test output. FD redirects like `2>&1` are not file
    // writes and must also stay allowed.
    const devNull = await canUseTool("Bash", {
      command: "pnpm test > /dev/null 2>&1",
    });
    expect(devNull.behavior).toBe("allow");

    const fdRedirect = await canUseTool("Bash", {
      command: "pnpm test 2>&1",
    });
    expect(fdRedirect.behavior).toBe("allow");
  });

  it("canUseTool denies Write into .git/ inside the worktree", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    const input = buildInput();
    await runner.run(input);
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const result = await canUseTool("Write", {
      file_path: path.join(input.worktreePath, ".git/config"),
    });
    expect(result.behavior).toBe("deny");
  });

  it("canUseTool allows Write to a path inside fileScope.includes and denies paths outside the worktree", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    const input = buildInput();
    await runner.run(input);
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    // First include in the fixture is a concrete relative path.
    const firstInclude = taskFixture.fileScope.includes[0]!;
    const allowed = await canUseTool("Write", {
      file_path: path.join(input.worktreePath, firstInclude),
    });
    expect(allowed.behavior).toBe("allow");

    const deniedOutside = await canUseTool("Write", {
      file_path: "/etc/passwd",
    });
    expect(deniedOutside.behavior).toBe("deny");
  });

  it("constructor throws when neither apiKey nor ANTHROPIC_API_KEY is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createClaudeImplementerRunner()).toThrow(
      /ANTHROPIC_API_KEY not set/,
    );
  });
});
