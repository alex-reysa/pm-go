import { Box, Text, useApp } from "ink";
import React, { useCallback, useEffect, useState } from "react";

import type { UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { Spinner } from "../components/spinner.js";
import { StatusBadge } from "../components/status-badge.js";
import { usePlans } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";

/**
 * Plans-list screen. Fully functional: fetches `GET /plans`, renders a
 * selectable list, and fires `onSelect(planId)` on enter. Worker 3
 * may expand this with search/filter; the cursor/paging contract
 * stays.
 */
export function PlansListScreen(props: {
  onSelect: (planId: UUID) => void;
}): React.ReactElement {
  const { data, isLoading, error } = usePlans();
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);

  const count = data?.length ?? 0;
  useEffect(() => {
    if (count === 0) {
      setCursor(0);
      return;
    }
    setCursor((c) => (c >= count ? count - 1 : c));
  }, [count]);

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "select-next":
          setCursor((c) => (count === 0 ? 0 : (c + 1) % count));
          return;
        case "select-prev":
          setCursor((c) => (count === 0 ? 0 : (c - 1 + count) % count));
          return;
        case "confirm": {
          const selected = data?.[cursor];
          if (selected !== undefined) props.onSelect(selected.id);
          return;
        }
        case "quit":
          exit();
          return;
        case "cancel":
          // No parent to pop to — esc at the root exits cleanly so
          // the operator gets out of the TUI with a single press.
          exit();
          return;
        default:
          return;
      }
    },
    [count, cursor, data, exit, props],
  );

  useKeybinds(dispatch);

  if (isLoading && data === undefined) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner label="loading plans…" />
      </Box>
    );
  }
  if (error !== null && data === undefined) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <ErrorBanner error={error} />
        <Text dimColor>press q to quit, then retry</Text>
      </Box>
    );
  }
  if (count === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>no plans yet — POST /plans to seed one</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Plans ({count})</Text>
      <Box flexDirection="column" marginTop={1}>
        {data!.map((plan, i) => (
          <Box key={plan.id}>
            {i === cursor ? (
              <Text color="cyan">▶ </Text>
            ) : (
              <Text>{"  "}</Text>
            )}
            <Box width={36}>
              <Text>{truncate(plan.title, 34)}</Text>
            </Box>
            <Box width={20}>
              <StatusBadge status={plan.status} />
            </Box>
            <Text dimColor>{plan.id.slice(0, 8)}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{refetchHintMessage(isLoading, error !== null)}</Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function refetchHintMessage(loading: boolean, hasError: boolean): string {
  if (loading) return "refreshing…";
  if (hasError) return "last refresh failed; next poll retries";
  return "live — updates when the server emits workflow events";
}
