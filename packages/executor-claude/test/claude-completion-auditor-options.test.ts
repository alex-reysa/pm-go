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

import type { MergeRun, Phase, Plan } from "@pm-go/contracts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {
      // no messages
    }
    return empty();
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
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
    // Plan-level base commit — HEAD of plan.repoSnapshotId at plan
    // start. Paired with finalMergeRun.integrationHeadSha this
    // defines the plan-wide diff range.
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

describe("createClaudeCompletionAuditorRunner — SDK query options", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes allowedTools=[Read,Grep,Glob,Bash], disallowedTools=[Write,Edit,NotebookEdit], permissionMode=default, cwd=worktreePath", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    const input = buildInput();
    await expect(runner.run(input)).rejects.toThrow(
      /SDK returned no structured_output CompletionAuditReport|CompletionAuditValidationError/,
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
    expect(opts.maxBudgetUsd).toBe(2.0);
    expect(opts.maxTurns).toBe(60);
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("sets outputFormat to a json_schema with the CompletionAuditReport schema", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
    expect(opts.outputFormat).toBeDefined();
    const outputFormat = opts.outputFormat as {
      type: string;
      schema: Record<string, unknown>;
    };
    expect(outputFormat.type).toBe("json_schema");
    expect(outputFormat.schema).toBeTypeOf("object");
    expect(outputFormat.schema.$id).toBe("CompletionAuditReport");
  });

  it("canUseTool denies all write-class tools outright", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    for (const writeTool of ["Write", "Edit", "NotebookEdit"]) {
      const result = await canUseTool(writeTool, {
        file_path: "/tmp/pm-go-final-integration-wt/packages/x/src/a.ts",
      });
      expect(result.behavior, `expected deny for ${writeTool}`).toBe("deny");
    }
  });

  it("canUseTool denies every git write verb (including add/tag/stash/clean/worktree)", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
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

  it("canUseTool denies the implementer's Bash write/mutate idioms", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
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

  it("canUseTool allows read-only Bash (git diff/status/log/show/rev-parse, tests, FD redirects)", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
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
      "git rev-parse refs/heads/main",
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

  it("canUseTool denies reads outside the integration worktree", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
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

  it("canUseTool denies Bash containment escapes (git -C elsewhere, printenv/env, absolute-path reads, find ..)", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      "git -C /tmp/other status",
      "git -C ../sibling-repo log",
      "printenv",
      "env",
      "cat /etc/passwd",
      "head /var/log/system.log",
      "tail /var/log/auth.log",
      "less /root/.ssh/id_rsa",
      "nl /home/user/secrets.txt",
      "find /etc -name passwd",
      "find / -name .env",
      "find .. -name .env",
      "ls /etc",
      "ls -la /home",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected deny for: ${cmd}`).toBe("deny");
    }
  });

  it("canUseTool denies shell chaining / substitution / interpreters / file-copiers (shared with phase auditor)", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      "git log; cat /tmp/secret",
      "git status && cat /etc/passwd",
      "git log $(cat /etc/passwd)",
      "git log `whoami`",
      "diff <(git log) <(cat /etc/passwd)",
      "grep foo </etc/passwd",
      "python3 -c 'open(\"/etc/passwd\").read()'",
      "node -p 'require(\"fs\").readFileSync(\"/etc/passwd\")'",
      "perl script.pl",
      "sh -c 'cat /etc/passwd'",
      "cp /etc/passwd /tmp/x",
      "dd if=/etc/passwd of=/tmp/x",
      "ln -s /etc/passwd /tmp/x",
      "tar -cf /tmp/x.tar /etc",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected deny for: ${cmd}`).toBe("deny");
    }
  });

  it("constructor does not throw when neither apiKey nor ANTHROPIC_API_KEY is set (OAuth fallthrough)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createClaudeCompletionAuditorRunner()).not.toThrow();
  });

  it("refuses to invoke the SDK if finalMergeRun.integrationHeadSha is unset (in-flight merge)", async () => {
    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    const inFlight: MergeRun = { ...finalMergeRunFixture };
    delete (inFlight as { integrationHeadSha?: string }).integrationHeadSha;
    await expect(
      runner.run(buildInput({ finalMergeRun: inFlight })),
    ).rejects.toThrow(/in-flight merge/);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("createClaudeCompletionAuditorRunner — host-id rewriting", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites model-emitted id/auditorRunId/planId/finalPhaseId/mergeRunId/auditedHeadSha with host-known values", async () => {
    const COLLIDING_ID = "deadbeef-dead-4bee-8aaa-000000000011";
    const WRONG_PLAN_ID = "deadbeef-dead-4bee-8aaa-000000000012";
    const WRONG_PHASE_ID = "deadbeef-dead-4bee-8aaa-000000000013";
    const WRONG_MERGE_RUN_ID = "deadbeef-dead-4bee-8aaa-000000000014";
    const WRONG_AUDITOR_RUN_ID = "deadbeef-dead-4bee-8aaa-000000000015";
    const WRONG_HEAD_SHA = "0000000000000000000000000000000000000000";

    queryMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "result" as const,
          subtype: "success" as const,
          session_id: "sess-1",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          structured_output: {
            id: COLLIDING_ID,
            planId: WRONG_PLAN_ID,
            finalPhaseId: WRONG_PHASE_ID,
            mergeRunId: WRONG_MERGE_RUN_ID,
            auditorRunId: WRONG_AUDITOR_RUN_ID,
            auditedHeadSha: WRONG_HEAD_SHA,
            outcome: "pass",
            checklist: [
              {
                id: "c1",
                title: "t",
                status: "passed",
                evidenceArtifactIds: [],
              },
            ],
            findings: [],
            summary: {
              acceptanceCriteriaPassed: [],
              acceptanceCriteriaMissing: [],
              openFindingIds: [],
              unresolvedPolicyDecisionIds: [],
            },
            createdAt: "2026-04-19T00:00:00.000Z",
          },
        };
      })(),
    );

    const runner = createClaudeCompletionAuditorRunner({ apiKey: "test-key" });
    const input = buildInput();
    const { report, agentRun } = await runner.run(input);

    expect(report.id).not.toBe(COLLIDING_ID);
    expect(report.auditorRunId).not.toBe(WRONG_AUDITOR_RUN_ID);
    expect(agentRun.id).not.toBe(WRONG_AUDITOR_RUN_ID);
    expect(report.planId).toBe(input.plan.id);
    expect(report.finalPhaseId).toBe(input.finalPhase.id);
    expect(report.mergeRunId).toBe(input.finalMergeRun.id);
    expect(report.auditedHeadSha).toBe(input.finalMergeRun.integrationHeadSha);
    expect(report.auditorRunId).toBe(agentRun.id);
    expect(agentRun.role).toBe("auditor");
    expect(agentRun.depth).toBe(2);
    expect(agentRun.riskLevel).toBe("high");
    expect(agentRun.outputFormatSchemaRef).toBe("CompletionAuditReport@1");
  });
});
