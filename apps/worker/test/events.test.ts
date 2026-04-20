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
});
