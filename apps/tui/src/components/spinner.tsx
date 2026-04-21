import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import React from "react";

/**
 * Inline loading indicator. Kept as a thin wrapper so the rest of the
 * app never imports `ink-spinner` directly — if the spinner library
 * changes, this is the only site to update.
 */
export function Spinner(props: { label?: string }): React.ReactElement {
  return (
    <Box>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      {props.label !== undefined && <Text>{` ${props.label}`}</Text>}
    </Box>
  );
}
