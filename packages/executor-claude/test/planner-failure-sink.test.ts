import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type { AgentRun, RepoSnapshot, SpecDocument } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  ContentFilterError,
  createClaudePlannerRunner,
} from "../src/index.js";
import type { PlannerRunnerInput } from "../src/planner-runner.js";

// Minimal spec-document and repo-snapshot fixtures — semantically
// irrelevant since the SDK is mocked and the input is never processed.
const specDocument: SpecDocument = {
  id: "11111111-0000-4000-8000-000000000001",
  title: "Test spec",
  source: "manual",
  body: "Test body",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const repoSnapshot: RepoSnapshot = {
  id: "22222222-0000-4000-8000-000000000001",
  repoRoot: "/tmp/pm-go-test-repo",
  defaultBranch: "main",
  headSha: "deadbeef",
  languageHints: ["typescript"],
  frameworkHints: [],
  buildCommands: [],
  testCommands: [],
  ciConfigPaths: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function buildInput(
  overrides: Partial<PlannerRunnerInput> = {},
): PlannerRunnerInput {
  return {
    specDocument,
    repoSnapshot,
    systemPrompt: "test planner system prompt",
    promptVersion: "planner@1",
    model: "claude-sonnet-4-6",
    budgetUsdCap: 2.0,
    maxTurnsCap: 60,
    cwd: path.resolve("/tmp/pm-go-test-repo"),
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

describe("createClaudePlannerRunner — onFailure sink", () => {
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
    const runner = createClaudePlannerRunner({
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
    expect(run.role).toBe("planner");
    expect(run.depth).toBe(0);
    expect(run.stopReason).toBe("error");
    expect(run.errorReason).toContain("content_filter");
    expect(run.model).toBe("claude-sonnet-4-6");
    expect(run.startedAt).toBeDefined();
    expect(run.completedAt).toBeDefined();
  });

  it("still rethrows the original classified error when onFailure itself throws (sink failures must never bury the real error)", async () => {
    mockSdkToThrow({
      status: 400,
      message: "Output blocked by content filtering policy",
    });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = createClaudePlannerRunner({
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
    const runner = createClaudePlannerRunner({
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
        // no messages — SDK returns cleanly, planner then throws a
        // validation error outside the catch block (no structured_output).
        // onFailure must not be called in either case.
      }
      return empty();
    });

    const captured: AgentRun[] = [];
    const runner = createClaudePlannerRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    // The runner throws because no plan was returned, but onFailure
    // is NOT invoked — the error originates outside the try/catch sink.
    await expect(runner.run(buildInput())).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});
