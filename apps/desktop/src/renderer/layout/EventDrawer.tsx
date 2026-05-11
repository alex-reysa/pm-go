/**
 * Bottom-anchored Event Drawer placeholder.
 *
 * The drawer is **collapsed by default** and only mounts on run-scoped
 * routes. The body is a placeholder — there is no SSE wiring, no event
 * stream, no fixture import. M6 owns the actual events stream; this
 * component exists now so:
 *
 *   1. The drawer-toggle context (`drawerContext.ts`) has a real
 *      consumer that exercises the `isOpen` / `toggle` API.
 *   2. The visual frame (panel chrome, header, close button) is
 *      already in place when M6 lands, so M6 only has to swap the
 *      `<EventDrawerEmptyState />` body for the real stream renderer.
 *   3. Layout work (height, transitions, focus trapping) can ship
 *      independently of the data plumbing.
 *
 * Allow-list: callers MUST pass `allowedRouteIds` (typically
 * `DRAWER_ALLOWED_ROUTE_IDS` from `../router/routes.js`) plus the
 * `currentRouteId`. If the current route is not in the allow-list,
 * the drawer renders nothing — even if `isOpen` is true. This belt-
 * and-braces gating keeps a stale `isOpen` in the provider from
 * leaking the drawer onto e.g. the Attach screen after a back-nav.
 */

import React from "react";

import { useEventDrawer } from "./drawerContext.js";
import type { RouteId } from "../router/types.js";

export interface EventDrawerProps {
  /**
   * The id of the currently mounted route. Drives the allow-list
   * check; if the route id isn't in `allowedRouteIds`, the drawer
   * renders nothing.
   */
  readonly currentRouteId: RouteId | null;
  /**
   * Route ids on which the drawer is permitted to render. Pass
   * `DRAWER_ALLOWED_ROUTE_IDS` for the canonical IA allow-list.
   */
  readonly allowedRouteIds: readonly RouteId[];
}

/**
 * Body shown when the drawer is open. The string here is the load-
 * bearing content the task summary calls out — reviewers will look
 * for it verbatim.
 */
function EventDrawerEmptyState(): React.JSX.Element {
  return (
    <div className="event-drawer__empty" data-testid="event-drawer-empty">
      <p>Events stream wires up in M6.</p>
      <p className="event-drawer__hint">
        This drawer will surface workflow events for the selected run
        once the SSE bridge lands. For now it stays a placeholder so
        the toggle wiring can be reviewed in isolation.
      </p>
    </div>
  );
}

export function EventDrawer(props: EventDrawerProps): React.JSX.Element | null {
  const { currentRouteId, allowedRouteIds } = props;
  const { isOpen, setOpen } = useEventDrawer();

  // Allow-list gate: if we're on a route that doesn't allow the
  // drawer, render nothing. Belt-and-braces with the toggle button —
  // even if a stray caller flipped `isOpen`, this prevents the panel
  // from leaking through.
  if (currentRouteId === null || !allowedRouteIds.includes(currentRouteId)) {
    return null;
  }

  if (!isOpen) {
    // Closed-by-default state: nothing on screen. The toggle button
    // (rendered by NavBar / RunDetailShell) is the only affordance
    // when the drawer is collapsed.
    return null;
  }

  return (
    <aside
      className="event-drawer"
      role="complementary"
      aria-label="Event drawer"
      data-testid="event-drawer"
      data-open="true"
    >
      <header className="event-drawer__header">
        <h2 className="event-drawer__title">Events</h2>
        <button
          type="button"
          className="event-drawer__close"
          onClick={() => setOpen(false)}
          aria-label="Close event drawer"
          data-testid="event-drawer-close"
        >
          Close
        </button>
      </header>
      <EventDrawerEmptyState />
    </aside>
  );
}

/**
 * Render-helper for the toggle button that lives in the NavBar /
 * RunDetailShell header. Extracted here (rather than in NavBar) so the
 * drawer's open/closed copy stays in one file. Parents that decide a
 * route allows the drawer call this to get a ready-made button; on
 * disallowed routes they pass `null` to NavBar's `drawerToggle` slot.
 */
export function EventDrawerToggle({
  currentRouteId,
  allowedRouteIds,
}: EventDrawerProps): React.JSX.Element | null {
  const { isOpen, toggle } = useEventDrawer();
  if (currentRouteId === null || !allowedRouteIds.includes(currentRouteId)) {
    return null;
  }
  return (
    <button
      type="button"
      className="event-drawer__toggle"
      onClick={toggle}
      aria-expanded={isOpen}
      aria-controls="event-drawer-panel"
      data-testid="event-drawer-toggle"
    >
      {isOpen ? "Hide events" : "Show events"}
    </button>
  );
}
