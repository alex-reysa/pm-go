/**
 * Post-attach placeholder route.
 *
 * This is the stub that the renderer mounts ONLY when the attach
 * state machine is in `connected`. The point of shipping it at this
 * stage is to prove out the gating discipline — every later feature
 * page (runs list, run detail, plan editor) will hang off the same
 * gate, so getting the contract right while there's nothing real to
 * lose matters more than the contents of the page.
 *
 * The component is intentionally inert: no fetches, no effects, no
 * conditional rendering. If you reach this component, the API is
 * attached. If you don't, you're still in {@link AttachScreen}.
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
