/**
 * Run-scoped layout host.
 *
 * `RunDetailShell` is the layout that mounts beneath every
 * `/runs/:planId/...` route. It owns:
 *
 *   - The run-section navigation (Overview, Phases, Tasks, Approvals,
 *     Budget, Evidence, Release) — built from `RUN_SCOPED_ROUTE_IDS`,
 *     resolved against the current `:planId` via the path helpers in
 *     `../router/routes.js`.
 *   - The `EventDrawerProvider` scope (the drawer is run-scoped only).
 *   - The `RightInspectorProvider` scope (the inspector is allowed on
 *     every run-scoped route).
 *   - The route-id propagation: the shell knows which run-scoped
 *     route it's currently rendering and feeds that to the drawer /
 *     inspector allow-list checks.
 *
 * It does NOT own SSE wiring, plan fetching, or any data fetch. M5+
 * will layer those on top; this layout is the pure visual / context
 * frame.
 *
 * The shell renders `<Outlet />` for the run-scoped child route. If
 * the child route isn't in `RUN_SCOPED_ROUTE_IDS`, that's a router
 * config bug — the shell still renders the outlet to avoid eating
 * errors silently, and the child can decide what to show.
 */

import React, { useMemo, useState } from "react";
import { Outlet, useParams } from "react-router-dom";

import { EventDrawer, EventDrawerToggle } from "./EventDrawer.js";
import { EventDrawerProvider } from "./drawerContext.js";
import { useLiveRun } from "./liveDataContext.js";
import { NavBar, type NavBarItem } from "./NavBar.js";
import { RightInspectorProvider } from "./inspectorContext.js";
import { RightInspectorToggle } from "./RightInspector.js";
import {
  DRAWER_ALLOWED_ROUTE_IDS,
  INSPECTOR_ALLOWED_ROUTE_IDS,
  ROUTES,
  RUN_SCOPED_ROUTE_IDS,
  pathForRunApprovals,
  pathForRunBudget,
  pathForRunEvidence,
  pathForRunOverview,
  pathForRunPhases,
  pathForRunRelease,
  pathForRunTasks,
} from "../router/routes.js";
import type { RouteId } from "../router/types.js";

export interface RunDetailShellProps {
  /**
   * The route id currently rendered under this shell. The router
   * config (downstream) sets this per route via a wrapping element so
   * the shell can drive its allow-list checks. Pass `null` if the
   * shell is being mounted outside a known run-scoped child (rare —
   * usually only in fixtures).
   */
  readonly currentRouteId: RouteId | null;
  /**
   * Optional override for the per-section nav items. Default behaviour
   * builds the seven canonical run sections from
   * `RUN_SCOPED_ROUTE_IDS` minus the parameterised detail routes
   * (`run.taskDetail`, `run.artifactDetail`) — those are reached by
   * row clicks, not the section nav. Tests / fixtures can pass a
   * narrower list to focus the visual.
   */
  readonly navItems?: readonly NavBarItem[];
}

/**
 * Build the default run-section nav items for a given planId. Pulled
 * out of the component body so the route-id-to-path mapping is a
 * single, readable table.
 *
 * The order matches docs/desktop/03-information-architecture.md
 * §Route Map for the run sections.
 */
function defaultNavItemsFor(planId: string): readonly NavBarItem[] {
  return [
    {
      id: "run.overview",
      to: pathForRunOverview(planId),
      label: ROUTES["run.overview"].title,
    },
    {
      id: "run.phases",
      to: pathForRunPhases(planId),
      label: ROUTES["run.phases"].title,
    },
    {
      id: "run.tasks",
      to: pathForRunTasks(planId),
      label: ROUTES["run.tasks"].title,
    },
    {
      id: "run.approvals",
      to: pathForRunApprovals(planId),
      label: ROUTES["run.approvals"].title,
    },
    {
      id: "run.budget",
      to: pathForRunBudget(planId),
      label: ROUTES["run.budget"].title,
    },
    {
      id: "run.evidence",
      to: pathForRunEvidence(planId),
      label: ROUTES["run.evidence"].title,
    },
    {
      id: "run.release",
      to: pathForRunRelease(planId),
      label: ROUTES["run.release"].title,
    },
  ];
}

export function RunDetailShell(
  props: RunDetailShellProps,
): React.JSX.Element {
  const { currentRouteId, navItems } = props;
  // `useParams` returns `Partial<Record<string, string>>` under v6;
  // with `noUncheckedIndexedAccess` `params.planId` is `string |
  // undefined`. We coerce to empty-string for path-builders so the
  // nav still renders during the brief window where the route
  // matched but the param parser hasn't populated yet.
  const params = useParams<{ planId: string }>();
  const planId = params.planId ?? "";
  const liveRun = useLiveRun(planId);

  // Inspector state is owned here (the shell), not by the route body,
  // so navigating between run sections preserves the inspector's
  // open/closed state per shell mount. The closed-by-default contract
  // applies on first mount, not on every section nav.
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);

  const items = useMemo<readonly NavBarItem[]>(
    () => navItems ?? defaultNavItemsFor(planId),
    [navItems, planId],
  );

  // Confirm the runScoped invariant: the shell should only mount on
  // run-scoped routes. We don't crash on a violation — RunDetailShell
  // shouldn't take down the whole renderer — but we do log so a stray
  // mount surfaces in dev.
  if (
    currentRouteId !== null &&
    !RUN_SCOPED_ROUTE_IDS.includes(currentRouteId)
  ) {
    // eslint-disable-next-line no-console -- intentional dev signal
    console.warn(
      `RunDetailShell mounted on non-run-scoped route "${currentRouteId}". ` +
        `Check the router config — only RUN_SCOPED_ROUTE_IDS should mount this shell.`,
    );
  }

  return (
    <EventDrawerProvider>
      <RightInspectorProvider
        isOpen={inspectorOpen}
        setOpen={setInspectorOpen}
        currentRouteId={currentRouteId}
        allowedRouteIds={INSPECTOR_ALLOWED_ROUTE_IDS}
      >
        <section
          className="run-detail-shell"
          data-testid="run-detail-shell"
          data-plan-id={planId}
          data-current-route={currentRouteId ?? ""}
        >
          <NavBar
            ariaLabel="Run sections"
            items={items}
            drawerToggle={
              <EventDrawerToggle
                currentRouteId={currentRouteId}
                allowedRouteIds={DRAWER_ALLOWED_ROUTE_IDS}
              />
            }
            inspectorToggle={<RightInspectorToggle />}
          />
          <div className="run-detail-shell__body">
            <Outlet />
          </div>
          <EventDrawer
            currentRouteId={currentRouteId}
            allowedRouteIds={DRAWER_ALLOWED_ROUTE_IDS}
            isLive={liveRun !== null}
            isLoading={liveRun?.isLoading ?? false}
            errors={liveRun?.endpointErrors.events ?? []}
            events={liveRun?.events?.data ?? []}
            {...(liveRun !== null ? { onRefresh: liveRun.refresh } : {})}
          />
        </section>
      </RightInspectorProvider>
    </EventDrawerProvider>
  );
}
