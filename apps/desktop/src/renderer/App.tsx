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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import {
  ApiError,
  createDesktopApiClient,
  type DesktopApiClient,
} from "./api/index.js";
import type { PmGoDesktopBridge } from "./bridge.js";
import {
  approvalsHappyPath,
  artifactDetailHappyPath,
  budgetHappyPath,
  evidenceHappyPath,
  releaseHappyPath,
} from "./fixtures/index.js";
import {
  AppShell,
  LiveDataProvider,
  RunDetailShell,
  type LiveApiError,
  type LiveDataContextValue,
  type LiveResourceState,
  type LiveRunEndpoint,
  type LiveRunEndpointErrors,
  type LiveRunResource,
  type LiveRunsResource,
} from "./layout/index.js";
import {
  buildApprovals,
  buildArtifactEvidence,
  buildBudgetSnapshot,
  buildEventReplay,
  buildPhases,
  buildReleaseReadiness,
  buildRunCockpit,
  buildRunSummaries,
  buildTaskSummaries,
  type ApprovalRequest,
  type BudgetReport,
  type PhaseListItem,
  type PlanDetailPayload,
  type ReadModelEnvelope,
  type PlanListItem,
  type RecoverableReadError,
  type TaskListItem,
  type WorkflowEvent,
} from "./read-models/index.js";
import {
  ALL_ROUTES,
  ROUTES,
  type RouteId,
} from "./router/index.js";
import { Approvals } from "./routes/Approvals.js";
import { ArtifactDetail } from "./routes/ArtifactDetail.js";
import { Budget } from "./routes/Budget.js";
import { Evidence } from "./routes/Evidence.js";
import { NewSpec } from "./routes/NewSpec.js";
import { PlanPhases } from "./routes/PlanPhases.js";
import { Release } from "./routes/Release.js";
import { RunOverview } from "./routes/RunOverview.js";
import { RunsList } from "./routes/RunsList.js";
import { Settings } from "./routes/Settings.js";
import { TaskDetail } from "./routes/TaskDetail.js";
import { Tasks } from "./routes/Tasks.js";

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

export interface AppRoutesProps {
  readonly bridge: PmGoDesktopBridge;
  readonly apiBaseUrl?: string;
}

type EndpointResult<T> = { ok: true; data: T } | { ok: false; error: LiveApiError };

export interface LiveRunSnapshot
  extends Omit<LiveRunResource, "isLoading" | "isRefreshing" | "refresh"> {}

interface LiveRunsSnapshot
  extends Omit<LiveRunsResource, "isLoading" | "isRefreshing" | "refresh"> {}

interface StoredLiveRunsResource extends LiveRunsSnapshot {
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
}

export interface StoredLiveRunResource extends LiveRunSnapshot {
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
}

const DISABLED_LIVE_RUNS: StoredLiveRunsResource = {
  state: "disabled",
  isLoading: false,
  isRefreshing: false,
  data: [],
  errors: [],
  lastUpdatedAt: null,
};

function disabledLiveRun(planId: string): StoredLiveRunResource {
  return {
    planId,
    state: "disabled",
    isLoading: false,
    isRefreshing: false,
    errors: [],
    endpointErrors: {},
    lastUpdatedAt: null,
    cockpit: null,
    phases: null,
    tasks: null,
    approvals: null,
    budget: null,
    events: null,
    evidence: null,
    release: null,
  };
}

function loadingLiveRun(planId: string): StoredLiveRunResource {
  return {
    ...disabledLiveRun(planId),
    state: "loading",
    isLoading: true,
  };
}

/**
 * Build the reducer's initial context from an `AppProps.initialConfig`.
 * Extracted as a named function so the `useReducer` initializer
 * argument is a stable reference even across re-renders.
 */
function initContextFromConfig(config: Config): AttachContext {
  return initialContext(config);
}

function classifyLiveErrorStatus(status: number): LiveApiError["kind"] {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500 || status === 0) return "server_error";
  return "error";
}

function errorMessageForKind(kind: LiveApiError["kind"]): string {
  switch (kind) {
    case "forbidden":
      return "The API refused access to this resource.";
    case "conflict":
      return "The API reported a conflict with the current workflow state.";
    case "not_found":
      return "The requested live resource was not found.";
    case "server_error":
      return "The API returned a server error.";
    case "error":
      return "The live API request failed.";
  }
}

function liveErrorFromUnknown(err: unknown): LiveApiError {
  if (err instanceof ApiError) {
    const kind = classifyLiveErrorStatus(err.status);
    return {
      status: err.status,
      message: err.message || errorMessageForKind(kind),
      ...(err.body !== undefined ? { body: err.body } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
      kind,
    };
  }
  const message =
    err instanceof Error && err.message.trim() !== ""
      ? err.message
      : "Unable to read live API data.";
  return {
    status: 0,
    message,
    kind: "server_error",
  };
}

function recoverableError(error: LiveApiError): RecoverableReadError {
  return {
    status: error.status,
    message: error.message,
    ...(error.body !== undefined ? { body: error.body } : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
  };
}

async function readEndpoint<T>(read: () => Promise<T>): Promise<EndpointResult<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (err) {
    return { ok: false, error: liveErrorFromUnknown(err) };
  }
}

function firstError(results: readonly EndpointResult<unknown>[]): LiveApiError | undefined {
  return results.find((result): result is { ok: false; error: LiveApiError } => !result.ok)
    ?.error;
}

function endpointErrorsFrom(
  entries: readonly [LiveRunEndpoint, EndpointResult<unknown>][],
): LiveRunEndpointErrors {
  const endpointErrors: Partial<Record<LiveRunEndpoint, readonly LiveApiError[]>> = {};
  for (const [endpoint, result] of entries) {
    if (!result.ok) {
      endpointErrors[endpoint] = [result.error];
    }
  }
  return endpointErrors;
}

function hasEndpointError(
  endpointErrors: LiveRunEndpointErrors,
  endpoint: LiveRunEndpoint,
): boolean {
  return (endpointErrors[endpoint]?.length ?? 0) > 0;
}

function hasAnyEndpointError(
  endpointErrors: LiveRunEndpointErrors,
  endpoints: readonly LiveRunEndpoint[],
): boolean {
  return endpoints.some((endpoint) => hasEndpointError(endpointErrors, endpoint));
}

function stateFromErrorsAndData(
  errors: readonly LiveApiError[],
  hasData: boolean,
  emptyWhenNoError: boolean,
): LiveResourceState {
  if (errors.length > 0) {
    return hasData ? "partial" : (errors[0]?.kind ?? "error");
  }
  return emptyWhenNoError ? "empty" : "ready";
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function readLiveRunsSnapshot(
  api: DesktopApiClient,
): Promise<LiveRunsSnapshot> {
  const result = await readEndpoint<readonly PlanListItem[]>(async () => api.listPlans());
  if (!result.ok) {
    return {
      state: result.error.kind,
      data: [],
      errors: [result.error],
      lastUpdatedAt: null,
    };
  }

  const runs = buildRunSummaries({ plans: result.data });
  return {
    state: runs.data.length === 0 ? "empty" : "ready",
    data: runs.data,
    errors: [],
    lastUpdatedAt: nowIso(),
  };
}

export async function readLiveRunSnapshot(
  api: DesktopApiClient,
  planId: string,
): Promise<LiveRunSnapshot> {
  const planResult = await readEndpoint<PlanDetailPayload>(() => api.getPlan(planId));
  if (!planResult.ok) {
    const error = planResult.error;
    const recoverable = recoverableError(error);
    return {
      planId,
      state: error.kind,
      errors: [error],
      endpointErrors: { plan: [error] },
      lastUpdatedAt: null,
      cockpit: buildRunCockpit({ error: recoverable }),
      phases: buildPhases({ error: recoverable }),
      tasks: buildTaskSummaries({ error: recoverable }),
      approvals: buildApprovals({ error: recoverable }),
      budget: buildBudgetSnapshot({ error: recoverable }),
      events: buildEventReplay({ error: recoverable }),
      evidence: buildArtifactEvidence({ planId, error: recoverable }),
      release: buildReleaseReadiness({ planId, error: recoverable }),
    };
  }

  const planDetail = planResult.data;
  const [phasesResult, tasksResult, approvalsResult, budgetResult, eventsResult] =
    await Promise.all([
      readEndpoint<readonly PhaseListItem[]>(async () => api.listPhases(planId)),
      readEndpoint<readonly TaskListItem[]>(async () => api.listTasks({ planId })),
      readEndpoint<readonly ApprovalRequest[]>(async () => api.listApprovals(planId)),
      readEndpoint<BudgetReport>(async () => api.getBudgetReport(planId)),
      readEndpoint<readonly WorkflowEvent[]>(async () => (await api.replayEvents(planId)).events),
    ]);

  const errors = [
    phasesResult,
    tasksResult,
    approvalsResult,
    budgetResult,
    eventsResult,
  ].flatMap((result) => (result.ok ? [] : [result.error]));
  const endpointErrors = endpointErrorsFrom([
    ["phases", phasesResult],
    ["tasks", tasksResult],
    ["approvals", approvalsResult],
    ["budget", budgetResult],
    ["events", eventsResult],
  ]);
  const primaryError = firstError([
    phasesResult,
    tasksResult,
    approvalsResult,
    budgetResult,
    eventsResult,
  ]);
  const primaryRecoverable =
    primaryError === undefined ? undefined : recoverableError(primaryError);
  const phases = phasesResult.ok ? phasesResult.data : undefined;
  const tasks = tasksResult.ok ? tasksResult.data : undefined;
  const approvals = approvalsResult.ok ? approvalsResult.data : undefined;
  const budget = budgetResult.ok ? budgetResult.data : undefined;
  const events = eventsResult.ok ? eventsResult.data : undefined;
  const eventReplayError =
    eventsResult.ok ? undefined : recoverableError(eventsResult.error);

  const phaseModels = buildPhases({
    planDetail,
    ...(phases !== undefined ? { phases } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(!phasesResult.ok ? { error: recoverableError(phasesResult.error) } : {}),
  });
  const taskModels = buildTaskSummaries({
    ...(tasks !== undefined ? { tasks } : {}),
    ...(phases !== undefined ? { phases } : {}),
    ...(approvals !== undefined ? { approvals } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(!tasksResult.ok ? { error: recoverableError(tasksResult.error) } : {}),
  });
  const eventModels = buildEventReplay({
    ...(events !== undefined ? { events } : {}),
    phases: phaseModels.data,
    tasks: taskModels.data,
    ...(!eventsResult.ok ? { error: recoverableError(eventsResult.error) } : {}),
  });
  const release = buildReleaseReadiness({
    planId,
    planDetail,
    ...(events !== undefined ? { events } : {}),
    ...(eventReplayError !== undefined ? { error: eventReplayError } : {}),
  });
  const cockpit = buildRunCockpit({
    planDetail,
    ...(phases !== undefined ? { phases } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(approvals !== undefined ? { approvals } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(primaryRecoverable !== undefined ? { error: primaryRecoverable } : {}),
  });
  const budgetSnapshot = buildBudgetSnapshot({
    ...(budget !== undefined ? { budget } : {}),
    tasks: taskModels.data,
    ...(!budgetResult.ok ? { error: recoverableError(budgetResult.error) } : {}),
  });
  const approvalsModel = buildApprovals({
    ...(approvals !== undefined ? { approvals } : {}),
    tasks: taskModels.data,
    phases: phaseModels.data,
    ...(!approvalsResult.ok ? { error: recoverableError(approvalsResult.error) } : {}),
  });
  const evidence = buildArtifactEvidence({
    planId,
    artifactIds: planDetail.artifactIds,
    planDetail,
    ...(events !== undefined ? { events } : {}),
    ...(eventReplayError !== undefined ? { error: eventReplayError } : {}),
  });

  return {
    planId,
    state: stateFromErrorsAndData(errors, cockpit.data !== null, false),
    errors,
    endpointErrors,
    lastUpdatedAt: nowIso(),
    cockpit,
    phases: phaseModels,
    tasks: taskModels,
    approvals: approvalsModel,
    budget: budgetSnapshot,
    events: eventModels,
    evidence,
    release,
  };
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

function AttachRoute(): React.JSX.Element {
  return (
    <section
      className="route-attach"
      data-testid="route-attach"
      data-route-id="attach"
      aria-labelledby="route-attach-title"
    >
      <h2 id="route-attach-title">{ROUTES.attach.title}</h2>
      <p>
        Attach status and API configuration remain available above the router.
      </p>
    </section>
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

function mergeRunsSnapshot(
  previous: StoredLiveRunsResource,
  next: LiveRunsSnapshot,
): StoredLiveRunsResource {
  const data =
    next.data.length === 0 && next.errors.length > 0 && previous.data.length > 0
      ? previous.data
      : next.data;
  return {
    ...next,
    data,
    state: next.errors.length > 0 && data.length > 0 ? "partial" : next.state,
    lastUpdatedAt: next.lastUpdatedAt ?? previous.lastUpdatedAt,
    isLoading: false,
    isRefreshing: false,
  };
}

function preserveEnvelopeOnError<T>(
  previous: ReadModelEnvelope<T> | null,
  next: ReadModelEnvelope<T> | null,
  preservePrevious: boolean,
): ReadModelEnvelope<T> | null {
  if (preservePrevious && previous !== null) {
    return previous;
  }
  if (next === null || next.state !== "error") {
    return next;
  }
  return previous ?? next;
}

export function mergeRunSnapshot(
  previous: StoredLiveRunResource | undefined,
  next: LiveRunSnapshot,
): StoredLiveRunResource {
  if (previous === undefined) {
    return { ...next, isLoading: false, isRefreshing: false };
  }

  const planInputFailed = hasEndpointError(next.endpointErrors, "plan");
  const cockpitInputFailed = hasAnyEndpointError(next.endpointErrors, [
    "plan",
    "phases",
    "tasks",
    "approvals",
    "budget",
    "events",
  ]);
  const phasesInputFailed =
    planInputFailed || hasAnyEndpointError(next.endpointErrors, ["phases", "tasks"]);
  const tasksInputFailed =
    planInputFailed ||
    hasAnyEndpointError(next.endpointErrors, ["tasks", "phases", "approvals", "budget"]);
  const approvalsInputFailed =
    planInputFailed ||
    hasAnyEndpointError(next.endpointErrors, ["approvals", "tasks", "phases"]);
  const budgetInputFailed =
    planInputFailed || hasAnyEndpointError(next.endpointErrors, ["budget", "tasks"]);
  const eventsInputFailed = planInputFailed || hasEndpointError(next.endpointErrors, "events");
  const hasPreviousCockpit = previous.cockpit !== null && previous.cockpit.data !== null;
  const hasFreshCockpit =
    !cockpitInputFailed && next.cockpit !== null && next.cockpit.data !== null;
  const cockpit =
    cockpitInputFailed && hasPreviousCockpit
      ? previous.cockpit
      : hasFreshCockpit
        ? next.cockpit
        : (previous.cockpit ?? next.cockpit);
  if (next.errors.length === 0) {
    return { ...next, isLoading: false, isRefreshing: false };
  }

  return {
    ...next,
    state:
      cockpit !== null && cockpit.data !== null ? "partial" : next.state,
    lastUpdatedAt: next.lastUpdatedAt ?? previous.lastUpdatedAt,
    cockpit,
    phases: preserveEnvelopeOnError(previous.phases, next.phases, phasesInputFailed),
    tasks: preserveEnvelopeOnError(previous.tasks, next.tasks, tasksInputFailed),
    approvals: preserveEnvelopeOnError(
      previous.approvals,
      next.approvals,
      approvalsInputFailed,
    ),
    budget: preserveEnvelopeOnError(previous.budget, next.budget, budgetInputFailed),
    events: preserveEnvelopeOnError(previous.events, next.events, eventsInputFailed),
    evidence: preserveEnvelopeOnError(previous.evidence, next.evidence, eventsInputFailed),
    release: preserveEnvelopeOnError(previous.release, next.release, eventsInputFailed),
    isLoading: false,
    isRefreshing: false,
  };
}

function liveRunsResource(
  stored: StoredLiveRunsResource,
  refresh: () => void,
): LiveRunsResource {
  return { ...stored, refresh };
}

function liveRunResource(
  stored: StoredLiveRunResource,
  refresh: () => void,
): LiveRunResource {
  return { ...stored, refresh };
}

function useLiveDataController(apiBaseUrl?: string): LiveDataContextValue | null {
  const hasLiveApi = apiBaseUrl !== undefined && apiBaseUrl.trim() !== "";
  const clientResult = useMemo<
    | { client: DesktopApiClient; error: null }
    | { client: null; error: LiveApiError | null }
  >(() => {
    if (!hasLiveApi) return { client: null, error: null };
    try {
      return {
        client: createDesktopApiClient({ baseUrl: apiBaseUrl ?? "" }),
        error: null,
      };
    } catch (err) {
      return { client: null, error: liveErrorFromUnknown(err) };
    }
  }, [apiBaseUrl, hasLiveApi]);

  const [runs, setRuns] = useState<StoredLiveRunsResource>(DISABLED_LIVE_RUNS);
  const [runResources, setRunResources] = useState<
    Readonly<Record<string, StoredLiveRunResource>>
  >({});
  const runResourcesRef = useRef(runResources);
  const runsRequestId = useRef(0);
  const runRequestIds = useRef<Record<string, number>>({});

  useEffect(() => {
    runResourcesRef.current = runResources;
  }, [runResources]);

  const refreshRuns = useCallback(() => {
    if (!hasLiveApi) return;
    if (clientResult.client === null) {
      const error =
        clientResult.error ??
        liveErrorFromUnknown(new Error("API base URL is not configured."));
      setRuns({
        ...DISABLED_LIVE_RUNS,
        state: error.kind,
        errors: [error],
      });
      return;
    }

    const requestId = runsRequestId.current + 1;
    runsRequestId.current = requestId;
    setRuns((previous) => ({
      ...previous,
      state: "loading",
      isLoading: previous.data.length === 0,
      isRefreshing: previous.data.length > 0,
    }));

    void readLiveRunsSnapshot(clientResult.client).then((snapshot) => {
      if (runsRequestId.current !== requestId) return;
      setRuns((previous) => mergeRunsSnapshot(previous, snapshot));
    });
  }, [clientResult.client, clientResult.error, hasLiveApi]);

  const refreshRun = useCallback(
    (planId: string) => {
      if (!hasLiveApi) return;
      if (clientResult.client === null) {
        const error =
          clientResult.error ??
          liveErrorFromUnknown(new Error("API base URL is not configured."));
        setRunResources((previous) => ({
          ...previous,
          [planId]: {
            ...disabledLiveRun(planId),
            state: error.kind,
            errors: [error],
            endpointErrors: { plan: [error] },
          },
        }));
        return;
      }

      const requestId = (runRequestIds.current[planId] ?? 0) + 1;
      runRequestIds.current = { ...runRequestIds.current, [planId]: requestId };
      const existingForRef = runResourcesRef.current[planId] ?? loadingLiveRun(planId);
      runResourcesRef.current = {
        ...runResourcesRef.current,
        [planId]: {
          ...existingForRef,
          state: "loading",
          isLoading: existingForRef.cockpit === null || existingForRef.cockpit.data === null,
          isRefreshing:
            existingForRef.cockpit !== null && existingForRef.cockpit.data !== null,
        },
      };
      setRunResources((previous) => {
        const existing = previous[planId] ?? loadingLiveRun(planId);
        return {
          ...previous,
          [planId]: {
            ...existing,
            state: "loading",
            isLoading: existing.cockpit === null || existing.cockpit.data === null,
            isRefreshing: existing.cockpit !== null && existing.cockpit.data !== null,
          },
        };
      });

      void readLiveRunSnapshot(clientResult.client, planId).then((snapshot) => {
        if (runRequestIds.current[planId] !== requestId) return;
        setRunResources((previous) => ({
          ...previous,
          [planId]: mergeRunSnapshot(previous[planId], snapshot),
        }));
      });
    },
    [clientResult.client, clientResult.error, hasLiveApi],
  );

  const ensureRun = useCallback(
    (planId: string) => {
      if (!hasLiveApi) return;
      if (runResourcesRef.current[planId] !== undefined) return;
      refreshRun(planId);
    },
    [hasLiveApi, refreshRun],
  );

  const getRun = useCallback(
    (planId: string): LiveRunResource => {
      const stored =
        runResources[planId] ??
        (hasLiveApi ? loadingLiveRun(planId) : disabledLiveRun(planId));
      return liveRunResource(stored, () => refreshRun(planId));
    },
    [hasLiveApi, refreshRun, runResources],
  );

  useEffect(() => {
    setRunResources({});
    runResourcesRef.current = {};
    runRequestIds.current = {};
    if (!hasLiveApi) {
      setRuns(DISABLED_LIVE_RUNS);
      return;
    }
    if (clientResult.error !== null) {
      setRuns({
        ...DISABLED_LIVE_RUNS,
        state: clientResult.error.kind,
        errors: [clientResult.error],
      });
      return;
    }
    refreshRuns();
  }, [apiBaseUrl, clientResult.error, hasLiveApi, refreshRuns]);

  return useMemo<LiveDataContextValue | null>(() => {
    if (!hasLiveApi) return null;
    return {
      runs: liveRunsResource(runs, refreshRuns),
      getRun,
      ensureRun,
      refreshRun,
    };
  }, [ensureRun, getRun, hasLiveApi, refreshRun, refreshRuns, runs]);
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
 *     fixture-driven route body. The legacy RunsPlaceholder export
 *     remains for compatibility, but the shell no longer mounts it.
 */
export function AppRoutes({ bridge, apiBaseUrl }: AppRoutesProps): React.JSX.Element {
  const liveData = useLiveDataController(apiBaseUrl);

  return (
    <LiveDataProvider value={liveData}>
      <Routes>
        <Route element={<AppShellLayout />}>
          <Route
            index
            element={<Navigate to={POST_ATTACH_LANDING_PATH} replace />}
          />
          <Route path={ROUTES.attach.path} element={<AttachRoute />} />
          <Route path={ROUTES.runs.path} element={<RunsList />} />
          <Route path={ROUTES["runs.new"].path} element={<NewSpec />} />
          <Route
            path={ROUTES.settings.path}
            element={<Settings bridge={bridge} />}
          />
          <Route path="/runs/:planId" element={<RunDetailShellLayout />}>
            <Route index element={<RunOverview />} />
            <Route path="phases" element={<PlanPhases />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:taskId" element={<TaskDetail />} />
            <Route
              path="approvals"
              element={<Approvals dataset={approvalsHappyPath} />}
            />
            <Route path="budget" element={<Budget dataset={budgetHappyPath} />} />
            <Route
              path="evidence"
              element={<Evidence dataset={evidenceHappyPath} />}
            />
            <Route
              path="evidence/:artifactId"
              element={<ArtifactDetail dataset={artifactDetailHappyPath} />}
            />
            <Route
              path="release"
              element={<Release dataset={releaseHappyPath} />}
            />
          </Route>
        </Route>
        <Route path="*" element={<RouteNotFound />} />
      </Routes>
    </LiveDataProvider>
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
      {showRouter ? (
        postAttachRouter(<AppRoutes bridge={bridge} apiBaseUrl={ctx.baseUrl} />)
      ) : null}
    </div>
  );
}

/**
 * Re-export the reducer types from this module so consumers can rely
 * on `App.tsx` as the single import surface for the renderer tree.
 */
export type { AttachContext, AttachEvent };
