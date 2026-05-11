/**
 * Concrete route-map constants for the desktop renderer.
 *
 * The descriptors here are the single source of truth that
 * `apps/desktop/src/renderer/layout/*` consults: NavBar reads the
 * `title`, EventDrawer reads `drawerAllowed`, RightInspector reads
 * `inspectorAllowed`, RunDetailShell reads `runScoped`, and the
 * react-router config (added in a downstream task) reads `path`.
 *
 * Coverage anchors to docs/desktop/03-information-architecture.md
 * §Route Map. The MVP rows are:
 *   /attach, /runs, /runs/new, /runs/:planId,
 *   /runs/:planId/phases, /runs/:planId/tasks,
 *   /runs/:planId/tasks/:taskId, /runs/:planId/approvals,
 *   /runs/:planId/budget, /runs/:planId/evidence,
 *   /runs/:planId/evidence/:artifactId, /runs/:planId/release,
 *   /settings.
 *
 * `/workflow-preview` is intentionally omitted: it's a non-MVP,
 * feature-flagged read-only surface and not part of the cockpit.
 * Phase-1 route bodies should not assume it exists.
 */

import {
  ROUTE_IDS,
  type RouteDescriptor,
  type RouteId,
  type RouteMap,
} from "./types.js";

/**
 * Reusable boolean shorthands that document intent at the call site.
 * `RUN_SCOPED.drawerAllowed === true` reads as "the event drawer is
 * allowed on run-scoped routes" — the IA doc's "Yes, collapsed"
 * column.
 */
const TOP_LEVEL = Object.freeze({
  drawerAllowed: false,
  inspectorAllowed: false,
  runScoped: false,
} as const);

const RUN_SCOPED = Object.freeze({
  drawerAllowed: true,
  inspectorAllowed: true,
  runScoped: true,
} as const);

/**
 * Compile-time-keyed map of every desktop route.
 *
 * The `satisfies RouteMap` constraint is what gives this constant its
 * teeth: TypeScript will refuse to compile if any `RouteId` is missing
 * a descriptor (criterion 6a100003), and the literal object preserves
 * the narrow `.id` types so consumers can pattern-match.
 */
export const ROUTES = Object.freeze({
  attach: {
    id: "attach",
    path: "/attach",
    title: "Attach",
    ...TOP_LEVEL,
  },
  runs: {
    id: "runs",
    path: "/runs",
    title: "Runs",
    ...TOP_LEVEL,
  },
  "runs.new": {
    id: "runs.new",
    path: "/runs/new",
    title: "New Spec",
    ...TOP_LEVEL,
  },
  "run.overview": {
    id: "run.overview",
    path: "/runs/:planId",
    title: "Run Overview",
    ...RUN_SCOPED,
  },
  "run.phases": {
    id: "run.phases",
    path: "/runs/:planId/phases",
    title: "Plan / Phases",
    ...RUN_SCOPED,
  },
  "run.tasks": {
    id: "run.tasks",
    path: "/runs/:planId/tasks",
    title: "Tasks",
    ...RUN_SCOPED,
  },
  "run.taskDetail": {
    id: "run.taskDetail",
    path: "/runs/:planId/tasks/:taskId",
    title: "Task Detail",
    ...RUN_SCOPED,
  },
  "run.approvals": {
    id: "run.approvals",
    path: "/runs/:planId/approvals",
    title: "Approvals",
    ...RUN_SCOPED,
  },
  "run.budget": {
    id: "run.budget",
    path: "/runs/:planId/budget",
    title: "Budget",
    ...RUN_SCOPED,
  },
  "run.evidence": {
    id: "run.evidence",
    path: "/runs/:planId/evidence",
    title: "Evidence",
    ...RUN_SCOPED,
  },
  "run.artifactDetail": {
    id: "run.artifactDetail",
    path: "/runs/:planId/evidence/:artifactId",
    title: "Artifact Detail",
    ...RUN_SCOPED,
  },
  "run.release": {
    id: "run.release",
    path: "/runs/:planId/release",
    title: "Release",
    ...RUN_SCOPED,
  },
  settings: {
    id: "settings",
    path: "/settings",
    title: "Settings",
    ...TOP_LEVEL,
  },
} as const) satisfies RouteMap;

/**
 * Ordered descriptor list. Iteration order matches `ROUTE_IDS`, which
 * matches the IA doc. NavBar should render top-level routes by
 * filtering this list for `descriptor.runScoped === false`; run
 * navigation should filter for `descriptor.runScoped === true`.
 *
 * `noUncheckedIndexedAccess` makes a naive `ROUTES[id]` lookup return
 * `RouteDescriptor | undefined`, so we coerce through the typed map
 * here where the key is statically known to be present.
 */
export const ALL_ROUTES: readonly RouteDescriptor[] = ROUTE_IDS.map(
  (id) => ROUTES[id],
);

/**
 * Look up a route descriptor by id. Always returns a defined value
 * because `RouteId` is the literal-union of `ROUTE_IDS` and `ROUTES`
 * is keyed by that exact union — but the `noUncheckedIndexedAccess`
 * setting forces a runtime/type-level check on raw indexing, so this
 * helper exists to centralise the cast and document the invariant.
 */
export function routeFor(id: RouteId): RouteDescriptor {
  return ROUTES[id];
}

/**
 * Path-builder helpers for the parameterised routes. These return
 * concrete URLs (no `:placeholder` remnants) so callers can hand the
 * result straight to `<Link to={...} />` or `navigate(...)`.
 *
 * The helpers do NOT percent-encode the inputs — react-router-dom
 * v6's `Link` handles encoding for path segments at render time, and
 * double-encoding produces broken URLs. If callers ever build raw
 * `<a href={...}>` links, they must `encodeURIComponent` the segment
 * themselves.
 */
export function pathForRunOverview(planId: string): string {
  return `/runs/${planId}`;
}

export function pathForRunPhases(planId: string): string {
  return `/runs/${planId}/phases`;
}

export function pathForRunTasks(planId: string): string {
  return `/runs/${planId}/tasks`;
}

export function pathForTaskDetail(planId: string, taskId: string): string {
  return `/runs/${planId}/tasks/${taskId}`;
}

export function pathForRunApprovals(planId: string): string {
  return `/runs/${planId}/approvals`;
}

export function pathForRunBudget(planId: string): string {
  return `/runs/${planId}/budget`;
}

export function pathForRunEvidence(planId: string): string {
  return `/runs/${planId}/evidence`;
}

export function pathForArtifactDetail(planId: string, artifactId: string): string {
  return `/runs/${planId}/evidence/${artifactId}`;
}

export function pathForRunRelease(planId: string): string {
  return `/runs/${planId}/release`;
}

/**
 * Convenience: the ids of every run-scoped route. Used by
 * `RunDetailShell` and inspector-allow-list construction.
 */
export const RUN_SCOPED_ROUTE_IDS: readonly RouteId[] = ROUTE_IDS.filter(
  (id) => ROUTES[id].runScoped,
);

/**
 * Convenience: the ids of every route on which the right inspector is
 * allowed to open. This is the default allow-list that
 * `RightInspector` callers consume when they don't pass an explicit
 * one.
 */
export const INSPECTOR_ALLOWED_ROUTE_IDS: readonly RouteId[] = ROUTE_IDS.filter(
  (id) => ROUTES[id].inspectorAllowed,
);

/**
 * Convenience: the ids of every route on which the event drawer is
 * allowed to mount. Mirrors `INSPECTOR_ALLOWED_ROUTE_IDS`.
 */
export const DRAWER_ALLOWED_ROUTE_IDS: readonly RouteId[] = ROUTE_IDS.filter(
  (id) => ROUTES[id].drawerAllowed,
);
