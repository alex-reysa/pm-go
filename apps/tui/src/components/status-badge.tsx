import { Text } from "ink";
import React from "react";

import type {
  PhaseStatus,
  PlanStatus,
  TaskStatus,
} from "@pm-go/contracts";

/**
 * Map domain-status values to an Ink color. The categories match how
 * an operator reads a dashboard: green = successful terminal, yellow
 * = in-flight, red = blocked/failed, cyan = queued/ready. Covers every
 * `PlanStatus`, `PhaseStatus`, and `TaskStatus` variant — if the
 * contract adds a new status the `never` check below surfaces it at
 * compile time so the badge doesn't fall back to a bland default.
 */
const COLOR_BY_STATUS: Record<
  PlanStatus | PhaseStatus | TaskStatus,
  "green" | "yellow" | "red" | "cyan" | "gray"
> = {
  // PlanStatus
  draft: "gray",
  auditing: "yellow",
  approved: "cyan",
  blocked: "red",
  executing: "yellow",
  completed: "green",
  failed: "red",
  // PhaseStatus (pending + integrating unique to phase)
  pending: "gray",
  planning: "cyan",
  integrating: "yellow",
  // TaskStatus (remaining unique)
  ready: "cyan",
  running: "yellow",
  in_review: "yellow",
  fixing: "yellow",
  ready_to_merge: "cyan",
  merged: "green",
};

export function StatusBadge(props: {
  status: PlanStatus | PhaseStatus | TaskStatus;
}): React.ReactElement {
  const color = COLOR_BY_STATUS[props.status];
  return (
    <Text color={color} bold>
      {props.status}
    </Text>
  );
}
