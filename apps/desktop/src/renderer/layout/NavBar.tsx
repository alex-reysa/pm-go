/**
 * Top navigation primitive for the desktop renderer.
 *
 * The NavBar is intentionally dumb: it consumes a pre-resolved list of
 * `{ id, to, label }` entries and renders them as react-router-dom
 * `NavLink`s. It does NOT decide which routes are visible — that
 * decision belongs to its parent (`AppShell` for top-level navigation,
 * `RunDetailShell` for run-scoped navigation). Keeping the NavBar
 * route-shape-agnostic lets the same component render both surfaces
 * without coupling it to planId resolution, which only the run shell
 * has.
 *
 * The component also accepts an optional drawer-toggle slot
 * (`drawerToggle`). When the parent decides the current route allows
 * the event drawer (per `DRAWER_ALLOWED_ROUTE_IDS`), it passes a
 * pre-built toggle button here; otherwise it passes `null` and the
 * NavBar renders without any drawer affordance. The NavBar never
 * touches `useEventDrawer` directly — that keeps it usable on routes
 * outside the EventDrawerProvider scope (Attach, Settings).
 */

import React from "react";
import { NavLink } from "react-router-dom";

import type { RouteId } from "../router/types.js";

/**
 * One row in the navigation. `to` is the resolved URL (NOT a route
 * pattern with `:placeholder` segments). Use the path helpers in
 * `../router/routes.js` (e.g. `pathForRunOverview(planId)`) to derive
 * concrete URLs before passing them here.
 */
export interface NavBarItem {
  readonly id: RouteId;
  readonly to: string;
  readonly label: string;
  /** Optional aria-label override, defaults to `label`. */
  readonly ariaLabel?: string;
  /** Disable the link without removing it; useful for "not yet connected" gating. */
  readonly disabled?: boolean;
}

export interface NavBarProps {
  /** Resolved nav rows in display order. */
  readonly items: readonly NavBarItem[];
  /**
   * Optional accessible name for the nav landmark. Defaults to
   * `"Primary"`, which is appropriate for the AppShell's top-level
   * NavBar; `RunDetailShell` should override with `"Run sections"` so
   * a screen reader can distinguish the two regions.
   */
  readonly ariaLabel?: string;
  /**
   * Optional slot for the event-drawer toggle button. Parents pass
   * `null` on routes where the drawer is not allowed. The NavBar
   * places the slot at the end of the nav row.
   */
  readonly drawerToggle?: React.ReactNode;
  /**
   * Optional slot for an inspector toggle button. Same shape rules as
   * `drawerToggle`: `null` on routes where the inspector is not
   * allowed.
   */
  readonly inspectorToggle?: React.ReactNode;
}

/**
 * Render an inert link entry. Extracted so the disabled-state styling
 * lives next to the active-state styling, and so `NavBar`'s render
 * body stays readable.
 *
 * react-router-dom's `NavLink` does not natively support a disabled
 * state — we render a plain `<span>` with `aria-disabled` instead so
 * the row stays in the tab order for screen readers but doesn't
 * navigate.
 */
function NavRow({ item }: { item: NavBarItem }): React.JSX.Element {
  if (item.disabled === true) {
    return (
      <li className="navbar__row navbar__row--disabled">
        <span
          className="navbar__link navbar__link--disabled"
          aria-disabled="true"
          aria-label={item.ariaLabel ?? item.label}
          data-route-id={item.id}
          data-testid={`navbar-link-${item.id}`}
        >
          {item.label}
        </span>
      </li>
    );
  }
  return (
    <li className="navbar__row">
      <NavLink
        to={item.to}
        end
        className={({ isActive }: { isActive: boolean }): string =>
          isActive ? "navbar__link navbar__link--active" : "navbar__link"
        }
        aria-label={item.ariaLabel ?? item.label}
        data-route-id={item.id}
        data-testid={`navbar-link-${item.id}`}
      >
        {item.label}
      </NavLink>
    </li>
  );
}

export function NavBar(props: NavBarProps): React.JSX.Element {
  const {
    items,
    ariaLabel = "Primary",
    drawerToggle = null,
    inspectorToggle = null,
  } = props;
  return (
    <nav
      className="navbar"
      aria-label={ariaLabel}
      data-testid="navbar"
    >
      <ul className="navbar__list">
        {items.map((item) => (
          <NavRow key={item.id} item={item} />
        ))}
      </ul>
      {drawerToggle !== null || inspectorToggle !== null ? (
        <div className="navbar__toggles" data-testid="navbar-toggles">
          {drawerToggle}
          {inspectorToggle}
        </div>
      ) : null}
    </nav>
  );
}
