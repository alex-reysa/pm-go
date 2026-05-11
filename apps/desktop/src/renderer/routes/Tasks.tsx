/**
 * Tasks route.
 *
 * Shows the per-plan task rows grouped by phase, with a simple
 * status filter. Filter state is local `useState`; M3 can lift it
 * to query-string state later when the route's filter URLs need to
 * be shareable.
 *
 * The route ALSO mounts inside `RunDetailShell` which owns the
 * collapsed event drawer affordance — this component only renders
 * the body. We do not import the drawer toggle directly.
 *
 * The route keeps fixture props as a static-render fallback, then
 * hydrates the selected run through the Desktop API client when a
 * `:planId` route param is available.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  ApiConfigurationError,
  ApiError,
  createDesktopApiClientFromConfig,
  type DesktopApiClient,
} from "../api/index.js";
import { RightInspector } from "../layout/RightInspector.js";
import { useRightInspector } from "../layout/inspectorContext.js";
import {
  buildTaskSummaries,
  type LimitedValue,
  type PhaseListItem,
  type ReadModelEnvelope,
  type RecoverableReadError,
  type TaskListItem,
  type TaskSummaryViewModel,
} from "../read-models/index.js";
import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type PhasesList,
  type TaskSummary as FixtureTaskSummary,
  type TaskStatus,
  type TasksList,
  phasesHappyPath,
  tasksHappyPath,
} from "../fixtures/index.js";
import { pathForTaskDetail } from "../router/routes.js";

/**
 * Status filter sentinel: `"all"` means no filter. The other values
 * mirror `TaskStatus` literals exactly so the filter `<select>` can
 * use them as `option` values.
 */
type StatusFilter = "all" | TaskStatus;

const STATUS_FILTER_OPTIONS: readonly StatusFilter[] = [
  "all",
  "pending",
  "ready",
  "running",
  "in_review",
  "fixing",
  "ready_to_merge",
  "merged",
  "blocked",
  "failed",
];

export interface TasksProps {
  /**
   * Tasks dataset. Defaults to the happy-path fixture; tests swap
   * in `tasksEmptyState` / `tasksErrorState` to exercise the empty
   * and error envelope variants.
   */
  readonly tasksDataset?: FixtureDataset<TasksList>;
  /**
   * Phases dataset (used to label the per-phase groups). Defaults to
   * the happy-path phases fixture; tests can pass an empty list to
   * exercise the "no phases" rendering.
   */
  readonly phasesDataset?: FixtureDataset<PhasesList>;
  /**
   * Optional initial status filter for tests. Production callers
   * leave this unset; the route defaults to `"all"` on mount.
   */
  readonly initialStatusFilter?: StatusFilter;
  /** Optional API client override for route-level tests. */
  readonly apiClient?: DesktopApiClient;
  /** Optional selected-run override; production uses the `:planId` route param. */
  readonly planId?: string;
}

type TaskRow = FixtureTaskSummary | TaskSummaryViewModel;

interface LiveTasksState {
  readonly loading: boolean;
  readonly envelope: ReadModelEnvelope<TaskSummaryViewModel[], readonly TaskListItem[]> | null;
  readonly phases: readonly PhaseListItem[] | null;
  readonly errors: readonly RecoverableReadError[];
}

/**
 * Group an unfiltered task list by phase id. Returns the order
 * driven by `phaseIdsInOrder` so the page reads in phase dependency
 * order. Tasks whose phase is missing from the order list land in a
 * trailing "orphan" group so they're never silently dropped.
 */
function groupTasksByPhase(
  tasks: readonly TaskRow[],
  phaseIdsInOrder: readonly string[],
): Array<{ phaseId: string; tasks: TaskRow[] }> {
  const byPhase = new Map<string, TaskRow[]>();
  for (const phaseId of phaseIdsInOrder) {
    byPhase.set(phaseId, []);
  }
  const orphans: TaskRow[] = [];
  for (const task of tasks) {
    const bucket = byPhase.get(task.phaseId);
    if (bucket === undefined) {
      orphans.push(task);
      continue;
    }
    bucket.push(task);
  }
  const groups: Array<{ phaseId: string; tasks: TaskRow[] }> = [];
  for (const phaseId of phaseIdsInOrder) {
    groups.push({ phaseId, tasks: byPhase.get(phaseId) ?? [] });
  }
  if (orphans.length > 0) {
    groups.push({ phaseId: "__orphan__", tasks: orphans });
  }
  return groups;
}

function isLimitedValue<T>(
  value: T | LimitedValue<T>,
): value is LimitedValue<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "limitations" in value
  );
}

function limitedValue<T>(value: T | LimitedValue<T>): T | null {
  return isLimitedValue(value) ? value.value : value;
}

function describeTaskRow(task: TaskRow): string {
  const review = limitedValue(task.reviewState) ?? "no review yet";
  const approval = limitedValue(task.approvalStatus) ?? "no approval gate";
  return `Review: ${review} · Approval: ${approval}`;
}

async function getDesktopApiClient(
  override: DesktopApiClient | undefined,
): Promise<DesktopApiClient> {
  if (override !== undefined) return override;
  if (typeof window === "undefined" || window.pmGoDesktop === undefined) {
    throw new ApiConfigurationError("Desktop bridge is unavailable.");
  }
  return createDesktopApiClientFromConfig(await window.pmGoDesktop.getConfig());
}

function recoverableErrorFromUnknown(error: unknown): RecoverableReadError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      message: error.message,
      body: error.body,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      raw: error,
    };
  }
  if (error instanceof Error) {
    return { status: 0, message: error.message, raw: error };
  }
  return { status: 0, message: "Unknown Desktop API error.", raw: error };
}

function formatReadError(error: RecoverableReadError): string {
  const recoverable =
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status >= 500;
  const label = recoverable ? "Recoverable API read failed" : "API read failed";
  return `${label} (HTTP ${error.status}): ${error.message}`;
}

function TaskInspectorBody({
  task,
}: {
  readonly task: TaskRow;
}): React.JSX.Element {
  const branchName = limitedValue(task.branchName);
  return (
    <div
      className="tasks__inspector"
      data-testid={`tasks-inspector-${task.id}`}
    >
      <p className="tasks__inspector-title">{task.title}</p>
      <p className="tasks__inspector-status">
        {`${task.slug} · ${task.status} · ${task.riskLevel} risk`}
      </p>
      <p className="tasks__inspector-review">{describeTaskRow(task)}</p>
      {branchName !== null ? (
        <p className="tasks__inspector-branch">
          {`Branch: ${branchName}`}
        </p>
      ) : null}
    </div>
  );
}

export function Tasks(props: TasksProps): React.JSX.Element {
  const tasksDataset = props.tasksDataset ?? tasksHappyPath;
  const phasesDataset = props.phasesDataset ?? phasesHappyPath;
  const routeParams = useParams();
  const planId = props.planId ?? routeParams.planId ?? null;
  const inspector = useRightInspector();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    props.initialStatusFilter ?? "all",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveTasksState>({
    loading: false,
    envelope: null,
    phases: null,
    errors: [],
  });

  useEffect(() => {
    if (planId === null) return;
    let cancelled = false;
    setLiveState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const api = await getDesktopApiClient(props.apiClient);
        const [tasksResult, phasesResult] = await Promise.allSettled([
          api.listTasks({ planId }),
          api.listPhases(planId),
        ]);
        if (cancelled) return;

        const tasksError =
          tasksResult.status === "rejected"
            ? recoverableErrorFromUnknown(tasksResult.reason)
            : null;
        const phasesError =
          phasesResult.status === "rejected"
            ? recoverableErrorFromUnknown(phasesResult.reason)
            : null;
        const tasks =
          tasksResult.status === "fulfilled" ? tasksResult.value : undefined;
        const phases =
          phasesResult.status === "fulfilled" ? phasesResult.value : null;
        const firstError = tasksError ?? phasesError ?? undefined;
        const envelope = buildTaskSummaries({
          ...(tasks !== undefined ? { tasks } : {}),
          ...(phases !== null ? { phases } : {}),
          ...(firstError !== undefined ? { error: firstError } : {}),
        });

        setLiveState({
          loading: false,
          envelope,
          phases,
          errors: [tasksError, phasesError].filter(
            (error): error is RecoverableReadError => error !== null,
          ),
        });
      } catch (error) {
        if (cancelled) return;
        const readError = recoverableErrorFromUnknown(error);
        setLiveState({
          loading: false,
          envelope: buildTaskSummaries({ error: readError }),
          phases: null,
          errors: [readError],
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [planId, props.apiClient]);

  const hasLiveRead = liveState.envelope !== null || liveState.loading;
  const tasks: readonly TaskRow[] =
    liveState.envelope?.data ?? (hasLiveRead ? [] : tasksDataset.data);
  const phases = liveState.phases ?? (hasLiveRead ? [] : phasesDataset.data);
  const datasetState = liveState.envelope?.state ?? tasksDataset.state;
  const errorMessages =
    liveState.errors.length > 0
      ? liveState.errors.map(formatReadError)
      : tasksDataset.state === "error"
        ? [`Tasks load failed: ${tasksDataset.error.message}`]
        : [];
  const isEmpty =
    datasetState === "empty" || datasetState === "error" || tasks.length === 0;
  const sourceLabel = hasLiveRead
    ? liveState.loading
      ? "Desktop API live · loading"
      : "Desktop API live"
    : FIXTURE_BANNER_LABEL;

  const phaseTitleById = useMemo<Map<string, string>>(
    () => new Map(phases.map((phase) => [phase.id, phase.title])),
    [phases],
  );

  const filteredTasks = useMemo<readonly TaskRow[]>(() => {
    if (statusFilter === "all") return tasks;
    return tasks.filter((task) => task.status === statusFilter);
  }, [tasks, statusFilter]);

  const phaseIdsInOrder = useMemo<readonly string[]>(
    () => phases.map((phase) => phase.id),
    [phases],
  );

  const groups = useMemo(
    () => groupTasksByPhase(filteredTasks, phaseIdsInOrder),
    [filteredTasks, phaseIdsInOrder],
  );

  const selectedTask = useMemo<TaskRow | null>(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const inspectTask = (task: TaskRow): void => {
    setSelectedTaskId(task.id);
    if (inspector.isAllowedHere) {
      inspector.setOpen(true);
    }
  };

  return (
    <>
      <section
        className="tasks"
        data-testid="tasks"
        data-dataset-state={datasetState}
        data-status-filter={statusFilter}
        aria-labelledby="tasks-title"
      >
        <header className="tasks__header">
          <p className="tasks__fixture-label">{sourceLabel}</p>
          <h1 id="tasks-title" className="tasks__title">
            Tasks
          </h1>
          <p className="tasks__summary">
            {`${tasks.length} task${tasks.length === 1 ? "" : "s"} grouped by phase.`}
          </p>
          {errorMessages.length > 0 ? (
            <p
              className="tasks__error"
              data-testid="tasks-error"
              role="status"
            >
              {`${errorMessages.join(" · ")}. Filters remain available.`}
            </p>
          ) : null}
          <div className="tasks__filters" data-testid="tasks-filters">
            <label className="tasks__filter-label" htmlFor="tasks-filter-status">
              Filter by status
            </label>
            <select
              id="tasks-filter-status"
              data-testid="tasks-filter-status"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as StatusFilter)
              }
            >
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All statuses" : option}
                </option>
              ))}
            </select>
          </div>
        </header>

        {isEmpty ? (
          <p className="tasks__empty" data-testid="tasks-empty">
            {datasetState === "error"
              ? "No live tasks to show."
              : "No tasks decomposed yet."}
          </p>
        ) : filteredTasks.length === 0 ? (
          <p
            className="tasks__no-matches"
            data-testid="tasks-no-matches"
          >
            {`No tasks match the "${statusFilter}" filter.`}
          </p>
        ) : (
          <div className="tasks__groups" data-testid="tasks-groups">
            {groups.map((group) => {
              if (group.tasks.length === 0) return null;
              const phaseTitle =
                group.phaseId === "__orphan__"
                  ? "Other"
                  : (phaseTitleById.get(group.phaseId) ?? group.phaseId);
              return (
                <section
                  key={group.phaseId}
                  className="tasks__group"
                  data-testid={`tasks-group-${group.phaseId}`}
                >
                  <h2 className="tasks__group-title">{phaseTitle}</h2>
                  <ul className="tasks__list">
                    {group.tasks.map((task) => (
                      <li
                        key={task.id}
                        className="tasks__row"
                        data-testid={`tasks-row-${task.id}`}
                        data-task-status={task.status}
                      >
                        {planId !== null ? (
                          <Link
                            className="tasks__row-title"
                            to={pathForTaskDetail(planId, task.id)}
                          >
                            {task.title}
                          </Link>
                        ) : (
                          <span className="tasks__row-title">
                            {task.title}
                          </span>
                        )}
                        <span className="tasks__row-meta">
                          {`${task.kind} · ${task.riskLevel} risk · ${task.status}`}
                        </span>
                        <span className="tasks__row-state">
                          {describeTaskRow(task)}
                        </span>
                        <button
                          type="button"
                          className="tasks__row-inspect"
                          data-testid={`tasks-row-inspect-${task.id}`}
                          onClick={() => inspectTask(task)}
                        >
                          Inspect task
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </section>

      {selectedTask !== null ? (
        <RightInspector title="Task inspector">
          <TaskInspectorBody task={selectedTask} />
        </RightInspector>
      ) : null}
    </>
  );
}
