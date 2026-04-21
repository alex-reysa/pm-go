import { Box, Text } from "ink";
import React from "react";

import type { PhaseListItem } from "../lib/api.js";
import type { Phase } from "@pm-go/contracts";

import { StatusBadge } from "./status-badge.js";

/**
 * Phase header row. Accepts either a full `Phase` (from
 * `usePlan().plan.phases`) or the lighter `PhaseListItem` (from
 * `usePhases`) — both carry the fields this component needs.
 */
type PhaseLike = Pick<
  Phase,
  "id" | "index" | "title" | "status" | "integrationBranch"
> & {
  taskCount?: number;
};

export function PhaseCard(props: {
  phase: PhaseLike | PhaseListItem;
  taskCount: number;
}): React.ReactElement {
  const { phase, taskCount } = props;
  return (
    <Box>
      <Box width={6}>
        <Text dimColor>{`P${phase.index}`}</Text>
      </Box>
      <Box width={32}>
        <Text bold>{truncate(phase.title, 30)}</Text>
      </Box>
      <Box width={18}>
        <StatusBadge status={phase.status} />
      </Box>
      <Text dimColor>{`${taskCount} task${taskCount === 1 ? "" : "s"}`}</Text>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
