/**
 * Live `DesktopApiClient` coverage with a mocked `fetch`.
 *
 * The api-client tests that live under `src/renderer/api/client.test.ts`
 * cover the URL-builder + parser plumbing in isolation. This file
 * exercises the same client at the *contract* boundary the routes
 * use: every public reader is hit with a stubbed fetch so we can
 * verify base-URL normalization, request-id extraction, parsed
 * error bodies (JSON object, JSON string, plain text), the
 * recoverability flag for 409 / 403 / 404 / 5xx, and the
 * network-error envelope. The companion read-model integration
 * suite (`../read-models/livePipeline.test.ts`) wires the same
 * mocked fetch into the read-model builders to prove the live
 * view-model mapping; this file deliberately keeps that mapping
 * concern out and stays focused on raw transport behaviour.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  ApiConfigurationError,
  createDesktopApiClient,
  isRecoverableApiStatus,
  normalizeApiBaseUrl,
} from "../../../src/renderer/api/client.js";

interface StubCall {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly search: string;
  readonly accept: string;
}

interface StubResult {
  readonly status?: number;
  readonly statusText?: string;
  readonly body?: unknown;
  readonly rawBody?: BodyInit;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

type StubHandler = (method: string, url: URL, init?: RequestInit) => StubResult;

function makeStub(handler: StubHandler): {
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
      url: url.toString(),
      pathname: url.pathname,
      search: url.search,
      accept: headers.get("accept") ?? "",
    });
    const result = handler(method, url, init);
    const responseHeaders = new Headers(result.headers ?? {});
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set(
        "content-type",
        result.contentType ?? "application/json; charset=utf-8",
      );
    }
    const body =
      result.rawBody ??
      (result.body === undefined ? "" : JSON.stringify(result.body));
    return new Response(body, {
      status: result.status ?? 200,
      statusText: result.statusText,
      headers: responseHeaders,
    });
  };
  return { request, calls };
}

describe("DesktopApiClient — base URL normalization (live, mocked fetch)", () => {
  it.each([
    [" localhost:3001 ", "http://localhost:3001"],
    ["localhost:3001/api/", "http://localhost:3001/api"],
    ["http://localhost:3001/api///", "http://localhost:3001/api"],
    ["HTTP://Localhost:3001/", "http://localhost:3001"],
    ["http://localhost:3001/api/v1/", "http://localhost:3001/api/v1"],
  ])("collapses %p to %p before any request fires", (input, expected) => {
    const { request, calls } = makeStub(() => ({ body: { plans: [] } }));
    const api = createDesktopApiClient({ baseUrl: input, request });
    expect(api.baseUrl).toBe(expected);
    void api.listPlans();
    expect(calls.length).toBeGreaterThan(0);
    // The first call must hit the normalized origin, not the raw input.
    expect(calls[0]?.url.startsWith(expected)).toBe(true);
  });

  it("appends the endpoint path beneath whatever base path the operator typed", async () => {
    const { request, calls } = makeStub((_method, url) => {
      if (url.pathname === "/api/v1/plans") {
        return { body: { plans: [] } };
      }
      return { status: 500, body: { error: "wrong_path" } };
    });
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001/api/v1",
      request,
    });
    await api.listPlans();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe("/api/v1/plans");
  });

  it("rejects unsafe base URL shapes synchronously at construction time", () => {
    const noop: typeof globalThis.fetch = vi.fn(async () =>
      new Response("{}"),
    );
    for (const value of [
      "ftp://localhost:3001",
      "http://operator:secret@localhost:3001",
      "http://localhost:3001?x=1",
      "http://localhost:3001#frag",
    ]) {
      expect(() =>
        createDesktopApiClient({ baseUrl: value, request: noop }),
      ).toThrow(ApiConfigurationError);
    }
    expect(normalizeApiBaseUrl("")).toBe("");
  });

  it("encodes path segments so a malicious id cannot escape the endpoint", async () => {
    const { request, calls } = makeStub(() => ({
      body: {
        plan: { id: "x" },
        artifactIds: [],
        latestCompletionAudit: null,
      },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });
    await api.getPlan("plan id/../../etc/passwd");
    expect(calls[0]?.pathname).toBe(
      "/plans/plan%20id%2F..%2F..%2Fetc%2Fpasswd",
    );
  });
});

describe("DesktopApiClient — recoverable error states", () => {
  // Spans every status code the recoverability predicate considers
  // recoverable AND a representative unrecoverable status to prove the
  // negative case stays honest.
  it.each([
    [403, true],
    [404, true],
    [409, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [418, false],
  ])("classifies HTTP %i recoverable=%j on listPlans()", async (status, recoverable) => {
    expect(isRecoverableApiStatus(status)).toBe(recoverable);
    const body = { error: `boom-${status}`, requestId: `body-${status}` };
    const { request } = makeStub(() => ({
      status,
      body,
      headers: { "x-request-id": `header-${status}` },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });
    let caught: ApiError | null = null;
    try {
      await api.listPlans();
    } catch (err) {
      if (err instanceof ApiError) caught = err;
      else throw err;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(status);
    expect(caught?.recoverable).toBe(recoverable);
    expect(caught?.body).toEqual(body);
    expect(caught?.requestId).toBe(`header-${status}`);
  });

  it("preserves request id from response headers OR body when the header is missing", async () => {
    const { request } = makeStub(() => ({
      status: 503,
      body: { error: "down", request_id: "body-rid-only" },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });
    await expect(api.listPlans()).rejects.toMatchObject({
      status: 503,
      requestId: "body-rid-only",
      recoverable: true,
    });
  });

  it("parses non-JSON error bodies into an inert { error: <text> } envelope", async () => {
    const { request } = makeStub(() => ({
      status: 502,
      rawBody: "service crashed",
      contentType: "text/plain",
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
      // The message falls back to a status-derived blurb because the
      // raw body wasn't an object with an `error` / `message` field.
      expect(apiErr.body).toEqual({ error: "service crashed" });
      expect(apiErr.message).toBe("service crashed");
      expect(apiErr.recoverable).toBe(true);
    }
  });

  it("surfaces a typed ApiError with status 0 for network failures", async () => {
    const request: typeof globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    };
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
      expect(apiErr.status).toBe(0);
      expect(apiErr.recoverable).toBe(false);
      expect(apiErr.body).toMatchObject({
        error: "network_error",
        cause: expect.stringContaining("ECONNREFUSED"),
      });
    }
  });
});

describe("DesktopApiClient — read endpoints", () => {
  it("composes the canonical query string for scoped listTasks / listAgentRuns", async () => {
    const { request, calls } = makeStub((_method, url) => {
      if (url.pathname === "/tasks") {
        return { body: { tasks: [] } };
      }
      if (url.pathname === "/agent-runs") {
        return { body: { agentRuns: [] } };
      }
      return { status: 500, body: { error: "unhandled" } };
    });
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    await api.listTasks({ planId: "plan-1" });
    await api.listTasks({ phaseId: "phase-2" });
    await api.listAgentRuns({ taskId: "task-3" });
    await api.listAgentRuns({ planId: "plan-1", role: "reviewer" });

    expect(calls.map((c) => `${c.pathname}${c.search}`)).toEqual([
      "/tasks?planId=plan-1",
      "/tasks?phaseId=phase-2",
      "/agent-runs?taskId=task-3",
      "/agent-runs?planId=plan-1&role=reviewer",
    ]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.accept).toBe("application/json");
    }
  });

  it("builds the SSE URL with the same normalized base + query encoding", () => {
    const { request } = makeStub(() => ({ body: {} }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001/api/",
      request,
    });
    const streamUrl = new URL(
      api.createEventStreamUrl("plan-1", "event-with space"),
    );
    expect(streamUrl.pathname).toBe("/api/events");
    expect(streamUrl.searchParams.get("planId")).toBe("plan-1");
    expect(streamUrl.searchParams.get("sinceEventId")).toBe("event-with space");
  });
});
