import { Box, Text, useInput } from "ink";
import React from "react";

import { Spinner } from "./spinner.js";

/**
 * Fullscreen confirm modal. Ink doesn't support absolute-positioned
 * overlays, so the app shell renders this instead of the current
 * screen while a `PendingAction` is set. Owns its own `useInput`
 * binding so the underlying screen's chord buffer doesn't accumulate
 * keystrokes while the operator is answering.
 *
 * Keys: `y` or `enter` → confirm; `n` or `esc` → cancel. Both
 * suppressed while `busy` so an in-flight POST can't be double-fired.
 */
export function ConfirmModal(props: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}): React.ReactElement {
  const busy = props.busy ?? false;

  useInput((input, key) => {
    if (busy) return;
    if (input === "y" || key.return) {
      props.onConfirm();
      return;
    }
    if (input === "n" || key.escape) {
      props.onCancel();
      return;
    }
  });

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={2}>
      <Box
        borderStyle="round"
        borderColor="yellow"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        minWidth={50}
      >
        <Text bold>Confirm</Text>
        <Box marginTop={1}>
          <Text>{props.message}</Text>
        </Box>
        {props.error !== null && props.error !== undefined && (
          <Box marginTop={1}>
            <Text color="red">{props.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          {busy ? (
            <Spinner label="working…" />
          ) : (
            <Text dimColor>y/enter confirm   n/esc cancel</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
