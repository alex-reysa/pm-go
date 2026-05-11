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
 * M2 mock data only — no fetches, no SSE, no live state.
 */

import React, { useMemo, useState } from "react";

import { RightInspector } from "../layout/RightInspector.js";
import { useRightInspector } from "../layout/inspectorContext.js";
import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type PhasesList,
  type TaskSummary,
  type TasksList,
  type TaskStatus,
  phasesHappyPath,
  tasksHappyPath,
} from "../fixtures/index.js";

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
}

/**
 * Group an unfiltered task list by phase id. Returns the order
 * driven by `phaseIdsInOrder` so the page reads in phase dependency
 * order. Tasks whose phase is missing from the order list land in a
 * trailing "orphan" group so they're never silently dropped.
 */
function groupTasksByPhase(
  tasks: TasksList,
  phaseIdsInOrder: readonly string[],
): Array<{ phaseId: string; tasks: TasksList }> {
  const byPhase = new Map<string, TasksList>();
  for (const phaseId of phaseIdsInOrder) {
    byPhase.set(phaseId, []);
  }
  const orphans: TasksList = [];
  for (const task of tasks) {
    const bucket = byPhase.get(task.phaseId);
    if (bucket === undefined) {
      orphans.push(task);
      continue;
    }
    bucket.push(task);
  }
  const groups: Array<{ phaseId: string; tasks: TasksList }> = [];
  for (const phaseId of phaseIdsInOrder) {
    groups.push({ phaseId, tasks: byPhase.get(phaseId) ?? [] });
  }
  if (orphans.length > 0) {
    groups.push({ phaseId: "__orphan__", tasks: orphans });
  }
  return groups;
}

function describeTaskRow(task: TaskSummary): string {
  const review = task.reviewState ?? "no review yet";
  const approval = task.approvalStatus ?? "no approval gate";
  return `Review: ${review} · Approval: ${approval}`;
}

function TaskInspectorBody({
  task,
}: {
  readonly task: TaskSummary;
}): React.JSX.Element {
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
      {task.branchName !== null ? (
        <p className="tasks__inspector-branch">
          {`Branch: ${task.branchName}`}
        </p>
      ) : null}
    </div>
  );
}

export function Tasks(props: TasksProps): React.JSX.Element {
  const tasksDataset = props.tasksDataset ?? tasksHappyPath;
  const phasesDataset = props.phasesDataset ?? phasesHappyPath;
  const inspector = useRightInspector();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    props.initialStatusFilter ?? "all",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tasks = tasksDataset.data;
  const phases = phasesDataset.data;
  const errorMessage =
    tasksDataset.state === "error" ? tasksDataset.error.message : null;
  const isEmpty = tasksDataset.state === "empty" || tasks.length === 0;

  const phaseTitleById = useMemo<Map<string, string>>(
    () => new Map(phases.map((phase) => [phase.id, phase.title])),
    [phases],
  );

  const filteredTasks = useMemo<TasksList>(() => {
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

  const selectedTask = useMemo<TaskSummary | null>(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const inspectTask = (task: TaskSummary): void => {
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
        data-dataset-state={tasksDataset.state}
        data-status-filter={statusFilter}
        aria-labelledby="tasks-title"
      >
        <header className="tasks__header">
          <p className="tasks__fixture-label">{FIXTURE_BANNER_LABEL}</p>
          <h1 id="tasks-title" className="tasks__title">
            Tasks
          </h1>
          <p className="tasks__summary">
            {`${tasks.length} task${tasks.length === 1 ? "" : "s"} grouped by phase.`}
          </p>
          {errorMessage !== null ? (
            <p
              className="tasks__error"
              data-testid="tasks-error"
              role="status"
            >
              {`Tasks load failed: ${errorMessage}. Filters remain available.`}
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
            {tasksDataset.state === "error"
              ? "No cached tasks to show."
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
                        <span className="tasks__row-title">{task.title}</span>
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
