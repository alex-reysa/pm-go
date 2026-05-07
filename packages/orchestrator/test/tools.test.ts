import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryAgentRunPersistence } from "../src/persistence.js";
import { createPmGoSdkTools } from "../src/tools.js";
import type { OperatorAgentOptions } from "../src/types.js";

const AGENT_RUN_ID = "11111111-2222-4333-8444-555555555555";
const PLAN_ID = "22222222-3333-4444-8555-666666666666";
const SPEC_ID = "33333333-4444-4555-8666-777777777777";
const SNAPSHOT_ID = "44444444-5555-4666-8777-888888888888";

type SdkTool = ReturnType<typeof createPmGoSdkTools>[number];

function baseOptions(overrides: Partial<OperatorAgentOptions> = {}): OperatorAgentOptions {
  return {
    repoRoot: "/tmp/repo",
    runtime: "stub",
    approve: "interactive",
    yes: false,
    apiUrl: "http://api.test",
    ...overrides,
  };
}

function findTool(tools: SdkTool[], name: string): SdkTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function decodeResult(result: Awaited<ReturnType<SdkTool["handler"]>>): unknown {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text);
}

describe("pm-go SDK MCP tools", () => {
  it("submits a spec through the API and records a typed tool call", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pm-go-orchestrator-tools-"));
    try {
      const specPath = join(tmp, "feature.md");
      await writeFile(specPath, "# Feature\n\nBody", "utf8");
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: typeof globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            specDocumentId: SPEC_ID,
            repoSnapshotId: SNAPSHOT_ID,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      };
      const persistence = new MemoryAgentRunPersistence();
      const tools = createPmGoSdkTools({
        agentRunId: AGENT_RUN_ID,
        options: baseOptions({ specPath }),
        persistence,
        fetchImpl,
        now: () => new Date("2026-05-07T10:00:00.000Z"),
      });

      const result = await findTool(tools, "pmgo_submit_spec").handler({}, {});

      expect(decodeResult(result)).toEqual({
        specDocumentId: SPEC_ID,
        repoSnapshotId: SNAPSHOT_ID,
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]!.url).toBe("http://api.test/spec-documents");
      expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
        repoRoot: "/tmp/repo",
        title: "Feature",
        body: "# Feature\n\nBody",
        source: "manual",
      });
      expect(persistence.toolCalls).toEqual([
        expect.objectContaining({
          agentRunId: AGENT_RUN_ID,
          sequence: 0,
          toolName: "pmgo_submit_spec",
          status: "completed",
          specDocumentId: SPEC_ID,
          repoSnapshotId: SNAPSHOT_ID,
        }),
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("blocks high-risk approvals unless yes mode is enabled", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          approvals: [
            {
              id: "approval-1",
              status: "pending",
              riskBand: "high",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const persistence = new MemoryAgentRunPersistence();
    const tools = createPmGoSdkTools({
      agentRunId: AGENT_RUN_ID,
      options: baseOptions(),
      persistence,
      fetchImpl,
    });

    const result = await findTool(tools, "pmgo_approve_pending").handler(
      { planId: PLAN_ID },
      {},
    );

    expect(decodeResult(result)).toEqual(
      expect.objectContaining({
        status: "requires_confirmation",
        highRiskCount: 1,
      }),
    );
    expect(fetchCalls.map((call) => call.url)).toEqual([
      `http://api.test/approvals?planId=${PLAN_ID}`,
    ]);
  });

  it("lets injected handlers drive a plan and preserves plan references in logs", async () => {
    const persistence = new MemoryAgentRunPersistence();
    const tools = createPmGoSdkTools({
      agentRunId: AGENT_RUN_ID,
      options: baseOptions({ approve: "all", yes: true }),
      persistence,
      handlers: {
        async drivePlan(input) {
          return {
            status: "released",
            planId: input.planId,
            approve: input.approve,
          };
        },
      },
    });

    const result = await findTool(tools, "pmgo_drive_plan").handler(
      { planId: PLAN_ID },
      {},
    );

    expect(decodeResult(result)).toEqual({
      status: "released",
      planId: PLAN_ID,
      approve: "all",
    });
    expect(persistence.toolCalls.at(-1)).toEqual(
      expect.objectContaining({
        toolName: "pmgo_drive_plan",
        status: "completed",
        planId: PLAN_ID,
      }),
    );
  });

  it("Claim 3 — pmgo_decompose_spec drops planId on the recorded ToolCallRecord while keeping spec/snapshot refs", async () => {
    // POST /plans returns the planId synchronously, but the plan row is
    // inserted asynchronously by the persistPlan activity. Recording
    // planId on the agent_tool_calls row right now would violate the
    // plan_id FK — so the recorded refs must include specDocumentId /
    // repoSnapshotId but NOT planId, even though the response carries one.
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          plan: { id: PLAN_ID, specDocumentId: SPEC_ID, repoSnapshotId: SNAPSHOT_ID },
          planId: PLAN_ID,
          specDocumentId: SPEC_ID,
          repoSnapshotId: SNAPSHOT_ID,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    const persistence = new MemoryAgentRunPersistence();
    const tools = createPmGoSdkTools({
      agentRunId: AGENT_RUN_ID,
      options: baseOptions(),
      persistence,
      fetchImpl,
    });

    await findTool(tools, "pmgo_decompose_spec").handler(
      { specDocumentId: SPEC_ID, repoSnapshotId: SNAPSHOT_ID },
      {},
    );

    const lastCall = persistence.toolCalls.at(-1)!;
    expect(lastCall.toolName).toBe("pmgo_decompose_spec");
    expect(lastCall.status).toBe("completed");
    expect(lastCall.planId).toBeUndefined();
    expect(lastCall.specDocumentId).toBe(SPEC_ID);
    expect(lastCall.repoSnapshotId).toBe(SNAPSHOT_ID);
  });

  it("Claim 2 — pmgo_submit_spec rejects out-of-scope repoRoot with the operator-provided root in the message", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pm-go-orchestrator-tools-"));
    try {
      const specPath = join(tmp, "feature.md");
      await writeFile(specPath, "# Feature\n\nBody", "utf8");
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: typeof globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response("{}", {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      };
      const persistence = new MemoryAgentRunPersistence();
      const tools = createPmGoSdkTools({
        agentRunId: AGENT_RUN_ID,
        options: baseOptions({ repoRoot: tmp, specPath }),
        persistence,
        fetchImpl,
      });

      const result = await findTool(tools, "pmgo_submit_spec").handler(
        { repoRoot: "/etc" },
        {},
      );

      const decoded = decodeResult(result) as Record<string, unknown>;
      expect(decoded.status).toBe("rejected");
      expect(String(decoded.message)).toMatch(/operator-provided repo root/);
      expect(decoded.allowedRepoRoot).toBe(tmp);
      // No HTTP call should have been issued — the guard fires before postJson.
      expect(fetchCalls).toHaveLength(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("Claim 2 — pmgo_submit_spec rejects mismatched specPath", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pm-go-orchestrator-tools-"));
    try {
      const specPath = join(tmp, "feature.md");
      await writeFile(specPath, "# Feature\n\nBody", "utf8");
      const otherSpecPath = join(tmp, "other.md");
      await writeFile(otherSpecPath, "# Other\n\nBody", "utf8");
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: typeof globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response("{}", {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      };
      const persistence = new MemoryAgentRunPersistence();
      const tools = createPmGoSdkTools({
        agentRunId: AGENT_RUN_ID,
        options: baseOptions({ repoRoot: tmp, specPath }),
        persistence,
        fetchImpl,
      });

      const result = await findTool(tools, "pmgo_submit_spec").handler(
        { specPath: otherSpecPath },
        {},
      );

      const decoded = decodeResult(result) as Record<string, unknown>;
      expect(decoded.status).toBe("rejected");
      expect(String(decoded.message)).toMatch(/operator-provided spec path/);
      expect(decoded.allowedSpecPath).toBe(specPath);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("Codex extra — pmgo_drive_plan rejects an approve override and surfaces effectiveApprove", async () => {
    const persistence = new MemoryAgentRunPersistence();
    const tools = createPmGoSdkTools({
      agentRunId: AGENT_RUN_ID,
      options: baseOptions({ approve: "interactive" }),
      persistence,
      handlers: {
        async drivePlan() {
          throw new Error("handler must not be called when guard rejects");
        },
      },
    });

    const result = await findTool(tools, "pmgo_drive_plan").handler(
      { planId: PLAN_ID, approve: "all" },
      {},
    );

    const decoded = decodeResult(result) as Record<string, unknown>;
    expect(decoded.status).toBe("rejected");
    expect(decoded.requestedApprove).toBe("all");
    expect(decoded.effectiveApprove).toBe("interactive");
  });

  it("Codex extra — pmgo_approve_pending under --approve none returns requires_confirmation without hitting the API", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const persistence = new MemoryAgentRunPersistence();
    const tools = createPmGoSdkTools({
      agentRunId: AGENT_RUN_ID,
      options: baseOptions({ approve: "none" }),
      persistence,
      fetchImpl,
    });

    const result = await findTool(tools, "pmgo_approve_pending").handler(
      { planId: PLAN_ID },
      {},
    );

    const decoded = decodeResult(result) as Record<string, unknown>;
    expect(decoded.status).toBe("requires_confirmation");
    expect(decoded.planId).toBe(PLAN_ID);
    // The 'none' guard fires before any HTTP call to the approvals endpoint.
    expect(fetchCalls).toHaveLength(0);
  });

  it("T2.2.2 — pmgo_ensure_stack rejects out-of-scope repoRoot", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pm-go-orchestrator-tools-"));
    try {
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl: typeof globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const persistence = new MemoryAgentRunPersistence();
      const tools = createPmGoSdkTools({
        agentRunId: AGENT_RUN_ID,
        options: baseOptions({ repoRoot: tmp }),
        persistence,
        fetchImpl,
      });

      const result = await findTool(tools, "pmgo_ensure_stack").handler(
        { repoRoot: "/etc" },
        {},
      );

      const decoded = decodeResult(result) as Record<string, unknown>;
      expect(decoded.status).toBe("rejected");
      expect(String(decoded.message)).toMatch(/operator-provided repo root/);
      expect(decoded.allowedRepoRoot).toBe(tmp);
      // No /health probe — the scope guard fires first.
      expect(fetchCalls).toHaveLength(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
