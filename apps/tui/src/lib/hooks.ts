import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { UUID, WorkflowEvent } from "@pm-go/contracts";

import { useTuiRuntime } from "./context.js";
import { openEventStream } from "./events.js";

/**
 * Per-endpoint `useQuery` wrappers. Each hook hard-codes its query
 * key shape so the event-stream hook below can invalidate with a
 * consistent prefix. The key convention is
 * `[resource, ...scopeIds]` — prefix-match `invalidateQueries` works
 * unchanged.
 */
export function usePlans() {
  const { api } = useTuiRuntime();
  return useQuery({
    queryKey: ["plans"] as const,
    queryFn: () => api.listPlans(),
  });
}

export function usePlan(planId: UUID | null) {
  const { api } = useTuiRuntime();
  return useQuery({
    queryKey: ["plan", planId] as const,
    queryFn: () => {
      if (planId === null) {
        throw new Error("usePlan called with null planId");
      }
      return api.getPlan(planId);
    },
    enabled: planId !== null,
  });
}

export function usePhases(planId: UUID | null) {
  const { api } = useTuiRuntime();
  return useQuery({
    queryKey: ["phases", planId] as const,
    queryFn: () => {
      if (planId === null) {
        throw new Error("usePhases called with null planId");
      }
      return api.listPhases(planId);
    },
    enabled: planId !== null,
  });
}

export function useTasks(
  scope: { phaseId: UUID } | { planId: UUID } | null,
) {
  const { api } = useTuiRuntime();
  const keyScope =
    scope === null
      ? null
      : "phaseId" in scope
        ? { kind: "phase" as const, id: scope.phaseId }
        : { kind: "plan" as const, id: scope.planId };
  return useQuery({
    queryKey: ["tasks", keyScope] as const,
    queryFn: () => {
      if (scope === null) {
        throw new Error("useTasks called with null scope");
      }
      return api.listTasks(scope);
    },
    enabled: scope !== null,
  });
}

export function useAgentRuns(taskId: UUID | null) {
  const { api } = useTuiRuntime();
  return useQuery({
    queryKey: ["agent-runs", taskId] as const,
    queryFn: () => {
      if (taskId === null) {
        throw new Error("useAgentRuns called with null taskId");
      }
      return api.listAgentRuns(taskId);
    },
    enabled: taskId !== null,
  });
}

/**
 * Invalidate the query keys that depend on the given `WorkflowEvent`.
 * Exported as a pure function so a unit test can fire each kind and
 * assert the resulting cache invalidation without rendering a hook.
 *
 * Invalidation shape matches the event variant:
 *   - `phase_status_changed` → `["phases", planId]`, `["plan", planId]`, `["plans"]`
 *   - `task_status_changed`  → `["tasks"]`, `["plan", planId]`
 *   - `artifact_persisted`   → `["plan", planId]` (for `latestCompletionAudit` + `artifactIds`)
 */
export function invalidateQueriesForEvent(
  queryClient: QueryClient,
  event: WorkflowEvent,
): void {
  switch (event.kind) {
    case "phase_status_changed":
      void queryClient.invalidateQueries({ queryKey: ["phases", event.planId] });
      void queryClient.invalidateQueries({ queryKey: ["plan", event.planId] });
      void queryClient.invalidateQueries({ queryKey: ["plans"] });
      return;
    case "task_status_changed":
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["plan", event.planId] });
      return;
    case "artifact_persisted":
      void queryClient.invalidateQueries({ queryKey: ["plan", event.planId] });
      return;
  }
}

/**
 * Subscribe to the plan's SSE stream. Each event invokes `onEvent` if
 * supplied (screens use this to append to a rolling tail) and runs
 * `invalidateQueriesForEvent` so the next render re-fetches list /
 * detail data against the new server state.
 */
export function useEventStream(
  planId: UUID | null,
  onEvent?: (event: WorkflowEvent) => void,
): void {
  const { config, fetchImpl } = useTuiRuntime();
  const queryClient = useQueryClient();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (planId === null) return undefined;

    const controller = new AbortController();
    void openEventStream({
      baseUrl: config.apiBaseUrl,
      planId,
      onEvent: (event) => {
        onEventRef.current?.(event);
        invalidateQueriesForEvent(queryClient, event);
      },
      signal: controller.signal,
      maxBackoffMs: config.eventStreamMaxBackoffMs,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });

    return () => {
      controller.abort();
    };
  }, [
    planId,
    config.apiBaseUrl,
    config.eventStreamMaxBackoffMs,
    fetchImpl,
    queryClient,
  ]);
}
