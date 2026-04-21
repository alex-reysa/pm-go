import { describe, expect, it } from "vitest";

import type { WorkflowEvent } from "@pm-go/contracts";

import { openEventStream } from "../src/lib/events.js";

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function sseFrame(event: string, id: string, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

function phaseEvent(id: string, next: string): WorkflowEvent {
  return {
    id,
    planId: "plan-1",
    kind: "phase_status_changed",
    phaseId: "phase-1",
    payload: { previousStatus: "pending", nextStatus: next as "executing" },
    createdAt: "2026-04-21T00:00:00.000Z",
  };
}

describe("openEventStream", () => {
  it("parses multiple SSE frames in a single chunk and skips heartbeat/ready frames", async () => {
    const body = [
      ": heartbeat\n\n",
      "event: ready\ndata: ok\nretry: 2000\n\n",
      sseFrame("phase_status_changed", "ev-1", phaseEvent("ev-1", "executing")),
      sseFrame("task_status_changed", "ev-2", {
        id: "ev-2",
        planId: "plan-1",
        kind: "task_status_changed",
        phaseId: "phase-1",
        taskId: "task-1",
        payload: { previousStatus: "pending", nextStatus: "running" },
        createdAt: "2026-04-21T00:00:01.000Z",
      }),
    ].join("");

    const received: WorkflowEvent[] = [];
    const controller = new AbortController();
    const fakeFetch: typeof fetch = async () =>
      new Response(textStream(body), { status: 200 });

    const runPromise = openEventStream({
      baseUrl: "http://test",
      planId: "plan-1",
      onEvent: (ev) => {
        received.push(ev);
        if (received.length === 2) controller.abort();
      },
      signal: controller.signal,
      fetchImpl: fakeFetch,
      sleep: async () => undefined,
    });

    await runPromise;

    expect(received).toHaveLength(2);
    expect(received[0]!.kind).toBe("phase_status_changed");
    expect(received[1]!.kind).toBe("task_status_changed");
  });

  it("reconnects after the stream ends and resumes from the last event id", async () => {
    const firstBody = sseFrame(
      "phase_status_changed",
      "ev-1",
      phaseEvent("ev-1", "executing"),
    );
    const secondBody = sseFrame(
      "phase_status_changed",
      "ev-2",
      phaseEvent("ev-2", "integrating"),
    );
    const urls: string[] = [];
    let call = 0;
    const fakeFetch: typeof fetch = async (url) => {
      urls.push(String(url));
      const body = call === 0 ? firstBody : secondBody;
      call += 1;
      return new Response(textStream(body), { status: 200 });
    };

    const controller = new AbortController();
    const received: WorkflowEvent[] = [];
    const runPromise = openEventStream({
      baseUrl: "http://test",
      planId: "plan-1",
      onEvent: (ev) => {
        received.push(ev);
        if (received.length === 2) controller.abort();
      },
      signal: controller.signal,
      fetchImpl: fakeFetch,
      sleep: async () => undefined,
    });

    await runPromise;

    expect(received.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("planId=plan-1");
    expect(urls[0]).not.toContain("sinceEventId=");
    expect(urls[1]).toContain("sinceEventId=ev-1");
  });

  it("keeps backing off across reconnects when the server closes with zero events", async () => {
    // Server accepts the connection (200) but emits no events and
    // closes immediately. The client should NOT reset backoff — a
    // reconnect-200-close-immediately loop would otherwise spin at the
    // 250 ms floor forever. The test passes if the sleep sequence
    // grows (250, 500, 1000, …).
    const sleepCalls: number[] = [];
    let call = 0;
    const controller = new AbortController();
    const fakeFetch: typeof fetch = async () => {
      call += 1;
      // After 4 reconnect attempts, abort so the test completes.
      if (call >= 4) controller.abort();
      return new Response(textStream(""), { status: 200 });
    };

    await openEventStream({
      baseUrl: "http://test",
      planId: "plan-1",
      onEvent: () => {
        // no events fire on an empty body
      },
      signal: controller.signal,
      fetchImpl: fakeFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    // Each empty reconnect doubles the backoff without resetting.
    expect(sleepCalls).toEqual([250, 500, 1000]);
  });

  it("resets backoff to 250 after a connection emits at least one real event", async () => {
    const sleepCalls: number[] = [];
    let call = 0;
    const controller = new AbortController();
    const fakeFetch: typeof fetch = async () => {
      call += 1;
      if (call === 1) return new Response(textStream(""), { status: 200 }); // empty
      if (call === 2) {
        return new Response(
          textStream(
            sseFrame("phase_status_changed", "ev-1", phaseEvent("ev-1", "executing")),
          ),
          { status: 200 },
        );
      }
      // Third connection is again empty; if backoff reset correctly
      // after call 2, we expect the next sleep to be 250.
      controller.abort();
      return new Response(textStream(""), { status: 200 });
    };

    await openEventStream({
      baseUrl: "http://test",
      planId: "plan-1",
      onEvent: () => {
        // no-op; we care about sleep durations, not events
      },
      signal: controller.signal,
      fetchImpl: fakeFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    // First empty → 250. Second (with event) → reset, then 250 after.
    expect(sleepCalls).toEqual([250, 250]);
  });

  it("surfaces an onError callback when the server responds with a non-2xx and then keeps retrying", async () => {
    let call = 0;
    const errors: Error[] = [];
    const controller = new AbortController();
    const fakeFetch: typeof fetch = async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 500 });
      // Second attempt closes the stream cleanly; the loop aborts via
      // onOpen since there's no event to trigger abort.
      controller.abort();
      return new Response(textStream(""), { status: 200 });
    };

    await openEventStream({
      baseUrl: "http://test",
      planId: "plan-1",
      onEvent: () => {
        // no-op
      },
      onError: (err) => errors.push(err),
      signal: controller.signal,
      fetchImpl: fakeFetch,
      sleep: async () => undefined,
    });

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.message).toContain("sse open: status=500");
  });
});
