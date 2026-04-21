import { Box, Text } from "ink";
import React from "react";

import type { Route } from "../types.js";

/**
 * Top status bar: brand + API base URL on the left, current route on
 * the right. Rendered once at the top of every screen so the operator
 * always sees which stack they're pointing at.
 */
export function Header(props: {
  apiBaseUrl: string;
  route: Route;
}): React.ReactElement {
  const routeLabel =
    props.route.name === "plans"
      ? "plans"
      : `plan/${props.route.planId.slice(0, 8)}`;
  return (
    <Box
      borderStyle="single"
      borderBottom
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text bold color="cyan">
          pm-go
        </Text>
        <Text dimColor>{`  api=${props.apiBaseUrl}`}</Text>
      </Text>
      <Text dimColor>{`[${routeLabel}]`}</Text>
    </Box>
  );
}
