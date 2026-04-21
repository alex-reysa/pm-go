import { Box, Text, useApp } from "ink";
import React, { useCallback } from "react";

import type { UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { Spinner } from "../components/spinner.js";
import { StatusBadge } from "../components/status-badge.js";
import { usePlan } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";

import { EventsTail } from "./events-tail.js";

/**
 * Plan detail placeholder. Worker 3 fills the body with phase cards,
 * task lists, and drawers; Worker 2 wires the runtime end-to-end by
 * rendering the header + the live event-tail so the data-layer and
 * SSE plumbing are exercised under real use.
 */
export function PlanDetailScreen(props: {
  planId: UUID;
  onBack: () => void;
}): React.ReactElement {
  const { data, isLoading, error } = usePlan(props.planId);
  const { exit } = useApp();

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "cancel":
          props.onBack();
          return;
        case "quit":
          exit();
          return;
        default:
          // Worker 3 handles the operator-action chords (g r, g i, …).
          return;
      }
    },
    [exit, props],
  );

  useKeybinds(dispatch);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" paddingX={1}>
        {isLoading && data === undefined ? (
          <Spinner label="loading plan…" />
        ) : error !== null && data === undefined ? (
          <ErrorBanner error={error} />
        ) : data !== undefined ? (
          <>
            <Text bold>{data.plan.title}</Text>
            <Box>
              <Text dimColor>{`${props.planId.slice(0, 8)}  `}</Text>
              <StatusBadge status={data.plan.status} />
              <Text dimColor>{`  phases=${data.plan.phases.length}  tasks=${data.plan.tasks.length}`}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                — Worker 3 fills this with phase cards + task drawers —
              </Text>
            </Box>
          </>
        ) : null}
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderTop
      >
        <EventsTail planId={props.planId} />
      </Box>
    </Box>
  );
}
