/**
 * Root component for the desktop renderer.
 *
 * Routing model (M2, phase-0 router):
 *
 *   1. {@link AttachScreen} is always rendered. It owns the state-
 *      machine UI, the inline settings input, and the per-state
 *      remediation copy. Pre-attach, it is the only thing on screen.
 *   2. Post-attach (`ctx.state === "connected"` AND
 *      `ctx.envelope !== null`), the renderer additionally mounts the
 *      phase-0 router. The router landing route is `/runs` — there is
 *      no prototype-style Dashboard surface. Everything else hangs off
 *      the canonical IA route map (see `./router/routes.ts`).
 *
 * The double envelope/state guard is deliberate. `connected` can only
 * ever be set by a `probe_connected` event that carried an envelope,
 * so the envelope check is logically redundant. It remains as the
 * load-bearing guard that proves to a static reader (and a fuzz test)
 * that `foreign_service` / `api_unreachable` / `api_error` /
 * `not_configured` can never fall through to the router even if a
 * future bug let `state` drift out of sync with `envelope`. The cost
 * of the extra check is one boolean; the benefit is a hard invariant
 * on the gating contract.
 *
 * The router wrapper defaults to `<HashRouter>`: the renderer ships
 * as a `file://` URL inside Electron, so the only viable history
 * provider is hash-based. Tests inject a static or memory router via
 * {@link AppProps.postAttachRouter} to drive a specific initial
 * location without depending on `window.location`.
 */

import React, { useEffect, useReducer } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
} from "react-router-dom";

import type { Config } from "../shared/config.js";
import { AttachScreen } from "./AttachScreen.js";
import type { AttachContext, AttachEvent } from "./attachMachine.js";
import { initialContext, reduce, runProbe } from "./attachMachine.js";
import type { PmGoDesktopBridge } from "./bridge.js";
import { RunsPlaceholder } from "./RunsPlaceholder.js";
import { AppShell, RunDetailShell } from "./layout/index.js";
import {
  ALL_ROUTES,
  ROUTES,
  type RouteId,
} from "./router/index.js";

/**
 * Canonical post-attach landing path. Exported so shell smokes can
 * assert the IA decision directly without rendering the `/` redirect
 * through a server renderer (React Router's `<Navigate>` is effect-
 * driven and therefore inert under `renderToStaticMarkup`).
 */
export const POST_ATTACH_LANDING_PATH = ROUTES.runs.path;

export interface AppProps {
  /** Bridge to the main process; mockable in tests. */
  bridge: PmGoDesktopBridge;
  /** Initial config (already read off the bridge by the bootstrap). */
  initialConfig: Config;
  /**
   * Optional wrapper around {@link AppRoutes} used by the post-attach
   * route mount. Defaults to `<HashRouter>` — the renderer ships as
   * `file://` and a `BrowserRouter` would require server-side cooperation
   * we don't have. Tests inject a static or memory router so the
   * post-attach landing route can be observed under
   * `renderToStaticMarkup`.
   */
  postAttachRouter?: (routes: React.ReactNode) => React.JSX.Element;
}

/**
 * Build the reducer's initial context from an `AppProps.initialConfig`.
 * Extracted as a named function so the `useReducer` initializer
 * argument is a stable reference even across re-renders.
 */
function initContextFromConfig(config: Config): AttachContext {
  return initialContext(config);
}

/**
 * Resolve a concrete pathname to its canonical `RouteId`. Walks
 * `ALL_ROUTES` in iteration order (which matches the IA doc) and
 * returns the first `matchPath` hit. The order matters: more-specific
 * patterns (e.g. `/runs/new`) precede their parameterised siblings
 * (`/runs/:planId`), so the literal route wins.
 *
 * Returns `null` if nothing matches — callers should pass `null`
 * through to the shell's `currentRouteId` prop so the allow-list
 * checks fall through to the "disallowed" branch.
 */
function findRouteIdForPath(pathname: string): RouteId | null {
  for (const descriptor of ALL_ROUTES) {
    if (matchPath({ path: descriptor.path, end: true }, pathname) !== null) {
      return descriptor.id;
    }
  }
  return null;
}

/**
 * Layout host wrapper that derives `currentRouteId` from the live
 * location. Used as a layout `<Route element=...>` so every child
 * top-level route inherits the AppShell without each route having to
 * pass its own routeId.
 */
function AppShellLayout(): React.JSX.Element {
  const location = useLocation();
  const routeId = findRouteIdForPath(location.pathname);
  return <AppShell currentRouteId={routeId} />;
}

/**
 * Symmetric layout host for the run-scoped `RunDetailShell`. Same
 * shape as `AppShellLayout`; lives in App.tsx (not RunDetailShell.tsx)
 * because the routeId derivation is router-config concern, not layout
 * concern.
 */
function RunDetailShellLayout(): React.JSX.Element {
  const location = useLocation();
  const routeId = findRouteIdForPath(location.pathname);
  return <RunDetailShell currentRouteId={routeId} />;
}

/**
 * Inert placeholder body. Phase-0 routes don't yet talk to the API
 * (M3+ will wire fixtures, M5+ will wire real data). Each route just
 * renders a labelled `<section>` so smoke tests can assert "this
 * route mounts" without depending on data shapes.
 *
 * Bodies live as small named components inside this file so they
 * stay close to the route table — the router config is the only
 * place that has to know about each route's existence.
 */
function PlaceholderRouteBody(props: {
  routeId: RouteId;
  title: string;
}): React.JSX.Element {
  return (
    <section
      className={`route-${props.routeId.replace(/\./g, "-")}`}
      data-testid={`route-${props.routeId}`}
      data-route-id={props.routeId}
      aria-labelledby={`route-${props.routeId}-title`}
    >
      <h2 id={`route-${props.routeId}-title`}>{props.title}</h2>
      <p>Phase-0 placeholder. Route body wires up in later milestones.</p>
    </section>
  );
}

function AttachRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody routeId="attach" title={ROUTES.attach.title} />
  );
}

function NewSpecRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody routeId="runs.new" title={ROUTES["runs.new"].title} />
  );
}

function SettingsRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody routeId="settings" title={ROUTES.settings.title} />
  );
}

function RunOverviewRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.overview"
      title={ROUTES["run.overview"].title}
    />
  );
}

function RunPhasesRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.phases"
      title={ROUTES["run.phases"].title}
    />
  );
}

function RunTasksRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.tasks"
      title={ROUTES["run.tasks"].title}
    />
  );
}

function TaskDetailRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.taskDetail"
      title={ROUTES["run.taskDetail"].title}
    />
  );
}

function RunApprovalsRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.approvals"
      title={ROUTES["run.approvals"].title}
    />
  );
}

function RunBudgetRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.budget"
      title={ROUTES["run.budget"].title}
    />
  );
}

function RunEvidenceRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.evidence"
      title={ROUTES["run.evidence"].title}
    />
  );
}

function ArtifactDetailRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.artifactDetail"
      title={ROUTES["run.artifactDetail"].title}
    />
  );
}

function RunReleaseRoute(): React.JSX.Element {
  return (
    <PlaceholderRouteBody
      routeId="run.release"
      title={ROUTES["run.release"].title}
    />
  );
}

/**
 * Marker rendered when no route matches. Phase-0 has no "not found"
 * surface in the IA, so we render a minimal labelled section so the
 * renderer can never end up with an empty `<Outlet />` and the smoke
 * suite has something to assert on if a stale URL slips through.
 */
function RouteNotFound(): React.JSX.Element {
  return (
    <section
      className="route-not-found"
      data-testid="route-not-found"
      role="alert"
    >
      <h2>Unknown route</h2>
      <p>
        That URL doesn’t match any phase-0 route. Use the navigation to
        get back to the runs list.
      </p>
    </section>
  );
}

/**
 * The phase-0 route tree. Exported so tests can mount it inside a
 * static or memory router at a chosen location without going through
 * the AttachScreen gating path.
 *
 * Routing decisions:
 *
 *   - The index route (`/`) redirects to `/runs`. There is NO
 *     prototype-style Dashboard; post-attach landing is the runs list
 *     per the IA doc.
 *   - Top-level routes (`/attach`, `/runs`, `/runs/new`, `/settings`)
 *     hang off `<AppShellLayout>`. Drawer + inspector are NOT mounted
 *     by the AppShell — those affordances are run-scoped.
 *   - Run-scoped routes hang off `<RunDetailShellLayout>` at
 *     `/runs/:planId`. The run shell owns the drawer + inspector
 *     providers; their allow-list checks consult
 *     `DRAWER_ALLOWED_ROUTE_IDS` / `INSPECTOR_ALLOWED_ROUTE_IDS`.
 *   - `RunsPlaceholder` is the body of the `/runs` route (it stays a
 *     compatibility export so any downstream consumer that imported it
 *     for its testid keeps working — the M2 router replaced its role
 *     as the post-attach gate).
 */
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShellLayout />}>
        <Route
          index
          element={<Navigate to={POST_ATTACH_LANDING_PATH} replace />}
        />
        <Route path={ROUTES.attach.path} element={<AttachRoute />} />
        <Route path={ROUTES.runs.path} element={<RunsPlaceholder />} />
        <Route path={ROUTES["runs.new"].path} element={<NewSpecRoute />} />
        <Route path={ROUTES.settings.path} element={<SettingsRoute />} />
      </Route>
      <Route path="/runs/:planId" element={<RunDetailShellLayout />}>
        <Route index element={<RunOverviewRoute />} />
        <Route path="phases" element={<RunPhasesRoute />} />
        <Route path="tasks" element={<RunTasksRoute />} />
        <Route path="tasks/:taskId" element={<TaskDetailRoute />} />
        <Route path="approvals" element={<RunApprovalsRoute />} />
        <Route path="budget" element={<RunBudgetRoute />} />
        <Route path="evidence" element={<RunEvidenceRoute />} />
        <Route path="evidence/:artifactId" element={<ArtifactDetailRoute />} />
        <Route path="release" element={<RunReleaseRoute />} />
      </Route>
      <Route path="*" element={<RouteNotFound />} />
    </Routes>
  );
}

/**
 * Default post-attach router wrapper: `<HashRouter>` around
 * {@link AppRoutes}. Pulled out so the JSX in `App` stays readable
 * and so the test override semantics are easy to reason about (pass a
 * function that takes the routes element and returns a wrapped
 * element).
 */
function defaultPostAttachRouter(routes: React.ReactNode): React.JSX.Element {
  return <HashRouter>{routes}</HashRouter>;
}

/**
 * The load-bearing attach gate for the phase-0 router. Keeping it as
 * a named function lets App and tests share the same predicate while
 * preserving the double guard: connected state plus a real pm-go
 * identity envelope.
 */
export function shouldMountPostAttachRouter(
  ctx: Pick<AttachContext, "state" | "envelope">,
): boolean {
  return ctx.state === "connected" && ctx.envelope !== null;
}

export function App({
  bridge,
  initialConfig,
  postAttachRouter = defaultPostAttachRouter,
}: AppProps): React.JSX.Element {
  const [ctx, dispatch] = useReducer(
    reduce,
    initialConfig,
    initContextFromConfig,
  );

  // First-mount auto-probe. If the operator already has a configured
  // base URL, kick the probe off immediately so the UI lands on
  // `connected` (or a failure state) without manual intervention.
  // If `apiBaseUrl` is empty, we stay in `not_configured` — the
  // user has to type a URL and choose Apply.
  useEffect(() => {
    if (initialConfig.apiBaseUrl === "") return;
    void runProbe(bridge, dispatch);
    // The auto-probe runs once per mount with the initial config.
    // Subsequent config changes go through `set_base_url + runProbe`
    // in the AttachScreen's Apply handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The phase-0 router mounts ONLY when the attach machine is in
  // `connected` AND we hold a valid pm-go envelope. Anything short of
  // that (probing, not_configured, foreign_service, api_unreachable,
  // api_error) keeps the renderer on the AttachScreen surface alone.
  const showRouter = shouldMountPostAttachRouter(ctx);

  return (
    <div className="app-root" data-testid="app-root">
      <AttachScreen ctx={ctx} dispatch={dispatch} bridge={bridge} />
      {showRouter ? postAttachRouter(<AppRoutes />) : null}
    </div>
  );
}

/**
 * Re-export the reducer types from this module so consumers can rely
 * on `App.tsx` as the single import surface for the renderer tree.
 */
export type { AttachContext, AttachEvent };
