import { Box, Text } from "ink";
import React from "react";

import type { TuiAction } from "../lib/keybinds.js";
import { KEYBINDS } from "../lib/keybinds.js";

/**
 * Keybind cheatsheet. `bindings` filters to a subset (use when a
 * screen only supports a few chords); `disabledKinds` marks chords
 * that exist on the screen but can't fire right now (e.g. `ga audit`
 * when no phase is in `auditing`). Disabled chords render dim; enabled
 * render at normal intensity — the operator catches the dim/bright
 * shift at a glance.
 */
export function Footer(props: {
  bindings?: ReadonlyArray<TuiAction["kind"]>;
  disabledKinds?: ReadonlyArray<TuiAction["kind"]>;
}): React.ReactElement {
  const pool =
    props.bindings === undefined
      ? KEYBINDS
      : KEYBINDS.filter((b) => props.bindings!.includes(b.action.kind));
  const visible = pool.filter((b) => b.label.length > 0);
  const disabled = props.disabledKinds ?? [];

  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      {visible.map((b, i) => {
        const isDisabled = disabled.includes(b.action.kind);
        return (
          <React.Fragment key={b.chord}>
            {i > 0 && <Text>{"  "}</Text>}
            <Text dimColor={isDisabled}>{b.label}</Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
