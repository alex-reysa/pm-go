/**
 * Compatibility body for the phase-0 `/runs` route.
 *
 * M1 mounted this stub directly behind the connected-state gate. M2
 * keeps the export and its `runs-placeholder` test id for downstream
 * compatibility, but the gate now mounts the full phase-0 route tree
 * and this component is only the inert body of `/runs`.
 *
 * The component is intentionally inert: no fetches, no effects, no
 * conditional rendering. Real runs-list data lands in a later
 * milestone.
 */

import React from "react";

export function RunsPlaceholder(): React.JSX.Element {
  return (
    <section
      className="runs-placeholder"
      data-route="runs"
      data-testid="runs-placeholder"
      aria-labelledby="runs-placeholder-title"
    >
      <h2 id="runs-placeholder-title">Runs</h2>
      <p>
        Plan execution surfaces here in a later milestone. This page is a
        placeholder confirming that the desktop has attached to a real pm-go
        API.
      </p>
    </section>
  );
}
