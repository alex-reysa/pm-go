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

import type { ReviewFinding, Task } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {}
    return empty();
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  applyFixModePreamble,
  createClaudeImplementerRunner,
} from "../src/implementer-runner.js";
import type { ImplementerRunnerInput } from "../src/index.js";

const taskFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function buildInput(overrides: Partial<ImplementerRunnerInput> = {}): ImplementerRunnerInput {
  return {
    task: taskFixture,
    worktreePath: "/tmp/pm-go-implementer-wt",
    baseSha: "deadbeef",
    systemPrompt: "ORIGINAL SYSTEM PROMPT",
    promptVersion: "implementer@1",
    model: "claude-sonnet-4-6",
    budgetUsdCap: 2.0,
    maxTurnsCap: 60,
    ...overrides,
  };
}

function makeFindings(): ReviewFinding[] {
  return [
    {
      id: "f-missing-null-check",
      severity: "high",
      title: "Missing null check on response.body",
      summary:
        "src/a.ts:42 dereferences response.body without null-checking; prior bug #123.",
      filePath: "src/a.ts",
      startLine: 42,
      endLine: 45,
      confidence: 0.95,
      suggestedFixDirection:
        "Add `if (response.body === null) return;` before the JSON.parse call.",
    },
    {
      id: "f-silent-catch",
      severity: "medium",
      title: "Silent catch swallows errors",
      summary:
        "src/b.ts catch branch logs nothing on error; regressions will be invisible.",
      filePath: "src/b.ts",
      startLine: 77,
      confidence: 0.7,
      suggestedFixDirection: "Log to stderr at minimum; keep the retry logic.",
    },
    {
      id: "f-style-nit",
      severity: "low",
      title: "Unused import",
      summary: "src/c.ts imports lodash but never uses it.",
      filePath: "src/c.ts",
      confidence: 0.9,
      suggestedFixDirection: "Remove the unused import.",
    },
  ];
}

describe("applyFixModePreamble (pure)", () => {
  it("returns the system prompt unchanged when reviewFeedback is undefined", () => {
    const out = applyFixModePreamble("HELLO", undefined);
    expect(out).toBe("HELLO");
  });

  it("prepends a Fix-mode preamble containing cycle info + every finding's id, severity, title, filePath, line, and suggestedFixDirection", () => {
    const findings = makeFindings();
    const out = applyFixModePreamble("ORIGINAL", {
      reportId: "11111111-2222-4333-8444-555555555555",
      cycleNumber: 2,
      maxCycles: 2,
      findings,
    });

    expect(out).toContain("Fix mode (cycle 2 of 2)");
    expect(out).toContain("11111111-2222-4333-8444-555555555555");
    for (const f of findings) {
      expect(out).toContain(f.id);
      expect(out).toContain(f.title);
      expect(out).toContain(f.filePath);
      expect(out).toContain(`[${f.severity}]`);
      expect(out).toContain(f.suggestedFixDirection);
    }
    // Line locator rendered when startLine is set.
    expect(out).toContain("src/a.ts:42-45");
    expect(out).toContain("src/b.ts:77");
    // Original system prompt preserved after the separator.
    expect(out).toContain("---");
    expect(out.endsWith("ORIGINAL")).toBe(true);
  });
});

const queryMock = query as unknown as Mock;

describe("createClaudeImplementerRunner — Fix-mode integration with SDK options", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards the unmodified system prompt when reviewFeedback is undefined", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    await runner.run(buildInput());
    const call = queryMock.mock.calls[0]![0] as {
      options: { systemPrompt: string };
    };
    expect(call.options.systemPrompt).toBe("ORIGINAL SYSTEM PROMPT");
    expect(call.options.systemPrompt).not.toContain("Fix mode");
  });

  it("injects the Fix-mode preamble into the system prompt when reviewFeedback is provided", async () => {
    const runner = createClaudeImplementerRunner({ apiKey: "test-key" });
    const findings = makeFindings();
    await runner.run(
      buildInput({
        reviewFeedback: {
          reportId: "11111111-2222-4333-8444-555555555555",
          cycleNumber: 1,
          maxCycles: 2,
          findings,
        },
      }),
    );
    const call = queryMock.mock.calls[0]![0] as {
      options: { systemPrompt: string };
    };
    const sp = call.options.systemPrompt;
    expect(sp.startsWith("# Fix mode (cycle 1 of 2)")).toBe(true);
    expect(sp).toContain("f-missing-null-check");
    expect(sp).toContain("f-silent-catch");
    expect(sp).toContain("ORIGINAL SYSTEM PROMPT"); // original still there
  });
});
