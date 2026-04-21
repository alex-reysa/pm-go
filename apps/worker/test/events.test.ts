import { describe, expect, it, vi } from "vitest";

import { createEventActivities } from "../src/activities/events.js";

type Db = Parameters<typeof createEventActivities>[0]["db"];

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";

function makeDbMock(options: { insertError?: Error } = {}) {
  const values = vi.fn().mockImplementation(() =>
    options.insertError ? Promise.reject(options.insertError) : Promise.resolve(),
  );
  const insert = vi.fn().mockReturnValue({ values });
  return {
    db: { insert } as unknown as Db,
    spies: { insert, values },
  };
}

describe("createEventActivities.emitWorkflowEvent", () => {
  it("inserts a phase_status_changed event with host-generated id + createdAt when not supplied", async () => {
    const { db, spies } = makeDbMock();
    const { emitWorkflowEvent } = createEventActivities({ db });

    const { eventId } = await emitWorkflowEvent({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      kind: "phase_status_changed",
      payload: { previousStatus: "executing", nextStatus: "integrating" },
    });

    expect(eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: eventId,
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        taskId: null,
        kind: "phase_status_changed",
        payload: { previousStatus: "executing", nextStatus: "integrating" },
        createdAt: expect.any(String),
      }),
    );
  });

  it("returns { eventId: null } on DB failure and does NOT rethrow (best-effort projection)", async () => {
    const { db } = makeDbMock({ insertError: new Error("connection reset") });
    const { emitWorkflowEvent } = createEventActivities({ db });
    // Suppress the console.warn so the test output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await emitWorkflowEvent({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      kind: "phase_status_changed",
      payload: { previousStatus: "executing", nextStatus: "integrating" },
    });

    expect(result.eventId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Phase 7 W2 proof-of-wire. `emitWorkflowEvent` is wrapped in
  // `withSpan` and writes a correlated span row to `workflow_events`
  // (kind='span_emitted') with non-null trace_id/span_id. The wrapper
  // MUST NOT change the activity's return value.
  it("emits a span row with non-null trace_id/span_id alongside the original event (Phase 7 proof-of-wire)", async () => {
    const { db, spies } = makeDbMock();
    const { emitWorkflowEvent } = createEventActivities({ db });

    const { eventId } = await emitWorkflowEvent({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      kind: "phase_status_changed",
      payload: { previousStatus: "executing", nextStatus: "integrating" },
    });

    // Original return shape is preserved — `withSpan` is wrapping-only.
    expect(eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Two inserts land: one for the original event, one for the span.
    const allInsertArgs = spies.values.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(allInsertArgs).toHaveLength(2);

    const spanRow = allInsertArgs.find((row) => row["kind"] === "span_emitted");
    expect(spanRow, "span row should be present").toBeDefined();
    expect(spanRow!["planId"]).toBe(PLAN_ID);
    expect(spanRow!["traceId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(spanRow!["spanId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const payload = spanRow!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("ok");
    expect(payload["name"]).toBe(
      "worker.activities.events.emitWorkflowEvent",
    );
    expect(payload["attrs"]).toMatchObject({
      planId: PLAN_ID,
      kind: "phase_status_changed",
    });
    expect(typeof payload["durationMs"]).toBe("number");
  });
});
