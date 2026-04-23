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

import type { AgentRun, Task } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ContentFilterError } from "../src/index.js";
import { createClaudeReviewerRunner } from "../src/claude-reviewer-runner.js";
import type { ReviewerRunnerInput } from "../src/reviewer-runner.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function buildInput(
  overrides: Partial<ReviewerRunnerInput> = {},
): ReviewerRunnerInput {
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

function mockSdkToThrow(err: unknown): void {
  queryMock.mockImplementation(() => {
    async function* failing(): AsyncGenerator<never, void, unknown> {
      throw err;
    }
    return failing();
  });
}

describe("createClaudeReviewerRunner — onFailure sink", () => {
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
    const runner = createClaudeReviewerRunner({
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
    expect(run.role).toBe("auditor");
    expect(run.depth).toBe(2);
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

    const runner = createClaudeReviewerRunner({
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
    const runner = createClaudeReviewerRunner({
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
        // no messages — SDK returns cleanly, reviewer then throws a
        // ReviewValidationError outside the catch block (no report payload).
        // onFailure must not be called.
      }
      return empty();
    });

    const captured: AgentRun[] = [];
    const runner = createClaudeReviewerRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    // Runner throws ReviewValidationError (no report output) but onFailure
    // is NOT invoked — the error originates outside the try/catch sink.
    await expect(runner.run(buildInput())).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});
