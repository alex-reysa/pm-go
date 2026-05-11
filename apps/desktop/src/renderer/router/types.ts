/**
 * Route-map type definitions for the desktop renderer.
 *
 * The desktop's information architecture (docs/desktop/03-information-
 * architecture.md §Route Map) enumerates exactly the routes that MVP
 * operators are expected to navigate. This module declares the
 * compile-time shape of those routes — the `RouteId` union, the
 * `RouteDescriptor` record carried for each route, and the
 * `RouteMap` table type that the concrete constants in
 * `./routes.js` populate.
 *
 * Why a separate `types.ts` rather than letting `routes.ts` infer
 * everything: the layout primitives (drawer, inspector, nav) consume
 * route metadata via the type-only surface — for example,
 * `inspectorContext` accepts `readonly RouteId[]` for its allow-list.
 * Splitting the union out as a named type keeps those consumer
 * signatures self-documenting and avoids circular type imports between
 * layout components and the routes table.
 *
 * No runtime side effects live in this file. `./routes.js` owns the
 * constants; `./index.js` barrels both.
 */

/**
 * Canonical, ordered list of every route the desktop renderer
 * exposes during MVP. The order matches docs/desktop/03-information-
 * architecture.md §Route Map top-to-bottom so the NavBar and any
 * iteration over `ALL_ROUTES` produces a stable, documentation-anchored
 * ordering without a separate sort step.
 *
 * Adding a new route is a deliberate, two-step change:
 *   1. Append the id here (and the matching descriptor in
 *      `./routes.js`).
 *   2. Update the IA doc.
 * Skipping step (2) means the route exists in code but not in the
 * design system; reviewers should reject such drift.
 */
export const ROUTE_IDS = [
  "attach",
  "runs",
  "runs.new",
  "run.overview",
  "run.phases",
  "run.tasks",
  "run.taskDetail",
  "run.approvals",
  "run.budget",
  "run.evidence",
  "run.artifactDetail",
  "run.release",
  "settings",
] as const;

/**
 * String-literal union of every known route id. Layout components and
 * route guards should accept `RouteId` rather than `string` so the
 * compiler rejects typos at the call site.
 */
export type RouteId = (typeof ROUTE_IDS)[number];

/**
 * Per-route metadata.
 *
 * `path` is the react-router path pattern (with `:param` placeholders)
 * — NOT a concrete URL. Helpers in `./routes.js` (e.g.
 * `pathForRunOverview`) produce concrete paths for `:planId` and
 * `:taskId` lookups.
 *
 * `drawerAllowed` and `inspectorAllowed` are the load-bearing booleans
 * that the EventDrawer and RightInspector consult before mounting. A
 * route with `drawerAllowed: false` MUST NOT render the drawer toggle,
 * even if a parent layout would otherwise show it. Same shape for the
 * inspector. See docs/desktop/03-information-architecture.md §Route Map
 * columns "Event drawer" and "Right inspector".
 *
 * `runScoped` flags routes that hang off `/runs/:planId` and therefore
 * mount under the `RunDetailShell` layout host. The desktop's
 * navigation guards use this to refuse to mount run-scoped routes when
 * `:planId` is missing or stale.
 */
export interface RouteDescriptor {
  readonly id: RouteId;
  readonly path: string;
  readonly title: string;
  readonly drawerAllowed: boolean;
  readonly inspectorAllowed: boolean;
  readonly runScoped: boolean;
}

/**
 * Compile-time-keyed map from `RouteId` to its descriptor. Using a
 * mapped type (rather than `Record<RouteId, RouteDescriptor>`) lets
 * the lookup return the *narrow* descriptor whose `.id` is exactly
 * the key you asked for, which makes guards like
 * `ROUTES["run.overview"].id === "run.overview"` provable to the
 * compiler.
 */
export type RouteMap = {
  readonly [K in RouteId]: RouteDescriptor & { readonly id: K };
};
