import { describe, it, expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import specDocumentFixture from "../../../packages/contracts/src/fixtures/core/spec-document.json" with { type: "json" };

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-abc",
    workflowId: "wf-abc"
  });
  return {
    start,
    client: {
      workflow: { start }
    } as any
  };
}

describe("POST /spec-documents", () => {
  it("returns 202 and starts the workflow on valid body", async () => {
    const { start, client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      workflowName: "SpecToPlanWorkflow"
    });
    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(specDocumentFixture)
    });
    expect(res.status).toBe(202);
    const payload = await res.json();
    expect(payload.specDocumentId).toBe(
      (specDocumentFixture as { id: string }).id
    );
    expect(payload.workflowRunId).toBe("run-abc");
    expect(start).toHaveBeenCalledWith(
      "SpecToPlanWorkflow",
      expect.objectContaining({
        taskQueue: "pm-go-worker",
        workflowId: `spec-intake-${(specDocumentFixture as { id: string }).id}`
      })
    );
  });

  it("returns 400 on invalid body", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      workflowName: "SpecToPlanWorkflow"
    });
    const res = await app.request("/spec-documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: "shape" })
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      workflowName: "SpecToPlanWorkflow"
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
