/**
 * Public barrel for `apps/desktop/src/renderer/router/`.
 *
 * Layout primitives, future route bodies, and the router config (added
 * downstream) should import from `"./router/index.js"` rather than
 * reaching into individual files. Keeping the public surface here lets
 * us re-shuffle the internals (e.g. splitting `routes.ts` into one file
 * per route family) without touching every consumer.
 *
 * No runtime initialisation happens at module load — this barrel is
 * pure re-export.
 */

export type { RouteDescriptor, RouteId, RouteMap } from "./types.js";
export { ROUTE_IDS } from "./types.js";

export {
  ALL_ROUTES,
  DRAWER_ALLOWED_ROUTE_IDS,
  INSPECTOR_ALLOWED_ROUTE_IDS,
  RUN_SCOPED_ROUTE_IDS,
  ROUTES,
  routeFor,
  pathForArtifactDetail,
  pathForRunApprovals,
  pathForRunBudget,
  pathForRunEvidence,
  pathForRunOverview,
  pathForRunPhases,
  pathForRunRelease,
  pathForRunTasks,
  pathForTaskDetail,
} from "./routes.js";
