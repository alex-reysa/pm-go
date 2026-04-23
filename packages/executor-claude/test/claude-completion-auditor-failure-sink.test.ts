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

import type { AgentRun, MergeRun, Phase, Plan } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ContentFilterError } from "../src/index.js";
import { createClaudeCompletionAuditorRunner } from "../src/claude-completion-auditor-runner.js";
import type { CompletionAuditorRunnerInput } from "../src/completion-auditor-runner.js";

const planFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const mergeRunFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/merge-run.json",
    import.meta.url,
  ),
);

const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));
const finalMergeRunFixture: MergeRun = JSON.parse(
  readFileSync(mergeRunFixturePath, "utf8"),
);
// Final phase for the completion audit is the last entry in the plan.
const finalPhaseFixture: Phase =
  planFixture.phases[planFixture.phases.length - 1]!;

function buildInput(
  overrides: Partial<CompletionAuditorRunnerInput> = {},
): CompletionAuditorRunnerInput {
  return {
    plan: planFixture,
    finalPhase: finalPhaseFixture,
    finalMergeRun: finalMergeRunFixture,
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evidence: {
      phases: planFixture.phases,
      phaseAuditReports: [],
      mergeRuns: [finalMergeRunFixture],
      reviewReports: [],
      policyDecisions: [],
      diffSummary: "",
    },
    systemPrompt: "test completion auditor system prompt",
    promptVersion: "completion-auditor@1",
    model: "claude-sonnet-4-6",
    worktreePath: "/tmp/pm-go-final-integration-wt",
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

describe("createClaudeCompletionAuditorRunner — onFailure sink", () => {
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
    const runner = createClaudeCompletionAuditorRunner({
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
    expect(run.startedAt).toBeDefined();
    expect(run.completedAt).toBeDefined();
  });

  it("still rethrows the original classified error when onFailure itself throws (sink failures must never bury the real error)", async () => {
    mockSdkToThrow({
      status: 400,
      message: "Output blocked by content filtering policy",
    });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = createClaudeCompletionAuditorRunner({
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
    const runner = createClaudeCompletionAuditorRunner({
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
        // no messages — SDK returns cleanly, completion auditor then throws a
        // CompletionAuditValidationError outside the catch block (no report
        // payload). onFailure must not be called.
      }
      return empty();
    });

    const captured: AgentRun[] = [];
    const runner = createClaudeCompletionAuditorRunner({
      apiKey: "test-key",
      onFailure: (run) => {
        captured.push(run);
      },
    });

    // Runner throws CompletionAuditValidationError (no report output) but
    // onFailure is NOT invoked — the error originates outside the try/catch sink.
    await expect(runner.run(buildInput())).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});
