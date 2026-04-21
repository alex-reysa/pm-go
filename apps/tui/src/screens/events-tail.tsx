import { Box, Text } from "ink";
import React, { useCallback, useState } from "react";

import type { UUID, WorkflowEvent } from "@pm-go/contracts";

import { useEventStream } from "../lib/hooks.js";

/**
 * Rolling events panel. Subscribes to the plan's SSE stream (which
 * replays everything from the start then tails live), buffers the
 * last `limit` events, and renders a newest-at-bottom log.
 *
 * Rendered inside the plan-detail layout; on its own it's not a
 * standalone screen. Worker 3 may extend it with filtering per
 * event-kind or a drill-down view.
 */
export function EventsTail(props: {
  planId: UUID;
  limit?: number;
}): React.ReactElement {
  const limit = props.limit ?? 10;
  const [events, setEvents] = useState<WorkflowEvent[]>([]);

  const onEvent = useCallback(
    (event: WorkflowEvent) => {
      setEvents((prev) => {
        const next = [...prev, event];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    },
    [limit],
  );

  useEventStream(props.planId, onEvent);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Events</Text>
      {events.length === 0 ? (
        <Text dimColor>waiting for events…</Text>
      ) : (
        events.map((event) => (
          <Box key={event.id}>
            <Text dimColor>{formatTime(event.createdAt)} </Text>
            <Text color={colorForKind(event.kind)}>{event.kind}</Text>
            <Text>{` ${summary(event)}`}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 19);
  } catch {
    return iso.slice(0, 8);
  }
}

function colorForKind(kind: WorkflowEvent["kind"]): string {
  switch (kind) {
    case "phase_status_changed":
      return "magenta";
    case "task_status_changed":
      return "cyan";
    case "artifact_persisted":
      return "green";
  }
}

function summary(event: WorkflowEvent): string {
  switch (event.kind) {
    case "phase_status_changed":
      return `phase=${event.phaseId.slice(0, 8)} ${event.payload.previousStatus}→${event.payload.nextStatus}`;
    case "task_status_changed":
      return `task=${event.taskId.slice(0, 8)} ${event.payload.previousStatus}→${event.payload.nextStatus}`;
    case "artifact_persisted":
      return `artifact=${event.payload.artifactId.slice(0, 8)} kind=${event.payload.artifactKind}`;
  }
}
