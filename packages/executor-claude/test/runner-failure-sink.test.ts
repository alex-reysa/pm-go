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

import type { AgentRun, Task } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  ContentFilterError,
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

function buildInput(
  overrides: Partial<ImplementerRunnerInput> = {},
): ImplementerRunnerInput {
  return {
    task: taskFixture,
    worktreePath: path.resolve("/tmp/pm-go-test-worktree"),
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

function mockSdkToThrow(err: unknown): void {
  queryMock.mockImplementation(() => {
    async function* failing(): AsyncGenerator<never, void, unknown> {
      throw err;
    }
    return failing();
  });
}

describe("createClaudeImplementerRunner — onFailure sink", () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls onFailure with a status='failed' AgentRun carrying errorReason, then rethrows ContentFilterError", async () => {
    mockSdkToThrow({
      status: 400,
      message: "Output blocked by content filtering policy",
    });

    const captured: AgentRun[] = [];
    const runner = createClaudeImplementerRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    await expect(runner.run(buildInput())).rejects.toBeInstanceOf(
      ContentFilterError,
    );

    expect(captured).toHaveLength(1);
    const run = captured[0]!;
    expect(run.status).toBe("failed");
    expect(run.role).toBe("implementer");
    expect(run.depth).toBe(1);
    expect(run.stopReason).toBe("error");
    expect(run.errorReason).toContain("content_filter");
    expect(run.model).toBe("claude-sonnet-4-6");
    expect(run.taskId).toBe(taskFixture.id);
    expect(run.startedAt).toBeDefined();
    expect(run.completedAt).toBeDefined();
  });

  it("still rethrows the original classified error when onFailure itself throws (sink failures must never bury the real error)", async () => {
    mockSdkToThrow({
      status: 400,
      message: "Output blocked by content filtering policy",
    });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = createClaudeImplementerRunner({
      apiKey: "test-key",
      onFailure: async () => {
        throw new Error("sink exploded");
      },
    });

    await expect(runner.run(buildInput())).rejects.toBeInstanceOf(
      ContentFilterError,
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    consoleWarnSpy.mockRestore();
  });

  it("passes through non-content-filter errors to onFailure with their raw message as errorReason", async () => {
    const raw = new Error("ECONNRESET: connection reset by peer");
    mockSdkToThrow(raw);

    const captured: AgentRun[] = [];
    const runner = createClaudeImplementerRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    await expect(runner.run(buildInput())).rejects.toBe(raw);

    expect(captured).toHaveLength(1);
    const run = captured[0]!;
    expect(run.status).toBe("failed");
    expect(run.errorReason).toBe("ECONNRESET: connection reset by peer");
  });

  it("does not invoke onFailure on the success path", async () => {
    queryMock.mockImplementation(() => {
      async function* empty(): AsyncGenerator<never, void, unknown> {
        // no messages = successful no-op
      }
      return empty();
    });

    const captured: AgentRun[] = [];
    const runner = createClaudeImplementerRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    await runner.run(buildInput());
    expect(captured).toHaveLength(0);
  });
});
