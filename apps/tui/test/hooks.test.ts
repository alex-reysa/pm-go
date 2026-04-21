import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowEvent } from "@pm-go/contracts";

import { invalidateQueriesForEvent } from "../src/lib/hooks.js";

function phaseStatusChanged(planId: string): WorkflowEvent {
  return {
    id: "ev-1",
    planId,
    kind: "phase_status_changed",
    phaseId: "phase-1",
    payload: { previousStatus: "pending", nextStatus: "executing" },
    createdAt: "2026-04-21T00:00:00.000Z",
  };
}

function taskStatusChanged(planId: string): WorkflowEvent {
  return {
    id: "ev-2",
    planId,
    kind: "task_status_changed",
    phaseId: "phase-1",
    taskId: "task-1",
    payload: { previousStatus: "pending", nextStatus: "running" },
    createdAt: "2026-04-21T00:00:01.000Z",
  };
}

function artifactPersisted(planId: string): WorkflowEvent {
  return {
    id: "ev-3",
    planId,
    kind: "artifact_persisted",
    payload: {
      artifactId: "artifact-1",
      artifactKind: "pr-summary",
      uri: "file:///tmp/plan/pr-summary.md",
    },
    createdAt: "2026-04-21T00:00:02.000Z",
  };
}

describe("invalidateQueriesForEvent", () => {
  it("phase_status_changed invalidates phases, plan, and plans", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateQueriesForEvent(qc, phaseStatusChanged("plan-1"));
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual([
      ["phases", "plan-1"],
      ["plan", "plan-1"],
      ["plans"],
    ]);
  });

  it("task_status_changed invalidates all tasks scopes + plan detail", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateQueriesForEvent(qc, taskStatusChanged("plan-7"));
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual([["tasks"], ["plan", "plan-7"]]);
  });

  it("artifact_persisted invalidates only the plan detail", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateQueriesForEvent(qc, artifactPersisted("plan-2"));
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual([["plan", "plan-2"]]);
  });

  it("marks seeded query data as invalidated after dispatching the event", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["phases", "plan-1"], []);
    qc.setQueryData(["plan", "plan-1"], { plan: null });
    qc.setQueryData(["plans"], []);

    invalidateQueriesForEvent(qc, phaseStatusChanged("plan-1"));

    expect(qc.getQueryState(["phases", "plan-1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["plan", "plan-1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["plans"])?.isInvalidated).toBe(true);
  });
});
