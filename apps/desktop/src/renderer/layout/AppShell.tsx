/**
 * Top-level layout host for the desktop renderer.
 *
 * `AppShell` mounts at the root of the router tree. It owns:
 *
 *   - The primary NavBar (top-level routes only — Runs, Settings; the
 *     Attach screen lives outside the shell during initial connect).
 *   - The shared visual frame (header band, body, optional drawer
 *     slot, optional inspector slot).
 *   - The react-router-dom `<Outlet />` for the matched child route.
 *
 * It intentionally does NOT own:
 *
 *   - Run-scoped navigation. That belongs to {@link RunDetailShell},
 *     which mounts as a child layout under `/runs/:planId/...`.
 *   - The plan / SSE / data fetches. Those layer on top in M5+.
 *   - The router instance itself (BrowserRouter / HashRouter /
 *     MemoryRouter). The router config is the downstream task; this
 *     shell only assumes it's mounted inside *some* router.
 *
 * Drawer + inspector contracts:
 *   - The drawer is gated to run-scoped routes via
 *     `DRAWER_ALLOWED_ROUTE_IDS`. AppShell's NavBar therefore passes
 *     `null` to the drawer-toggle slot — the run-scoped shell mounts
 *     its own toggle.
 *   - The inspector is closed by default and mounts under a per-shell
 *     `RightInspectorProvider`. AppShell creates the provider with
 *     an empty allow-list so calls to `setOpen(true)` outside a
 *     run-scoped child are rejected. `RunDetailShell` re-wraps with
 *     the run-scoped allow-list, which shadows this provider for its
 *     subtree.
 */

import React, { useMemo, useState } from "react";
import { Outlet } from "react-router-dom";

import { NavBar, type NavBarItem } from "./NavBar.js";
import { RightInspectorProvider } from "./inspectorContext.js";
import {
  ROUTES,
  type RouteId,
} from "../router/index.js";

export interface AppShellProps {
  /**
   * The route id currently rendered. Drives drawer / inspector
   * allow-list checks at the root level. The downstream router
   * config is responsible for setting this; pass `null` if AppShell
   * is being mounted in a fixture without a real route match.
   */
  readonly currentRouteId: RouteId | null;
  /**
   * Optional override for the top-level nav items. Default behaviour
   * shows the canonical post-attach top-level nav (Runs, Settings).
   * The Attach surface deliberately does NOT live in this nav: pre-
   * attach, the renderer mounts `AttachScreen` directly, not the
   * shell.
   */
  readonly navItems?: readonly NavBarItem[];
  /**
   * Optional children override. Defaults to react-router-dom's
   * `<Outlet />`. Tests / fixtures pass concrete children when they
   * want to render the shell outside a router. Production callers
   * should leave this unset.
   */
  readonly children?: React.ReactNode;
}

/**
 * Default top-level nav. Pulled out of the component body so the
 * mapping from `RouteId` to `NavBarItem` reads as a small table.
 */
const DEFAULT_TOP_LEVEL_NAV_ITEMS: readonly NavBarItem[] = Object.freeze([
  {
    id: "runs",
    to: ROUTES.runs.path,
    label: ROUTES.runs.title,
  },
  {
    id: "settings",
    to: ROUTES.settings.path,
    label: ROUTES.settings.title,
  },
]);

export function AppShell(props: AppShellProps): React.JSX.Element {
  const { currentRouteId, navItems, children } = props;

  // Top-level inspector state. The empty allow-list means
  // `setOpen(true)` always falls through to the disallowed-route
  // path; the run-scoped shell re-wraps with the real allow-list for
  // its subtree.
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);

  const items = useMemo<readonly NavBarItem[]>(
    () => navItems ?? DEFAULT_TOP_LEVEL_NAV_ITEMS,
    [navItems],
  );

  return (
    <RightInspectorProvider
      isOpen={inspectorOpen}
      setOpen={setInspectorOpen}
      currentRouteId={currentRouteId}
      allowedRouteIds={[]}
    >
      <div
        className="app-shell"
        data-testid="app-shell"
        data-current-route={currentRouteId ?? ""}
      >
        <header className="app-shell__header">
          <NavBar
            ariaLabel="Primary"
            items={items}
            drawerToggle={null}
            inspectorToggle={null}
          />
        </header>
        <main className="app-shell__body" data-testid="app-shell-body">
          {children ?? <Outlet />}
        </main>
      </div>
    </RightInspectorProvider>
  );
}
