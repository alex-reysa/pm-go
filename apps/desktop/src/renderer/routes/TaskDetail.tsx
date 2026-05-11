/**
 * Task Detail route.
 *
 * Shows the per-task identity strip, file scope, acceptance criteria,
 * latest review / fix state, and a row of mutating action buttons
 * (Run, Review, Fix, Approve, Override). Each button opens the
 * shared {@link ConfirmationModal} with:
 *
 *   - An explicit action label in the modal header.
 *   - A disabled-reason line when the task's `availableActions` says
 *     the action can't currently proceed (or when the action is not
 *     in `availableActions` at all).
 *   - The fixed M4 copy ("M4 will wire this to the API.") supplied
 *     by the modal primitive itself.
 *
 * Clicking the cancel button (or the backdrop) closes the modal and
 * performs no other side effect: `confirmedAction` state only
 * advances on a successful confirm-and-allowed path, and we
 * deliberately stub that path with a no-op until M4 lights up the
 * actual API client.
 *
 * Tests render this component with `initialPendingAction` set so the
 * static-render harness can inspect the modal markup directly
 * without needing an event-firing DOM.
 */

import React, { useState } from "react";

import { ConfirmationModal } from "../layout/ConfirmationModal.js";
import { RightInspector } from "../layout/RightInspector.js";
import { useRightInspector } from "../layout/inspectorContext.js";
import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type TaskActionAvailability,
  type TaskDetail as TaskDetailModel,
  taskDetailHappyPath,
} from "../fixtures/index.js";

/**
 * The five mutating-action kinds the task-detail route exposes.
 * Mirrors the `TaskActionAvailability.action` literal union but
 * narrowed to the actions the cockpit surfaces — additional
 * actions can be added by appending here and to {@link ACTION_LABELS}.
 */
export const TASK_ACTION_KINDS = [
  "task.run",
  "task.review",
  "task.fix",
  "task.approve",
  "task.overrideReview",
] as const;

export type TaskActionKind = (typeof TASK_ACTION_KINDS)[number];

/**
 * Human-readable label for each action. Shown in the button face
 * AND in the modal header — keeping a single mapping ensures the
 * two surfaces never drift apart.
 */
export const ACTION_LABELS: Readonly<Record<TaskActionKind, string>> = {
  "task.run": "Run task",
  "task.review": "Review task",
  "task.fix": "Apply fix",
  "task.approve": "Approve task",
  "task.overrideReview": "Override review",
};

/**
 * Fallback reason rendered when the task's `availableActions` array
 * does not even include the action kind being attempted. Keeps the
 * UX consistent with the `enabled === false` case (which has its
 * own server-supplied `reason`).
 */
const FALLBACK_UNAVAILABLE_REASON =
  "This action is not available for the task in its current state.";

export interface TaskDetailProps {
  /**
   * Task-detail dataset envelope. Defaults to the happy-path fixture;
   * tests swap in `taskDetailEmptyState` / `taskDetailErrorState` to
   * exercise the missing-data variants.
   */
  readonly dataset?: FixtureDataset<TaskDetailModel | null>;
  /**
   * Optional initial value for the `pendingAction` state. Production
   * callers leave this unset (state starts at `null`); tests pass an
   * action kind so the static render emits the modal for that action.
   */
  readonly initialPendingAction?: TaskActionKind | null;
}

/**
 * Helper: find the `TaskActionAvailability` row for a given action
 * kind, or `null` if the task does not list one. Returning `null`
 * (not `undefined`) keeps the consumer's type-narrowing simple.
 */
function findAvailability(
  task: TaskDetailModel,
  kind: TaskActionKind,
): TaskActionAvailability | null {
  return task.availableActions.find((row) => row.action === kind) ?? null;
}

/**
 * Compute the disabled-reason text for an action button. Returns
 * `null` if the action is allowed; otherwise returns the
 * server-supplied reason (when available) or the local fallback.
 */
function disabledReasonFor(
  task: TaskDetailModel,
  kind: TaskActionKind,
): string | null {
  const availability = findAvailability(task, kind);
  if (availability === null) {
    return FALLBACK_UNAVAILABLE_REASON;
  }
  if (availability.enabled) {
    return null;
  }
  return availability.reason ?? FALLBACK_UNAVAILABLE_REASON;
}

/**
 * Render the empty / error variants of the route. Used when the
 * dataset envelope has no `data` to render against.
 */
function TaskDetailMissing({
  state,
  errorMessage,
}: {
  state: "empty" | "error";
  errorMessage: string | null;
}): React.JSX.Element {
  return (
    <section
      className="task-detail task-detail--missing"
      data-testid="task-detail"
      data-dataset-state={state}
    >
      <header className="task-detail__header">
        <p className="task-detail__fixture-label">{FIXTURE_BANNER_LABEL}</p>
        <h1 className="task-detail__title">Task detail</h1>
      </header>
      {state === "error" && errorMessage !== null ? (
        <p
          className="task-detail__error"
          data-testid="task-detail-error"
          role="status"
        >
          {`Task load failed: ${errorMessage}.`}
        </p>
      ) : (
        <p
          className="task-detail__empty"
          data-testid="task-detail-empty"
        >
          No task selected.
        </p>
      )}
    </section>
  );
}

function TaskInspectorBody({
  task,
}: {
  readonly task: TaskDetailModel;
}): React.JSX.Element {
  return (
    <div
      className="task-detail__inspector"
      data-testid={`task-detail-inspector-${task.id}`}
    >
      <p className="task-detail__inspector-title">{task.title}</p>
      <p className="task-detail__inspector-status">
        {`${task.slug} · ${task.status} · ${task.riskLevel} risk`}
      </p>
      <p className="task-detail__inspector-file-scope">
        {`${task.fileScope.includes.length} include path${task.fileScope.includes.length === 1 ? "" : "s"} · ${task.fileScope.excludes.length} exclude path${task.fileScope.excludes.length === 1 ? "" : "s"}`}
      </p>
      <p className="task-detail__inspector-review">
        {task.latestReviewReport !== null
          ? `Review: ${task.latestReviewReport.outcome} · findings ${task.latestReviewReport.findingsCount}`
          : "Review: none"}
      </p>
    </div>
  );
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const dataset = props.dataset ?? taskDetailHappyPath;
  const inspector = useRightInspector();
  const [pendingAction, setPendingAction] = useState<TaskActionKind | null>(
    props.initialPendingAction ?? null,
  );

  // Empty / error envelope: render the missing-state variant.
  if (dataset.data === null) {
    const errorMessage =
      dataset.state === "error" ? dataset.error.message : null;
    return (
      <TaskDetailMissing
        state={dataset.state === "error" ? "error" : "empty"}
        errorMessage={errorMessage}
      />
    );
  }

  const task = dataset.data;
  const datasetErrorMessage =
    dataset.state === "error" ? dataset.error.message : null;

  // Modal copy for the currently-open action. `pendingAction === null`
  // means no modal — the ConfirmationModal renders `null` when its
  // `isOpen` prop is false.
  const pendingLabel =
    pendingAction !== null ? ACTION_LABELS[pendingAction] : "";
  const pendingDisabledReason =
    pendingAction !== null ? disabledReasonFor(task, pendingAction) : null;
  const fixDisabledReason = disabledReasonFor(task, "task.fix");
  const fixCycleCopy =
    task.latestReviewReport !== null
      ? `Fix cycle: review cycle #${task.latestReviewReport.cycleNumber} · ${task.status}`
      : `Fix cycle: no review cycle yet · ${task.status}`;
  const fixStateCopy =
    fixDisabledReason === null
      ? "Fix action available."
      : `Fix action unavailable: ${fixDisabledReason}`;

  const closeModal = (): void => setPendingAction(null);
  const onConfirm = (): void => {
    // M4 wires the API call here. For now, closing the modal is the
    // only side effect — the confirmation modal itself disables the
    // confirm button when `disabledReason` is non-null, so a stray
    // click on a disallowed action never reaches this branch.
    closeModal();
  };
  const openInspector = (): void => {
    if (inspector.isAllowedHere) {
      inspector.setOpen(true);
    }
  };

  return (
    <>
      <section
        className="task-detail"
        data-testid="task-detail"
        data-dataset-state={dataset.state}
        data-task-id={task.id}
        aria-labelledby="task-detail-title"
      >
        <header className="task-detail__header">
          <p className="task-detail__fixture-label">{FIXTURE_BANNER_LABEL}</p>
          <h1 id="task-detail-title" className="task-detail__title">
            {task.title}
          </h1>
          <p className="task-detail__identity">
            {`${task.slug} · ${task.kind} · ${task.riskLevel} risk · ${task.status}`}
          </p>
          <p className="task-detail__summary">{task.summary}</p>
          <button
            type="button"
            className="task-detail__inspect-button"
            data-testid="task-detail-open-inspector"
            onClick={openInspector}
          >
            Inspect task
          </button>
          {datasetErrorMessage !== null ? (
            <p
              className="task-detail__error"
              data-testid="task-detail-error"
              role="status"
            >
              {`Task load failed: ${datasetErrorMessage}.`}
            </p>
          ) : null}
        </header>

      <section
        className="task-detail__file-scope"
        data-testid="task-detail-file-scope"
        aria-labelledby="task-detail-file-scope-title"
      >
        <h2 id="task-detail-file-scope-title">File scope</h2>
        <p className="task-detail__file-scope-section-label">Includes</p>
        <ul className="task-detail__file-scope-list">
          {task.fileScope.includes.map((entry) => (
            <li key={`include-${entry}`}>{entry}</li>
          ))}
        </ul>
        {task.fileScope.excludes.length > 0 ? (
          <>
            <p className="task-detail__file-scope-section-label">Excludes</p>
            <ul className="task-detail__file-scope-list">
              {task.fileScope.excludes.map((entry) => (
                <li key={`exclude-${entry}`}>{entry}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section
        className="task-detail__acceptance"
        data-testid="task-detail-acceptance"
        aria-labelledby="task-detail-acceptance-title"
      >
        <h2 id="task-detail-acceptance-title">Acceptance criteria</h2>
        <ul className="task-detail__acceptance-list">
          {task.acceptanceCriteria.map((row) => (
            <li
              key={row.id}
              className="task-detail__acceptance-row"
              data-testid={`task-detail-acceptance-${row.id}`}
            >
              <p className="task-detail__acceptance-title">{row.title}</p>
              <p className="task-detail__acceptance-verify">
                {`verify: ${row.verify}`}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="task-detail__review"
        data-testid="task-detail-review"
        aria-labelledby="task-detail-review-title"
      >
        <h2 id="task-detail-review-title">Latest review / fix state</h2>
        <p
          className="task-detail__status-state"
          data-testid="task-detail-status-state"
        >
          {`Task status: ${task.status} · Review: ${task.reviewState ?? "none"} · Approval: ${task.approvalStatus ?? "none"}`}
        </p>
        {task.latestAgentRun !== null ? (
          <p
            className="task-detail__agent-run"
            data-testid="task-detail-latest-agent-run"
          >
            {`Latest agent run: ${task.latestAgentRun.role} · ${task.latestAgentRun.outcome} · started ${task.latestAgentRun.startedAt} · completed ${task.latestAgentRun.completedAt ?? "in progress"} · cost $${task.latestAgentRun.costUsd.toFixed(2)}`}
          </p>
        ) : (
          <p
            className="task-detail__agent-run"
            data-testid="task-detail-latest-agent-run"
          >
            Latest agent run: none
          </p>
        )}
        {task.latestLease !== null ? (
          <>
            <p
              className="task-detail__lease"
              data-testid="task-detail-latest-lease"
            >
              {`Lease: ${task.latestLease.branchName} · base ${task.latestLease.baseSha} · ${task.latestLease.releasedAt === null ? "active" : `released ${task.latestLease.releasedAt}`}`}
            </p>
            <p
              className="task-detail__worktree"
              data-testid="task-detail-worktree"
            >
              {`Worktree: ${task.latestLease.worktreePath}`}
            </p>
          </>
        ) : task.worktreePath !== null ? (
          <p
            className="task-detail__worktree"
            data-testid="task-detail-worktree"
          >
            {`Worktree: ${task.worktreePath}`}
          </p>
        ) : (
          <p
            className="task-detail__worktree"
            data-testid="task-detail-worktree"
          >
            Lease/worktree: none
          </p>
        )}
        <p
          className="task-detail__fix-cycle"
          data-testid="task-detail-fix-cycle"
        >
          {fixCycleCopy}
        </p>
        <p
          className="task-detail__fix-state"
          data-testid="task-detail-fix-state"
        >
          {fixStateCopy}
        </p>
        {task.latestReviewReport !== null ? (
          <>
            <p className="task-detail__review-cycle">
              {`Cycle #${task.latestReviewReport.cycleNumber} · ${task.latestReviewReport.outcome}`}
            </p>
            <p className="task-detail__review-summary">
              {task.latestReviewReport.summary}
            </p>
            <p className="task-detail__review-findings">
              {`Findings: ${task.latestReviewReport.findingsCount}`}
            </p>
          </>
        ) : (
          <p className="task-detail__review-empty">
            No review report yet.
          </p>
        )}
      </section>

      <section
        className="task-detail__actions"
        data-testid="task-detail-actions"
        aria-labelledby="task-detail-actions-title"
      >
        <h2 id="task-detail-actions-title">Mutating actions</h2>
        <p className="task-detail__actions-note">
          Each action opens a confirmation modal. Wiring lands in M4.
        </p>
        <div className="task-detail__action-row" role="group">
          {TASK_ACTION_KINDS.map((kind) => {
            const reason = disabledReasonFor(task, kind);
            const disabled = reason !== null;
            return (
              <div
                key={kind}
                className="task-detail__action-cell"
                data-testid={`task-detail-action-cell-${kind}`}
              >
                <button
                  type="button"
                  className="task-detail__action-button"
                  data-testid={`task-detail-action-${kind}`}
                  data-action={kind}
                  data-action-disabled={disabled ? "true" : "false"}
                  aria-disabled={disabled}
                  onClick={() => setPendingAction(kind)}
                >
                  {ACTION_LABELS[kind]}
                </button>
                {reason !== null ? (
                  <span
                    className="task-detail__action-reason"
                    data-testid={`task-detail-action-reason-${kind}`}
                  >
                    {reason}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmationModal
        isOpen={pendingAction !== null}
        action={pendingLabel}
        confirmLabel={pendingLabel}
        disabledReason={pendingDisabledReason}
        onConfirm={onConfirm}
        onCancel={closeModal}
      >
        <p
          className="task-detail__modal-action-label"
          data-testid="task-detail-modal-action-label"
        >
          {`Action: ${pendingLabel}`}
        </p>
      </ConfirmationModal>
      </section>

      <RightInspector title="Task inspector">
        <TaskInspectorBody task={task} />
      </RightInspector>
    </>
  );
}
