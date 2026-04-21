import { Box, Text } from "ink";
import React from "react";

import { KEYBINDS } from "../lib/keybinds.js";

/**
 * Keybind cheatsheet. Filters to the bindings worth showing for the
 * given route so a cluttered nav bar doesn't hide the relevant
 * actions. Worker 3 will likely pass an explicit allowlist as it
 * fills out the screens.
 */
export function Footer(props: {
  bindings?: ReadonlyArray<(typeof KEYBINDS)[number]["action"]["kind"]>;
}): React.ReactElement {
  const pool =
    props.bindings === undefined
      ? KEYBINDS
      : KEYBINDS.filter((b) => props.bindings!.includes(b.action.kind));
  const selected = pool.filter((b) => b.label.length > 0);
  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text dimColor>{selected.map((b) => b.label).join("  ")}</Text>
    </Box>
  );
}
