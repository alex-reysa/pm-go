import { describe, expect, it } from "vitest";

import { ApiError, createApiClient } from "../src/lib/api.js";

interface StubCall {
  method: string;
  url: string;
  accept: string;
}

interface StubHandler {
  match: (method: string, url: URL) => boolean;
  handle: (method: string, url: URL) => { status: number; body: unknown };
}

function stubFetch(handlers: StubHandler[]) {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const urlString = typeof input === "string" ? input : input.toString();
    const url = new URL(urlString);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      method,
      url: `${url.pathname}${url.search}`,
      accept: headers.get("accept") ?? "",
    });
    for (const h of handlers) {
      if (h.match(method, url)) {
        const { status, body } = h.handle(method, url);
        return new Response(body === null ? "" : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "unhandled" }), { status: 500 });
  };
  return { fetchImpl, calls };
}

describe("createApiClient — list endpoints", () => {
  it("listPlans unwraps { plans: [...] }", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "GET" && u.pathname === "/plans",
        handle: () => ({
          status: 200,
          body: {
            plans: [
              {
                id: "00000000-0000-0000-0000-000000000001",
                title: "Plan A",
                summary: "first",
                status: "approved",
                risks: [],
                completionAuditReportId: null,
                createdAt: "2026-04-21T00:00:00.000Z",
                updatedAt: "2026-04-21T01:00:00.000Z",
              },
            ],
          },
        }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    const plans = await api.listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.title).toBe("Plan A");
    expect(calls[0]!.accept).toBe("application/json");
  });

  it("listPhases attaches planId query param", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "GET" && u.pathname === "/phases",
        handle: (_m, u) => ({
          status: 200,
          body: { planId: u.searchParams.get("planId"), phases: [] },
        }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    await api.listPhases("plan-uuid");
    expect(calls[0]!.url).toBe("/phases?planId=plan-uuid");
  });

  it("listTasks dispatches phaseId vs planId scopes", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "GET" && u.pathname === "/tasks",
        handle: () => ({ status: 200, body: { tasks: [] } }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    await api.listTasks({ phaseId: "phase-1" });
    await api.listTasks({ planId: "plan-1" });
    expect(calls[0]!.url).toBe("/tasks?phaseId=phase-1");
    expect(calls[1]!.url).toBe("/tasks?planId=plan-1");
  });

  it("replayEvents passes sinceEventId when supplied", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "GET" && u.pathname === "/events",
        handle: () => ({
          status: 200,
          body: { planId: "p", events: [], lastEventId: null },
        }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    await api.replayEvents("plan-1");
    await api.replayEvents("plan-1", "cursor-1");
    expect(calls[0]!.url).toBe("/events?planId=plan-1");
    expect(calls[1]!.url).toBe("/events?planId=plan-1&sinceEventId=cursor-1");
  });
});

describe("createApiClient — write endpoints", () => {
  it("POST /tasks/:id/run resolves on 202 with empty JSON body", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "POST" && u.pathname === "/tasks/task-1/run",
        handle: () => ({ status: 202, body: { accepted: true } }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    await expect(api.runTask("task-1")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("/tasks/task-1/run");
  });

  it("throws ApiError with status + parsed body on 409", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: (m, u) => m === "POST" && u.pathname === "/phases/p/integrate",
        handle: () => ({
          status: 409,
          body: { error: "phase is 'pending', expected 'executing'" },
        }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t", fetchImpl });
    await expect(api.integratePhase("p")).rejects.toBeInstanceOf(ApiError);
    await expect(api.integratePhase("p")).rejects.toMatchObject({
      status: 409,
      message: "phase is 'pending', expected 'executing'",
    });
  });
});

describe("createApiClient — base URL handling", () => {
  it("strips trailing slashes on the baseUrl", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (m, u) => m === "GET" && u.pathname === "/plans",
        handle: () => ({ status: 200, body: { plans: [] } }),
      },
    ]);
    const api = createApiClient({ baseUrl: "http://t///", fetchImpl });
    await api.listPlans();
    // Slash is still correctly interpolated (no double-slash pathname).
    expect(calls[0]!.url).toBe("/plans");
  });
});
