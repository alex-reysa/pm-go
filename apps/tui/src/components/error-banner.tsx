import { Box, Text } from "ink";
import React from "react";

import { ApiError } from "../lib/api.js";

/**
 * Compact inline error row. Shows HTTP status + message so a 409
 * (precondition violation — the common case for operator actions on
 * a wrongly-staged phase) looks visibly different from a network
 * error.
 */
export function ErrorBanner(props: { error: unknown }): React.ReactElement {
  const { error } = props;
  const status = error instanceof ApiError ? `HTTP ${error.status}` : "ERROR";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown error";
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        {status}
      </Text>
      <Text>{` ${message}`}</Text>
    </Box>
  );
}
