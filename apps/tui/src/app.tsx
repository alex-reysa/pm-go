import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { Box } from "ink";
import React, { useCallback, useState } from "react";

import type { UUID } from "@pm-go/contracts";

import { ApprovalsScreen } from "./screens/approvals.js";
import { ConfirmModal } from "./components/confirm-modal.js";
import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { ApiError } from "./lib/api.js";
import { TuiRuntimeProvider, type TuiRuntime } from "./lib/context.js";
import type { TuiAction } from "./lib/keybinds.js";
import { PlansListScreen } from "./screens/plans-list.js";
import { PlanDetailScreen } from "./screens/plan-detail.js";
import { ReleaseScreen } from "./screens/release-screen.js";
import { TaskDrawerScreen } from "./screens/task-drawer.js";
import type { PendingAction, PlanSelection, Route } from "./types.js";

/**
 * Top-level app shell. Owns:
 *   - `route` — which screen is mounted
 *   - `pendingAction` — when set, the confirm modal replaces the
 *     screen; operator answers y/n; on confirm, the modal fires the
 *     matching POST via `runtime.api.*`. The modal stays mounted with
 *     a spinner while the POST is in flight; rejects surface as an
 *     inline error inside the modal
 *   - `disabledKinds` — reported by the current screen, rendered by
 *     the footer as dim labels
 *
 * Screens receive narrow callbacks (`onNavigate`, `onBack`,
 * `onRequestAction`) rather than the App's state setters — keeps the
 * screen API the same whether it's rendered by the real App or a
 * test harness.
 */
export function App(props: {
  runtime: TuiRuntime;
  queryClient: QueryClient;
  initialRoute?: Route;
}): React.ReactElement {
  const [route, setRoute] = useState<Route>(
    props.initialRoute ?? { name: "plans" },
  );
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [disabledKinds, setDisabledKinds] = useState<
    ReadonlyArray<TuiAction["kind"]>
  >([]);
  /**
   * Plan-detail cursor lifted here so it survives the modal unmount
   * cycle. Scoped by `planId` so switching plans resets the cursor
   * cleanly — an orphan task id from plan A would otherwise match
   * nothing in plan B's items and silently fall back to index 0.
   */
  const [planDetailSelection, setPlanDetailSelection] = useState<{
    planId: UUID;
    selection: PlanSelection | null;
  } | null>(null);

  const requestAction = useCallback((action: PendingAction) => {
    setModalError(null);
    setPendingAction(action);
  }, []);

  const cancelAction = useCallback(() => {
    if (modalBusy) return;
    setPendingAction(null);
    setModalError(null);
  }, [modalBusy]);

  const confirmAction = useCallback(async () => {
    if (pendingAction === null || modalBusy) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await executeAction(props.runtime, pendingAction);
      setPendingAction(null);
    } catch (err) {
      setModalError(formatActionError(err));
    } finally {
      setModalBusy(false);
    }
  }, [modalBusy, pendingAction, props.runtime]);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    setDisabledKinds([]);
  }, []);

  const handlePlanSelectionChange = useCallback(
    (planId: UUID, selection: PlanSelection | null) => {
      setPlanDetailSelection({ planId, selection });
    },
    [],
  );

  const backToPlans = useCallback(() => navigate({ name: "plans" }), [navigate]);
  const backToPlanDetail = useCallback(
    (planId: UUID) => navigate({ name: "plan", planId }),
    [navigate],
  );

  return (
    <QueryClientProvider client={props.queryClient}>
      <TuiRuntimeProvider runtime={props.runtime}>
        <Box flexDirection="column" height="100%">
          <Header apiBaseUrl={props.runtime.config.apiBaseUrl} route={route} />
          <Box flexDirection="column" flexGrow={1}>
            {pendingAction !== null ? (
              <ConfirmModal
                message={pendingAction.label}
                onConfirm={confirmAction}
                onCancel={cancelAction}
                busy={modalBusy}
                error={modalError}
              />
            ) : (
              renderScreen(
                route,
                backToPlans,
                backToPlanDetail,
                navigate,
                requestAction,
                setDisabledKinds,
                planDetailSelection,
                handlePlanSelectionChange,
              )
            )}
          </Box>
          <Footer disabledKinds={disabledKinds} />
        </Box>
      </TuiRuntimeProvider>
    </QueryClientProvider>
  );
}

function renderScreen(
  route: Route,
  onBackToPlans: () => void,
  onBackToPlanDetail: (planId: UUID) => void,
  onNavigate: (next: Route) => void,
  onRequestAction: (action: PendingAction) => void,
  onDisabledKindsChange: (
    kinds: ReadonlyArray<TuiAction["kind"]>,
  ) => void,
  planDetailSelection: { planId: UUID; selection: PlanSelection | null } | null,
  onPlanSelectionChange: (planId: UUID, selection: PlanSelection | null) => void,
): React.ReactElement {
  switch (route.name) {
    case "plans":
      return (
        <PlansListScreen
          onSelect={(planId: UUID) => onNavigate({ name: "plan", planId })}
        />
      );
    case "plan": {
      // Only replay the selection when it belongs to the plan we're
      // about to render — orphan selections from a different plan are
      // ignored so the cursor starts at index 0.
      const initial =
        planDetailSelection !== null &&
        planDetailSelection.planId === route.planId
          ? planDetailSelection.selection
          : null;
      return (
        <PlanDetailScreen
          planId={route.planId}
          onBack={onBackToPlans}
          onNavigate={onNavigate}
          onRequestAction={onRequestAction}
          onDisabledKindsChange={onDisabledKindsChange}
          initialSelection={initial}
          onSelectionChange={onPlanSelectionChange}
        />
      );
    }
    case "task":
      return (
        <TaskDrawerScreen
          planId={route.planId}
          taskId={route.taskId}
          onBack={() => onBackToPlanDetail(route.planId)}
          onNavigate={onNavigate}
          onRequestAction={onRequestAction}
        />
      );
    case "release":
      return (
        <ReleaseScreen
          planId={route.planId}
          onBack={() => onBackToPlanDetail(route.planId)}
          onRequestAction={onRequestAction}
        />
      );
    case "approvals":
      return (
        <ApprovalsScreen
          planId={route.planId}
          onBack={() => onBackToPlanDetail(route.planId)}
          onRequestAction={onRequestAction}
        />
      );
    default:
      return assertNever(route);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable route variant: ${JSON.stringify(value)}`);
}

async function executeAction(
  runtime: TuiRuntime,
  action: PendingAction,
): Promise<void> {
  switch (action.kind) {
    case "run-task":
      await runtime.api.runTask(action.taskId);
      return;
    case "review-task":
      await runtime.api.reviewTask(action.taskId);
      return;
    case "fix-task":
      await runtime.api.fixTask(action.taskId);
      return;
    case "integrate-phase":
      await runtime.api.integratePhase(action.phaseId);
      return;
    case "audit-phase":
      await runtime.api.auditPhase(action.phaseId);
      return;
    case "complete-plan":
      await runtime.api.completePlan(action.planId);
      return;
    case "release-plan":
      await runtime.api.releasePlan(action.planId);
      return;
    case "approve-task":
      await runtime.api.approveTask(action.taskId);
      return;
    case "approve-plan":
      await runtime.api.approvePlan(action.planId);
      return;
  }
}

function formatActionError(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
