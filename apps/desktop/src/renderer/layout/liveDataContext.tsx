import React, { useContext, useEffect } from "react";

import type {
  ReadModelEnvelope,
  ApprovalQueueItemViewModel,
  BudgetSnapshotViewModel,
  EventItemViewModel,
  EvidenceBundleViewModel,
  PhaseViewModel,
  ReleaseReadinessViewModel,
  RunCockpitViewModel,
  RunSummaryViewModel,
  TaskSummaryViewModel,
} from "../read-models/index.js";

export type LiveResourceState =
  | "disabled"
  | "loading"
  | "ready"
  | "empty"
  | "partial"
  | "forbidden"
  | "conflict"
  | "not_found"
  | "server_error"
  | "error";

export interface LiveApiError {
  readonly status: number;
  readonly message: string;
  readonly body?: unknown;
  readonly requestId?: string;
  readonly kind: Exclude<
    LiveResourceState,
    "disabled" | "loading" | "ready" | "empty" | "partial"
  >;
}

export interface LiveRunsResource {
  readonly state: LiveResourceState;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly data: readonly RunSummaryViewModel[];
  readonly errors: readonly LiveApiError[];
  readonly lastUpdatedAt: string | null;
  readonly refresh: () => void;
}

export interface LiveRunResource {
  readonly planId: string;
  readonly state: LiveResourceState;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly errors: readonly LiveApiError[];
  readonly lastUpdatedAt: string | null;
  readonly cockpit: ReadModelEnvelope<RunCockpitViewModel | null> | null;
  readonly phases: ReadModelEnvelope<PhaseViewModel[]> | null;
  readonly tasks: ReadModelEnvelope<TaskSummaryViewModel[]> | null;
  readonly approvals: ReadModelEnvelope<ApprovalQueueItemViewModel[]> | null;
  readonly budget: ReadModelEnvelope<BudgetSnapshotViewModel | null> | null;
  readonly events: ReadModelEnvelope<EventItemViewModel[]> | null;
  readonly evidence: ReadModelEnvelope<EvidenceBundleViewModel> | null;
  readonly release: ReadModelEnvelope<ReleaseReadinessViewModel> | null;
  readonly refresh: () => void;
}

export interface LiveDataContextValue {
  readonly runs: LiveRunsResource;
  readonly getRun: (planId: string) => LiveRunResource;
  readonly ensureRun: (planId: string) => void;
  readonly refreshRun: (planId: string) => void;
}

const LiveDataContext = React.createContext<LiveDataContextValue | null>(null);

export interface LiveDataProviderProps {
  readonly value: LiveDataContextValue | null;
  readonly children: React.ReactNode;
}

export function LiveDataProvider({
  value,
  children,
}: LiveDataProviderProps): React.JSX.Element {
  return (
    <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>
  );
}

export function useLiveData(): LiveDataContextValue | null {
  return useContext(LiveDataContext);
}

export function useLiveRuns(): LiveRunsResource | null {
  return useLiveData()?.runs ?? null;
}

export function useLiveRun(planId: string | undefined): LiveRunResource | null {
  const value = useLiveData();
  const ensureRun = value?.ensureRun;

  useEffect(() => {
    if (planId === undefined || planId === "") return;
    ensureRun?.(planId);
  }, [ensureRun, planId]);

  if (value === null || planId === undefined || planId === "") return null;
  return value.getRun(planId);
}
