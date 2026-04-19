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

// Mock the Claude Agent SDK *before* importing the runner so the import
// picks up the mock. The default `query` implementation returns an
// empty async iterable; the runner falls through and throws
// `PhaseAuditValidationError`, letting the tests inspect the options
// passed to `query`.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {
      // no messages
    }
    return empty();
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createClaudePhaseAuditorRunner } from "../src/claude-phase-auditor-runner.js";
import type { PhaseAuditorRunnerInput } from "../src/phase-auditor-runner.js";

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
const mergeRunFixture: MergeRun = JSON.parse(
  readFileSync(mergeRunFixturePath, "utf8"),
);
const phaseFixture: Phase = planFixture.phases[0]!;

function buildInput(
  overrides: Partial<PhaseAuditorRunnerInput> = {},
): PhaseAuditorRunnerInput {
  return {
    plan: planFixture,
    phase: phaseFixture,
    mergeRun: mergeRunFixture,
    // The base commit the phase forked from — paired with
    // mergeRun.integrationHeadSha this defines the audit's diff range.
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evidence: {
      tasks: [],
      reviewReports: [],
      policyDecisions: [],
      diffSummary: "",
    },
    systemPrompt: "test phase auditor system prompt",
    promptVersion: "phase-auditor@1",
    model: "claude-sonnet-4-6",
    worktreePath: "/tmp/pm-go-integration-wt",
    budgetUsdCap: 1.0,
    maxTurnsCap: 40,
    ...overrides,
  };
}

const queryMock = query as unknown as Mock;

describe("createClaudePhaseAuditorRunner — SDK query options", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes allowedTools=[Read,Grep,Glob,Bash], disallowedTools=[Write,Edit,NotebookEdit], permissionMode=default, cwd=worktreePath", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    const input = buildInput();
    await expect(runner.run(input)).rejects.toThrow(
      /SDK returned no structured_output PhaseAuditReport|PhaseAuditValidationError/,
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

  it("sets outputFormat to a json_schema with the PhaseAuditReport schema", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
    expect(opts.outputFormat).toBeDefined();
    const outputFormat = opts.outputFormat as {
      type: string;
      schema: Record<string, unknown>;
    };
    expect(outputFormat.type).toBe("json_schema");
    expect(outputFormat.schema).toBeTypeOf("object");
    expect(outputFormat.schema.$id).toBe("PhaseAuditReport");
  });

  it("canUseTool denies all write-class tools outright", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    for (const writeTool of ["Write", "Edit", "NotebookEdit"]) {
      const result = await canUseTool(writeTool, {
        file_path: "/tmp/pm-go-integration-wt/packages/x/src/a.ts",
      });
      expect(result.behavior, `expected deny for ${writeTool}`).toBe("deny");
    }
  });

  it("canUseTool denies every git write verb (including add/tag/stash/clean/worktree)", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
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
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
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
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
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

  it("canUseTool denies reads outside the integration worktree", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
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
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      // git -C to any path — lets the agent jump to another repo.
      "git -C /tmp/other status",
      "git -C ../sibling-repo log",
      // Environment dumps.
      "printenv",
      "env",
      "env | grep KEY",
      // Absolute-path file reads.
      "cat /etc/passwd",
      "head /var/log/system.log",
      "tail -n 100 /var/log/auth.log",
      "less /root/.ssh/id_rsa",
      "more /etc/shadow",
      "nl /home/user/secrets.txt",
      "xxd /etc/passwd",
      "od -c /etc/passwd",
      "strings /usr/bin/true",
      "base64 /etc/passwd",
      // `find` walking outside cwd.
      "find /etc -name passwd",
      "find / -name .env",
      "find .. -name .env",
      "find ../../.. -type f",
      // `ls` on sensitive roots.
      "ls /etc",
      "ls -la /home",
      "ls /root",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected deny for: ${cmd}`).toBe("deny");
    }
  });

  it("canUseTool still allows legitimate read-only Bash that touches relative paths or /dev/*", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    await expect(runner.run(buildInput())).rejects.toThrow();
    const canUseTool = queryMock.mock.calls[0]![0].options.canUseTool as (
      tool: string,
      toolInput: unknown,
    ) => Promise<{ behavior: string; message?: string }>;

    const cases: string[] = [
      "find . -name '*.ts'",
      "find ./packages -type f",
      "cat package.json",
      "head -n 20 README.md",
      "ls packages/contracts/src",
      "pnpm test > /dev/null 2>&1",
    ];
    for (const cmd of cases) {
      const r = await canUseTool("Bash", { command: cmd });
      expect(r.behavior, `expected allow for: ${cmd}`).toBe("allow");
    }
  });

  it("constructor throws when neither apiKey nor ANTHROPIC_API_KEY is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => createClaudePhaseAuditorRunner()).toThrow(
      /ANTHROPIC_API_KEY not set/,
    );
  });

  it("refuses to invoke the SDK if mergeRun.integrationHeadSha is unset (in-flight merge)", async () => {
    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    const inFlightMerge: MergeRun = { ...mergeRunFixture };
    delete (inFlightMerge as { integrationHeadSha?: string }).integrationHeadSha;

    await expect(
      runner.run(buildInput({ mergeRun: inFlightMerge })),
    ).rejects.toThrow(/in-flight merge/);
    // SDK must not have been called.
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("createClaudePhaseAuditorRunner — host-id rewriting", () => {
  beforeEach(() => {
    queryMock.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-from-env");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rewrites model-emitted id/auditorRunId/phaseId/planId/mergeRunId/mergedHeadSha with host-known values", async () => {
    // Model emits a well-known stub payload whose id fields collide
    // with something an attacker (or a buggy model) could use to
    // overwrite an existing row. The runner must discard those and
    // return host-stamped values.
    const COLLIDING_ID = "deadbeef-dead-4bee-8aaa-000000000001";
    const WRONG_PLAN_ID = "deadbeef-dead-4bee-8aaa-000000000002";
    const WRONG_PHASE_ID = "deadbeef-dead-4bee-8aaa-000000000003";
    const WRONG_MERGE_RUN_ID = "deadbeef-dead-4bee-8aaa-000000000004";
    const WRONG_AUDITOR_RUN_ID = "deadbeef-dead-4bee-8aaa-000000000005";
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
            phaseId: WRONG_PHASE_ID,
            planId: WRONG_PLAN_ID,
            mergeRunId: WRONG_MERGE_RUN_ID,
            auditorRunId: WRONG_AUDITOR_RUN_ID,
            mergedHeadSha: WRONG_HEAD_SHA,
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
            summary: "ok",
            createdAt: "2026-04-19T00:00:00.000Z",
          },
        };
      })(),
    );

    const runner = createClaudePhaseAuditorRunner({ apiKey: "test-key" });
    const input = buildInput();
    const { report, agentRun } = await runner.run(input);

    // Host-generated ids — MUST NOT equal the model's emitted values.
    expect(report.id).not.toBe(COLLIDING_ID);
    expect(report.auditorRunId).not.toBe(WRONG_AUDITOR_RUN_ID);
    expect(agentRun.id).not.toBe(WRONG_AUDITOR_RUN_ID);
    // Foreign keys pinned to the host-known input values.
    expect(report.planId).toBe(input.plan.id);
    expect(report.phaseId).toBe(input.phase.id);
    expect(report.mergeRunId).toBe(input.mergeRun.id);
    expect(report.mergedHeadSha).toBe(input.mergeRun.integrationHeadSha);
    // report.auditorRunId === agentRun.id — both host-stamped to the
    // same UUID.
    expect(report.auditorRunId).toBe(agentRun.id);
    expect(agentRun.role).toBe("auditor");
    expect(agentRun.depth).toBe(2);
    expect(agentRun.taskId).toBeUndefined();
    expect(agentRun.outputFormatSchemaRef).toBe("PhaseAuditReport@1");
  });
});
