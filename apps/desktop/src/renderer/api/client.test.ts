import { describe, expect, it } from "vitest";

import {
  ApiConfigurationError,
  ApiError,
  createDesktopApiClient,
  createDesktopApiClientFromConfig,
  normalizeApiBaseUrl,
} from "./client.js";

const validEnvelope = {
  status: "ok" as const,
  service: "pm-go-api" as const,
  version: "0.8.8.0",
  instance: "desktop-test",
  port: 3001,
};

interface StubCall {
  method: string;
  pathname: string;
  search: string;
  accept: string;
  contentType: string;
  body: unknown;
}

interface StubResult {
  status?: number;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
}

type StubHandler = (method: string, url: URL, init?: RequestInit) => StubResult;

function stubRequest(handler: StubHandler): {
  request: typeof globalThis.fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const request: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      method,
      pathname: url.pathname,
      search: url.search,
      accept: headers.get("accept") ?? "",
      contentType: headers.get("content-type") ?? "",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });

    const result = handler(method, url, init);
    const responseHeaders = new Headers(result.headers ?? {});
    responseHeaders.set(
      "content-type",
      result.contentType ?? "application/json; charset=utf-8",
    );
    const body =
      result.rawBody ??
      (result.body === undefined ? "" : JSON.stringify(result.body));
    return new Response(body, {
      status: result.status ?? 200,
      headers: responseHeaders,
    });
  };
  return { request, calls };
}

describe("Desktop API base URLs", () => {
  it("shares one normalized base across probe, JSON reads, artifacts, and event setup", async () => {
    const { request, calls } = stubRequest((_method, url) => {
      if (url.pathname.endsWith("/" + "health")) {
        return { body: validEnvelope };
      }
      if (url.pathname.endsWith("/plans")) {
        return { body: { plans: [] } };
      }
      if (url.pathname.endsWith("/artifacts/artifact-1")) {
        return {
          rawBody: "# artifact\n",
          contentType: "text/markdown; charset=utf-8",
          headers: { "content-length": "11" },
        };
      }
      return { status: 500, body: { error: "unhandled" } };
    });
    const api = createDesktopApiClient({
      baseUrl: "  localhost:3001/api///  ",
      request,
    });

    expect(api.baseUrl).toBe("http://localhost:3001/api");
    await expect(api.probeHealth()).resolves.toEqual({
      kind: "connected",
      envelope: validEnvelope,
    });
    await expect(api.listPlans()).resolves.toEqual([]);
    await expect(api.readArtifact("artifact-1")).resolves.toMatchObject({
      bodyKind: "text",
      contentType: "text/markdown; charset=utf-8",
      contentLength: 11,
      text: "# artifact\n",
    });

    const streamUrl = new URL(api.createEventStreamUrl("plan-1", "event-1"));
    expect(calls.map((call) => `${call.pathname}${call.search}`)).toEqual([
      ["", "api", "health"].join("/"),
      "/api/plans",
      "/api/artifacts/artifact-1",
    ]);
    expect(streamUrl.pathname).toBe("/api/events");
    expect(streamUrl.searchParams.get("planId")).toBe("plan-1");
    expect(streamUrl.searchParams.get("sinceEventId")).toBe("event-1");
  });

  it("classifies health probe request failures as api_unreachable", async () => {
    const request: typeof globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    await expect(api.probeHealth()).resolves.toEqual({
      kind: "api_unreachable",
      message: "connect ECONNREFUSED",
    });
  });

  it("preserves health probe API error status, body, and request id", async () => {
    const body = { error: "startup_pending", requestId: "body-request-id" };
    const { request } = stubRequest(() => ({
      status: 503,
      body,
      headers: { "x-request-id": "header-request-id" },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    await expect(api.probeHealth()).resolves.toEqual({
      kind: "api_error",
      status: 503,
      body,
      requestId: "header-request-id",
    });
  });

  it("classifies non-envelope successful health responses as foreign_service", async () => {
    const { request } = stubRequest(() => ({
      body: { status: "ok", service: "legacy-api" },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    await expect(api.probeHealth()).resolves.toEqual({
      kind: "foreign_service",
      status: 200,
    });
  });

  it("preserves desktop config values and rejects unsafe base URL parts", () => {
    const { request } = stubRequest(() => ({ body: { plans: [] } }));
    const api = createDesktopApiClientFromConfig(
      { apiBaseUrl: " localhost:3001/ " },
      { request },
    );
    expect(api.baseUrl).toBe("http://localhost:3001");
    expect(normalizeApiBaseUrl("")).toBe("");

    for (const value of [
      "ftp://localhost:3001",
      "http://operator:secret@localhost:3001",
      "http://localhost:3001?x=1",
      "http://localhost:3001#frag",
    ]) {
      expect(() => normalizeApiBaseUrl(value)).toThrow(ApiConfigurationError);
    }
  });
});

describe("Desktop API read methods", () => {
  it("exposes read endpoints for cockpit data", async () => {
    const { request, calls } = stubRequest((_method, url) => {
      if (url.pathname === "/plans" && url.search === "") {
        return { body: { plans: [] } };
      }
      if (url.pathname === "/plans/plan-1") {
        return { body: { plan: {}, artifactIds: [], latestCompletionAudit: null } };
      }
      if (url.pathname === "/phases" && url.search !== "") {
        return { body: { planId: "plan-1", phases: [] } };
      }
      if (url.pathname === "/phases/phase-1") {
        return { body: { phase: {}, latestMergeRun: null, latestPhaseAudit: null } };
      }
      if (url.pathname === "/tasks" && url.search !== "") {
        return { body: { tasks: [] } };
      }
      if (url.pathname === "/tasks/task-1") {
        return {
          body: {
            task: {},
            latestAgentRun: null,
            latestLease: null,
            latestReviewReport: null,
            taskPolicyDecisions: [],
          },
        };
      }
      if (url.pathname === "/tasks/task-1/review-reports") {
        return { body: { taskId: "task-1", reports: [] } };
      }
      if (url.pathname === "/agent-runs" && url.search !== "") {
        return { body: { agentRuns: [] } };
      }
      if (url.pathname === "/agent-runs/run-1/tool-calls") {
        return { body: { agentRunId: "run-1", toolCalls: [] } };
      }
      if (url.pathname === "/approvals") {
        return { body: { planId: "plan-1", approvals: [] } };
      }
      if (url.pathname === "/plans/plan-1/budget-report") {
        return {
          body: {
            id: "budget-1",
            planId: "plan-1",
            totalUsd: 0,
            totalTokens: 0,
            totalWallClockMinutes: 0,
            perTaskBreakdown: [],
            generatedAt: "2026-05-11T00:00:00.000Z",
          },
        };
      }
      if (url.pathname === "/events") {
        return { body: { planId: "plan-1", events: [], lastEventId: null } };
      }
      return { status: 500, body: { error: "unhandled" } };
    });
    const api = createDesktopApiClient({ baseUrl: "http://localhost:3001", request });

    await api.listPlans();
    await api.getPlan("plan-1");
    await api.listPhases("plan-1");
    await api.getPhase("phase-1");
    await api.listTasks({ planId: "plan-1" });
    await api.listTasks({ phaseId: "phase-1" });
    await api.getTask("task-1");
    await api.listTaskReviewReports("task-1");
    await api.listAgentRuns({ taskId: "task-1" });
    await api.listAgentRuns({ planId: "plan-1", role: "implementer" });
    await api.listAgentRunToolCalls("run-1");
    await api.listApprovals("plan-1");
    await api.getBudgetReport("plan-1");
    await api.replayEvents("plan-1", "event-1");

    expect(calls.map((call) => `${call.pathname}${call.search}`)).toEqual([
      "/plans",
      "/plans/plan-1",
      "/phases?planId=plan-1",
      "/phases/phase-1",
      "/tasks?planId=plan-1",
      "/tasks?phaseId=phase-1",
      "/tasks/task-1",
      "/tasks/task-1/review-reports",
      "/agent-runs?taskId=task-1",
      "/agent-runs?planId=plan-1&role=implementer",
      "/agent-runs/run-1/tool-calls",
      "/approvals?planId=plan-1",
      "/plans/plan-1/budget-report",
      "/events?planId=plan-1&sinceEventId=event-1",
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => call.accept === "application/json")).toBe(true);
  });

  it("posts every M4 mutating action to the documented endpoint", async () => {
    const approval = {
      id: "approval-1",
      planId: "plan-1",
      subject: "plan",
      riskBand: "high",
      status: "approved",
      requestedAt: "2026-05-12T00:00:00.000Z",
    };
    const { request, calls } = stubRequest((_method, url) => {
      if (url.pathname === "/tasks/task-1/run") {
        return { body: { taskId: "task-1", workflowRunId: "run-1", cycleNumber: 1 } };
      }
      if (url.pathname === "/tasks/task-1/review") {
        return { body: { taskId: "task-1", workflowRunId: "review-1", cycleNumber: 2 } };
      }
      if (url.pathname === "/tasks/task-1/fix") {
        return {
          body: {
            taskId: "task-1",
            workflowRunId: "fix-1",
            reviewReportId: "review-report-1",
            cycleNumber: 2,
          },
        };
      }
      if (url.pathname === "/tasks/task-1/approve") {
        return { body: { taskId: "task-1", approval } };
      }
      if (url.pathname === "/tasks/task-1/override-review") {
        return {
          body: {
            taskId: "task-1",
            previousStatus: "blocked",
            newStatus: "ready_to_merge",
            policyDecisionId: "policy-1",
            overriddenBy: "operator",
            reason: "accepted false positive",
          },
        };
      }
      if (url.pathname === "/phases/phase-1/integrate") {
        return { body: { phaseId: "phase-1", workflowRunId: "integrate-1", mergeRunIndex: 1 } };
      }
      if (url.pathname === "/phases/phase-1/audit") {
        return { body: { phaseId: "phase-1", workflowRunId: "audit-1", auditIndex: 1 } };
      }
      if (url.pathname === "/phases/phase-1/override-audit") {
        return {
          body: {
            phaseId: "phase-1",
            previousStatus: "blocked",
            newStatus: "completed",
            auditReportId: "audit-report-1",
            reason: "operator accepted",
            overriddenAt: "2026-05-12T00:00:00.000Z",
          },
        };
      }
      if (url.pathname === "/plans/plan-1/approve") {
        return { body: { planId: "plan-1", approval } };
      }
      if (url.pathname === "/plans/plan-1/approve-all-pending") {
        return {
          body: {
            planId: "plan-1",
            approvedCount: 1,
            approvedIds: ["approval-1"],
            skippedCount: 1,
            skipped: [{ id: "approval-2", taskId: null, reason: "riskBand=catastrophic" }],
          },
        };
      }
      if (url.pathname === "/plans/plan-1/complete") {
        return { body: { planId: "plan-1", workflowRunId: "complete-1", auditIndex: 3 } };
      }
      if (url.pathname === "/plans/plan-1/release") {
        return { body: { planId: "plan-1", workflowRunId: "release-1", releaseIndex: 1 } };
      }
      return { status: 500, body: { error: "unhandled" } };
    });
    const api = createDesktopApiClient({ baseUrl: "http://localhost:3001", request });

    await api.runTask("task-1", { requestedBy: "desktop" });
    await api.reviewTask("task-1");
    await api.fixTask("task-1");
    await api.approveTask("task-1", { approvedBy: "operator" });
    await api.overrideReview("task-1", {
      reason: "accepted false positive",
      overriddenBy: "operator",
    });
    await api.integratePhase("phase-1");
    await api.auditPhase("phase-1");
    await api.overrideAudit("phase-1", {
      reason: "operator accepted",
      overriddenBy: "operator",
    });
    await api.approvePlan("plan-1", { approvedBy: "operator" });
    await api.approveAllPending("plan-1", {
      reason: "bulk accept safe rows",
      approvedBy: "operator",
    });
    await api.completePlan("plan-1", { requestedBy: "desktop" });
    await api.releasePlan("plan-1");

    expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      "POST /tasks/task-1/run",
      "POST /tasks/task-1/review",
      "POST /tasks/task-1/fix",
      "POST /tasks/task-1/approve",
      "POST /tasks/task-1/override-review",
      "POST /phases/phase-1/integrate",
      "POST /phases/phase-1/audit",
      "POST /phases/phase-1/override-audit",
      "POST /plans/plan-1/approve",
      "POST /plans/plan-1/approve-all-pending",
      "POST /plans/plan-1/complete",
      "POST /plans/plan-1/release",
    ]);
    expect(calls[0]?.body).toEqual({ requestedBy: "desktop" });
    expect(calls[1]?.body).toBeNull();
    expect(calls[4]?.body).toEqual({
      reason: "accepted false positive",
      overriddenBy: "operator",
    });
    expect(calls[9]?.body).toEqual({
      reason: "bulk accept safe rows",
      approvedBy: "operator",
    });
    expect(calls.every((call) => call.accept === "application/json")).toBe(true);
    expect(
      calls
        .filter((call) => call.body !== null)
        .every((call) => call.contentType.includes("application/json")),
    ).toBe(true);
  });
});

describe("Desktop API errors and artifacts", () => {
  it("preserves recoverable ApiError details for conflict, forbidden, missing, and server failures", async () => {
    for (const status of [409, 403, 404, 503]) {
      const body = {
        error: `recoverable ${status}`,
        blockedPhaseIds: ["phase-1"],
      };
      const { request } = stubRequest(() => ({
        status,
        body,
        headers: { "x-request-id": `req-${status}` },
      }));
      const api = createDesktopApiClient({
        baseUrl: "http://localhost:3001",
        request,
      });

      try {
        await api.listPlans();
        throw new Error("expected ApiError");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(status);
        expect(apiErr.body).toEqual(body);
        expect(apiErr.requestId).toBe(`req-${status}`);
        expect(apiErr.message).toBe(`recoverable ${status}`);
        expect(apiErr.recoverable).toBe(true);
      }
    }
  });

  it("parses artifact responses as inert JSON, text, or bytes", async () => {
    const { request } = stubRequest((_method, url) => {
      if (url.pathname.endsWith("/json-artifact")) {
        return {
          body: { ok: true },
          contentType: "application/json; charset=utf-8",
        };
      }
      if (url.pathname.endsWith("/text-artifact")) {
        return { rawBody: "plain text", contentType: "text/plain; charset=utf-8" };
      }
      return {
        rawBody: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream",
      };
    });
    const api = createDesktopApiClient({ baseUrl: "http://localhost:3001", request });

    await expect(api.readArtifact("json-artifact")).resolves.toMatchObject({
      bodyKind: "json",
      json: { ok: true },
    });
    await expect(api.readArtifact("text-artifact")).resolves.toMatchObject({
      bodyKind: "text",
      text: "plain text",
    });
    const binary = await api.readArtifact("binary-artifact");
    expect(binary.bodyKind).toBe("binary");
    if (binary.bodyKind === "binary") {
      expect([...new Uint8Array(binary.bytes)]).toEqual([1, 2, 3]);
    }
  });
});
