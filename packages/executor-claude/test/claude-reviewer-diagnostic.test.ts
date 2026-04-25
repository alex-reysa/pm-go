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

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeReviewerRunner } from "../src/claude-reviewer-runner.js";
import type { ReviewerRunnerInput } from "../src/reviewer-runner.js";
import type { RunnerDiagnosticArtifact } from "../src/diagnostic-artifact.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

const queryMock = query as unknown as Mock;

function buildInput(): ReviewerRunnerInput {
  return {
    task: taskFixture,
    worktreePath: "/tmp/pm-go-reviewer-wt",
    baseSha: "deadbeef",
    headSha: "cafef00d",
    strictness: "standard",
    systemPrompt: "system",
    promptVersion: "reviewer@1",
    model: "claude-sonnet-4-6",
    cycleNumber: 1,
  };
}

/**
 * Mock the SDK iterator to yield a single result message with a bogus
 * `structured_output` payload that fails ReviewReport validation.
 */
function mockSdkWithMalformedPayload(payload: unknown, sessionId: string) {
  queryMock.mockImplementation(() => {
    async function* iter() {
      yield {
        session_id: sessionId,
        type: "system",
      };
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        structured_output: payload,
      };
    }
    return iter();
  });
}

describe("createClaudeReviewerRunner — onSchemaValidationFailure sink (v0.8.2 Task 3.1)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("invokes the diagnostic sink with a sanitized artifact when structured_output fails ReviewReport validation", async () => {
    const malformed = {
      // Missing the required `outcome` field, plus a sensitive key
      // that the sanitizer must redact.
      taskId: taskFixture.id,
      apiKey: "sk-secret-should-be-redacted",
      findings: [],
    };
    mockSdkWithMalformedPayload(malformed, "session-abc");

    const captured: RunnerDiagnosticArtifact[] = [];
    const runner = createClaudeReviewerRunner({
      apiKey: "test-key",
      onSchemaValidationFailure: (a) => {
        captured.push(a);
      },
    });

    await expect(runner.run(buildInput())).rejects.toThrow(
      /structured_output failed ReviewReport schema validation/,
    );
    expect(captured).toHaveLength(1);
    const a = captured[0]!;
    expect(a.role).toBe("reviewer");
    expect(a.schemaRef).toBe("ReviewReport@1");
    expect(a.sessionId).toBe("session-abc");
    expect(a.sdkResultSubtype).toBe("success");
    const payload = a.sanitizedStructuredOutput as Record<string, unknown>;
    expect(payload.apiKey).toBe("<redacted>");
    expect(payload.taskId).toBe(taskFixture.id);
  });

  it("invokes the diagnostic sink when the SDK returns no structured_output at all", async () => {
    queryMock.mockImplementation(() => {
      async function* iter() {
        yield {
          session_id: "session-xyz",
          type: "system",
        };
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          // intentionally omit structured_output
        };
      }
      return iter();
    });

    const captured: RunnerDiagnosticArtifact[] = [];
    const runner = createClaudeReviewerRunner({
      apiKey: "test-key",
      onSchemaValidationFailure: (a) => {
        captured.push(a);
      },
    });

    await expect(runner.run(buildInput())).rejects.toThrow(
      /SDK returned no structured_output/,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.role).toBe("reviewer");
    expect(captured[0]!.sessionId).toBe("session-xyz");
  });

  it("the underlying ValidationError still propagates when the diagnostic sink throws", async () => {
    mockSdkWithMalformedPayload({ taskId: taskFixture.id }, "session-x");
    const runner = createClaudeReviewerRunner({
      apiKey: "test-key",
      onSchemaValidationFailure: () => {
        throw new Error("sink down");
      },
    });
    await expect(runner.run(buildInput())).rejects.toThrow(
      /structured_output failed ReviewReport schema validation/,
    );
  });
});
