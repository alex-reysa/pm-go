import { Box, Text } from "ink";
import React from "react";

import type { UUID } from "@pm-go/contracts";

import { useBudgetReport } from "../lib/hooks.js";

/**
 * Phase 7 budget panel — renders the plan-wide spend snapshot for
 * the operator. Mounted as a side panel inside the plan-detail
 * screen so spend is visible at-a-glance alongside the phase/task
 * cursor. Uses `useBudgetReport(planId)` (which calls
 * `GET /plans/:id/budget-report` on the server).
 *
 * Loading state: a single dim line — we never block the parent
 * render. Error state: a dim warning so a transient API blip
 * doesn't redirect the whole screen.
 */
export function BudgetPanel(props: { planId: UUID }): React.ReactElement {
  const { data, isLoading, error } = useBudgetReport(props.planId);

  if (isLoading && data === undefined) {
    return (
      <Box>
        <Text dimColor>budget: loading…</Text>
      </Box>
    );
  }
  if (error !== null && data === undefined) {
    return (
      <Box>
        <Text dimColor>{`budget: ${error instanceof Error ? error.message : String(error)}`}</Text>
      </Box>
    );
  }
  if (data === undefined) return <Box />;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Budget</Text>
      </Box>
      <Box>
        <Text>{`  spend: $${data.totalUsd.toFixed(4)}  tokens: ${data.totalTokens.toLocaleString()}  wall: ${data.totalWallClockMinutes.toFixed(1)}m`}</Text>
      </Box>
      {data.perTaskBreakdown.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>{`  per-task (${data.perTaskBreakdown.length}):`}</Text>
          {data.perTaskBreakdown.slice(0, 5).map((row) => (
            <Box key={row.taskId}>
              <Text dimColor>
                {`    ${row.taskId.slice(0, 8)} $${row.totalUsd.toFixed(4)} ${row.totalTokens}t ${row.totalWallClockMinutes.toFixed(1)}m`}
              </Text>
            </Box>
          ))}
          {data.perTaskBreakdown.length > 5 && (
            <Box>
              <Text dimColor>{`    +${data.perTaskBreakdown.length - 5} more`}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
