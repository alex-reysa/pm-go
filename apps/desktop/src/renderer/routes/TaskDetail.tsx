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
 * performs no other side effect. Reads are live through the Desktop
 * API client; mutating API calls stay out of this route.
 *
 * Tests render this component with `initialPendingAction` set so the
 * static-render harness can inspect the modal markup directly
 * without needing an event-firing DOM.
 */

import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { PolicyDecision, WorktreeLease } from "@pm-go/contracts";

import {
  ApiConfigurationError,
  ApiError,
  createDesktopApiClientFromConfig,
  type DesktopApiClient,
} from "../api/index.js";
import { ConfirmationModal } from "../layout/ConfirmationModal.js";
import { RightInspector } from "../layout/RightInspector.js";
import { useRightInspector } from "../layout/inspectorContext.js";
import {
  buildTaskDetail,
  type ActionAvailability,
  type AgentRun,
  type LimitedValue,
  type Limitation,
  type ReadModelEnvelope,
  type RecoverableReadError,
  type ReviewReport,
  type ReviewReportProjection,
  type TaskDetailPayload,
  type TaskDetailViewModel,
} from "../read-models/index.js";
import {
  FIXTURE_BANNER_LABEL,
  type FixtureDataset,
  type TaskActionAvailability,
  type TaskAgentRunRef,
  type TaskDetail as FixtureTaskDetail,
  type TaskLeaseRef,
  type TaskReviewReportRef,
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

const UNKNOWN_ACTION_REASON =
  "The API did not return enough context to decide whether this action is available.";

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

function limitedLimitations<T>(value: T | LimitedValue<T>): Limitation[] {
  return isLimitedValue(value) ? value.limitations : [];
}

function hasDesktopBridge(): boolean {
  return typeof window !== "undefined" && window.pmGoDesktop !== undefined;
}

function isTaskDetailViewModel(
  task: TaskDetailModel,
): task is TaskDetailViewModel {
  return "raw" in task;
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

function taskBranchName(task: TaskDetailModel): string | null {
  return limitedValue(task.branchName);
}

function taskApprovalStatus(task: TaskDetailModel): string {
  return limitedValue(task.approvalStatus) ?? "none";
}

function taskReviewState(task: TaskDetailModel): string {
  return limitedValue(task.reviewState) ?? "none";
}

function taskWorktreePath(task: TaskDetailModel): string | null {
  return limitedValue(task.worktreePath);
}

function taskLatestAgentRun(task: TaskDetailModel): TaskAgentRunDisplay | null {
  if (isTaskDetailViewModel(task)) {
    return task.latestAgentRun.value;
  }
  return task.latestAgentRun;
}

function taskLatestLease(task: TaskDetailModel): TaskLeaseDisplay | null {
  if (isTaskDetailViewModel(task)) {
    return task.latestLease.value;
  }
  return task.latestLease;
}

function taskLatestReview(task: TaskDetailModel): TaskReviewDisplay | null {
  if (isTaskDetailViewModel(task)) {
    return task.latestReviewReport.value;
  }
  return task.latestReviewReport;
}

function taskReviewReports(task: TaskDetailModel): readonly TaskReviewDisplay[] | null {
  if ("reviewReports" in task) {
    return limitedValue(task.reviewReports);
  }
  const latest = task.latestReviewReport;
  return latest === null ? [] : [latest];
}

function taskAgentRuns(task: TaskDetailModel): readonly TaskAgentRunDisplay[] | null {
  if ("agentRuns" in task) {
    return limitedValue(task.agentRuns);
  }
  const latest = task.latestAgentRun;
  return latest === null ? [] : [latest];
}

function taskPolicyDecisions(task: TaskDetailModel): readonly PolicyDecision[] | null {
  if ("taskPolicyDecisions" in task) {
    return limitedValue(task.taskPolicyDecisions);
  }
  return null;
}

function taskReviewSkippedDecision(task: TaskDetailModel): PolicyDecision | null {
  if ("reviewSkippedDecision" in task) {
    return limitedValue(task.reviewSkippedDecision);
  }
  return null;
}

function fileScopeExcludes(task: TaskDetailModel): readonly string[] {
  return task.fileScope.excludes ?? [];
}

export interface TaskDetailProps {
  /**
   * Task-detail dataset envelope. Defaults to the happy-path fixture;
   * tests swap in `taskDetailEmptyState` / `taskDetailErrorState` to
   * exercise the missing-data variants.
   */
  readonly dataset?: FixtureDataset<FixtureTaskDetail | null>;
  /**
   * Optional initial value for the `pendingAction` state. Production
   * callers leave this unset (state starts at `null`); tests pass an
   * action kind so the static render emits the modal for that action.
   */
  readonly initialPendingAction?: TaskActionKind | null;
  /** Optional API client override for route-level tests. */
  readonly apiClient?: DesktopApiClient;
  /** Optional task override; production uses the `:taskId` route param. */
  readonly taskId?: string;
  /** Optional initial live state for static route tests. */
  readonly initialLiveState?: LiveTaskState;
}

type TaskDetailModel = FixtureTaskDetail | TaskDetailViewModel;
type TaskActionRow = TaskActionAvailability | ActionAvailability;
type TaskAgentRunDisplay = TaskAgentRunRef | AgentRun;
type TaskLeaseDisplay = TaskLeaseRef | WorktreeLease;
type TaskReviewDisplay = TaskReviewReportRef | ReviewReport | ReviewReportProjection;

interface LiveTaskState {
  readonly requestKey: string | null;
  readonly loading: boolean;
  readonly envelope: ReadModelEnvelope<TaskDetailViewModel | null, TaskDetailPayload | null> | null;
  readonly errors: readonly RecoverableReadError[];
}

/**
 * Helper: find the `TaskActionAvailability` row for a given action
 * kind, or `null` if the task does not list one. Returning `null`
 * (not `undefined`) keeps the consumer's type-narrowing simple.
 */
function findAvailability(
  task: TaskDetailModel,
  kind: TaskActionKind,
): TaskActionRow | null {
  return (
    task.availableActions.find(
      (row): row is TaskActionRow => row.action === kind,
    ) ?? null
  );
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
  if (availability.enabled === true) {
    return null;
  }
  if (availability.enabled === null) {
    return availability.reason ?? UNKNOWN_ACTION_REASON;
  }
  return availability.reason ?? FALLBACK_UNAVAILABLE_REASON;
}

/**
 * Render the empty / error variants of the route. Used when the
 * dataset envelope has no `data` to render against.
 */
function TaskDetailMissing({
  state,
  errorMessages,
  sourceLabel,
}: {
  state: "empty" | "error" | "loading";
  errorMessages: readonly string[];
  sourceLabel: string;
}): React.JSX.Element {
  return (
    <section
      className="task-detail task-detail--missing"
      data-testid="task-detail"
      data-dataset-state={state}
    >
      <header className="task-detail__header">
        <p className="task-detail__fixture-label">{sourceLabel}</p>
        <h1 className="task-detail__title">Task detail</h1>
      </header>
      {errorMessages.length > 0 ? (
        <p
          className="task-detail__error"
          data-testid="task-detail-error"
          role="status"
        >
          {errorMessages.join(" · ")}
        </p>
      ) : state === "loading" ? (
        <p
          className="task-detail__empty"
          data-testid="task-detail-empty"
          role="status"
        >
          Loading task detail.
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

function reviewFindingsCount(review: TaskReviewDisplay): number {
  if ("findingsCount" in review) return review.findingsCount;
  return review.findings.length;
}

function reviewCreatedAt(review: TaskReviewDisplay): string {
  if ("generatedAt" in review) return review.generatedAt;
  return review.createdAt;
}

function reviewCycleLabel(review: TaskReviewDisplay): string {
  return "cycleNumber" in review && typeof review.cycleNumber === "number"
    ? `review cycle #${review.cycleNumber}`
    : "review cycle unknown";
}

function reviewSummary(review: TaskReviewDisplay): string {
  if ("summary" in review) return review.summary;
  return `${review.outcome} review with ${review.findings.length} finding${
    review.findings.length === 1 ? "" : "s"
  }.`;
}

function agentRunStatus(run: TaskAgentRunDisplay): string {
  return "status" in run ? run.status : run.outcome;
}

function describeAgentRun(run: TaskAgentRunDisplay): string {
  const startedAt = run.startedAt ?? "not started";
  const completedAt = run.completedAt ?? "in progress";
  const cost =
    typeof run.costUsd === "number" ? ` · cost $${run.costUsd.toFixed(2)}` : "";
  return `${run.role} · ${agentRunStatus(run)} · started ${startedAt} · completed ${completedAt}${cost}`;
}

function describeLease(lease: TaskLeaseDisplay): string {
  if ("status" in lease) {
    return `${lease.branchName} · base ${lease.baseSha} · ${lease.status}`;
  }
  return `${lease.branchName} · base ${lease.baseSha} · ${
    lease.releasedAt === null ? "active" : `released ${lease.releasedAt}`
  }`;
}

function describePolicyDecision(decision: PolicyDecision): string {
  return `${decision.subjectType} · ${decision.decision} · ${decision.reason}`;
}

function TaskInspectorBody({
  task,
}: {
  readonly task: TaskDetailModel;
}): React.JSX.Element {
  const includesCount = task.fileScope.includes.length;
  const excludesCount = fileScopeExcludes(task).length;
  const latestReview = taskLatestReview(task);
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
        {`${includesCount} include path${includesCount === 1 ? "" : "s"} · ${excludesCount} exclude path${excludesCount === 1 ? "" : "s"}`}
      </p>
      <p className="task-detail__inspector-review">
        {latestReview !== null
          ? `Review: ${latestReview.outcome} · findings ${reviewFindingsCount(latestReview)}`
          : "Review: none"}
      </p>
    </div>
  );
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const dataset = props.dataset ?? taskDetailHappyPath;
  const routeParams = useParams();
  const taskId = props.taskId ?? routeParams.taskId ?? null;
  const liveReadEnabled =
    taskId !== null &&
    (props.apiClient !== undefined ||
      props.dataset === undefined ||
      hasDesktopBridge());
  const inspector = useRightInspector();
  const [pendingAction, setPendingAction] = useState<TaskActionKind | null>(
    props.initialPendingAction ?? null,
  );
  const [liveState, setLiveState] = useState<LiveTaskState>(
    props.initialLiveState ?? {
      requestKey: liveReadEnabled ? taskId : null,
      loading: liveReadEnabled,
      envelope: null,
      errors: [],
    },
  );

  useEffect(() => {
    if (!liveReadEnabled || taskId === null) return;
    const requestKey = taskId;
    let cancelled = false;
    setLiveState({
      requestKey,
      loading: true,
      envelope: null,
      errors: [],
    });

    void (async () => {
      try {
        const api = await getDesktopApiClient(props.apiClient);
        const payload: TaskDetailPayload = await api.getTask(taskId);
        const [reviewReportsResult, agentRunsResult] = await Promise.allSettled([
          api.listTaskReviewReports(taskId),
          api.listAgentRuns({ taskId }),
        ]);
        if (cancelled) return;

        const reviewReportsError =
          reviewReportsResult.status === "rejected"
            ? recoverableErrorFromUnknown(reviewReportsResult.reason)
            : null;
        const agentRunsError =
          agentRunsResult.status === "rejected"
            ? recoverableErrorFromUnknown(agentRunsResult.reason)
            : null;
        const firstError = reviewReportsError ?? agentRunsError ?? undefined;
        const envelope = buildTaskDetail({
          payload,
          ...(reviewReportsResult.status === "fulfilled"
            ? { reviewReports: reviewReportsResult.value }
            : {}),
          ...(agentRunsResult.status === "fulfilled"
            ? { agentRuns: agentRunsResult.value }
            : {}),
          ...(firstError !== undefined ? { error: firstError } : {}),
        });

        setLiveState({
          requestKey,
          loading: false,
          envelope,
          errors: [reviewReportsError, agentRunsError].filter(
            (error): error is RecoverableReadError => error !== null,
          ),
        });
      } catch (error) {
        if (cancelled) return;
        const readError = recoverableErrorFromUnknown(error);
        setLiveState({
          requestKey,
          loading: false,
          envelope: buildTaskDetail({ error: readError }),
          errors: [readError],
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [liveReadEnabled, taskId, props.apiClient]);

  const activeLiveState =
    liveReadEnabled && liveState.requestKey === taskId ? liveState : null;
  const liveLoading =
    liveReadEnabled && (activeLiveState === null || activeLiveState.loading);
  const liveEnvelope = activeLiveState?.envelope ?? null;
  const liveErrors = activeLiveState?.errors ?? [];

  const hasLiveRead = liveReadEnabled || liveEnvelope !== null || liveLoading;
  const task: TaskDetailModel | null =
    liveEnvelope?.data ?? (hasLiveRead ? null : dataset.data);
  const displayState =
    liveLoading && liveEnvelope === null
      ? "loading"
      : (liveEnvelope?.state ?? dataset.state);
  const sourceLabel = hasLiveRead
    ? liveLoading
      ? "Desktop API live · loading"
      : "Desktop API live"
    : FIXTURE_BANNER_LABEL;
  const errorMessages =
    liveErrors.length > 0
      ? liveErrors.map(formatReadError)
      : !hasLiveRead && dataset.state === "error"
        ? [`Task load failed: ${dataset.error.message}.`]
        : [];
  const limitations = liveEnvelope?.limitations ?? [];

  if (task === null) {
    return (
      <TaskDetailMissing
        sourceLabel={sourceLabel}
        state={
          displayState === "loading"
            ? "loading"
            : displayState === "error"
              ? "error"
              : "empty"
        }
        errorMessages={errorMessages}
      />
    );
  }

  const pendingDisabledReason =
    pendingAction === null
      ? null
      : disabledReasonFor(task, pendingAction);
  const branchName = taskBranchName(task);
  const approvalStatus = taskApprovalStatus(task);
  const reviewState = taskReviewState(task);
  const worktreePath = taskWorktreePath(task);
  const latestAgentRun = taskLatestAgentRun(task);
  const latestLease = taskLatestLease(task);
  const latestReview = taskLatestReview(task);
  const reviewReports = taskReviewReports(task);
  const agentRuns = taskAgentRuns(task);
  const policyDecisions = taskPolicyDecisions(task);
  const reviewSkippedDecision = taskReviewSkippedDecision(task);
  const fileExcludes = fileScopeExcludes(task);
  const fixCycleLabel =
    latestReview !== null
      ? `Fix cycle: ${reviewCycleLabel(latestReview)} · ${task.status}`
      : `Fix cycle: no review cycle yet · ${task.status}`;

  return (
    <>
    <section
      className="task-detail"
      data-testid="task-detail"
      data-dataset-state={hasLiveRead ? displayState : dataset.state}
      data-task-id={task.id}
      aria-labelledby="task-detail-title"
    >
      <header className="task-detail__header">
        <p className="task-detail__fixture-label">
          {sourceLabel}
          {!hasLiveRead ? ` · ${dataset.label}` : null}
        </p>
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
          onClick={() => inspector.setOpen(true)}
        >
          Inspect task
        </button>
      </header>

      {errorMessages.length > 0 ? (
        <div className="task-detail__error" role="alert" data-testid="task-detail-error">
          {errorMessages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      {limitations.length > 0 ? (
        <section
          className="task-detail__limitations"
          data-testid="task-detail-limitations"
          aria-label="Read limitations"
        >
          <h2>Read limitations</h2>
          <ul>
            {limitations.map((limitation) => (
              <li key={`${limitation.code}-${limitation.field}`}>
                {limitation.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="task-detail__file-scope"
        data-testid="task-detail-file-scope"
        aria-labelledby="task-detail-file-scope-title"
      >
        <h2 id="task-detail-file-scope-title">File scope</h2>
        <p className="task-detail__file-scope-section-label">Includes</p>
        <ul className="task-detail__file-scope-list">
          {task.fileScope.includes.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
        {fileExcludes.length > 0 ? (
          <>
            <p className="task-detail__file-scope-section-label">Excludes</p>
            <ul className="task-detail__file-scope-list">
              {fileExcludes.map((path) => (
                <li key={path}>{path}</li>
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
          {task.acceptanceCriteria.map((criterion) => (
            <li
              key={criterion.id}
              className="task-detail__acceptance-row"
              data-testid={`task-detail-acceptance-${criterion.id}`}
            >
              <p className="task-detail__acceptance-title">{criterion.title}</p>
              <p className="task-detail__acceptance-verify">
                {`verify: ${criterion.verify}`}
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
        <p className="task-detail__status-state" data-testid="task-detail-status-state">
          {`Task status: ${task.status} · Review: ${reviewState} · Approval: ${approvalStatus}`}
        </p>
        {latestAgentRun !== null ? (
          <p
            className="task-detail__agent-run"
            data-testid="task-detail-latest-agent-run"
          >
            {`Latest agent run: ${describeAgentRun(latestAgentRun)}`}
          </p>
        ) : (
          <p data-testid="task-detail-latest-agent-run">Latest agent run: none</p>
        )}
        {latestLease !== null ? (
          <>
            <p className="task-detail__lease" data-testid="task-detail-latest-lease">
              {`Lease: ${describeLease(latestLease)}`}
            </p>
            <p
              className="task-detail__worktree"
              data-testid="task-detail-worktree"
            >
              {`Worktree: ${latestLease.worktreePath}`}
            </p>
          </>
        ) : (
          <>
            <p data-testid="task-detail-latest-lease">Lease: none</p>
            <p data-testid="task-detail-worktree">
              {worktreePath !== null ? `Worktree: ${worktreePath}` : "Worktree: none"}
            </p>
          </>
        )}
        <p className="task-detail__fix-cycle" data-testid="task-detail-fix-cycle">
          {fixCycleLabel}
        </p>
        <p className="task-detail__fix-state" data-testid="task-detail-fix-state">
          {disabledReasonFor(task, "task.fix") === null
            ? "Fix action available"
            : `Fix action unavailable: ${disabledReasonFor(task, "task.fix")}`}
        </p>
        {latestReview !== null ? (
          <>
            <p className="task-detail__review-cycle">
              {`${reviewCycleLabel(latestReview)} · ${latestReview.outcome}`}
            </p>
            <p className="task-detail__review-summary">
              {reviewSummary(latestReview)}
            </p>
            <p className="task-detail__review-findings">
              {`Findings: ${reviewFindingsCount(latestReview)}`}
            </p>
          </>
        ) : null}
        <section
          className="task-detail__policy"
          data-testid="task-detail-policy-decisions"
          aria-label="Policy decisions"
        >
          <h3>Policy decisions</h3>
          {policyDecisions !== null && policyDecisions.length > 0 ? (
            <ul>
              {policyDecisions.map((decision) => (
                <li key={`${decision.subjectType}-${decision.subjectId}`}>
                  {describePolicyDecision(decision)}
                </li>
              ))}
            </ul>
          ) : reviewSkippedDecision !== null ? (
            <p>{`Review skipped: ${describePolicyDecision(reviewSkippedDecision)}`}</p>
          ) : (
            <p>Policy decisions were not returned by the API.</p>
          )}
        </section>
        <section
          className="task-detail__review-history"
          data-testid="task-detail-review-history"
          aria-label="Review history"
        >
          <h3>Review history</h3>
          {reviewReports !== null && reviewReports.length > 0 ? (
            <ol>
              {reviewReports.map((review) => (
                <li key={review.id}>
                  {`${reviewCycleLabel(review)} · ${review.outcome} · ${reviewCreatedAt(review)} · findings ${reviewFindingsCount(review)}`}
                </li>
              ))}
            </ol>
          ) : (
            <p>No review history returned by the API.</p>
          )}
        </section>
        <section
          className="task-detail__agent-runs"
          data-testid="task-detail-related-agent-runs"
          aria-label="Related agent runs"
        >
          <h3>Related agent runs</h3>
          {agentRuns !== null && agentRuns.length > 0 ? (
            <ul>
              {agentRuns.map((run) => (
                <li key={run.id}>{describeAgentRun(run)}</li>
              ))}
            </ul>
          ) : (
            <p>No related agent runs returned by the API.</p>
          )}
        </section>
      </section>

      <section
        className="task-detail__actions"
        data-testid="task-detail-actions"
        aria-labelledby="task-detail-actions-title"
      >
        <h2 id="task-detail-actions-title">Mutating actions</h2>
        <p className="task-detail__actions-note">
          Each action opens a confirmation modal; server-side workflow mutations remain authoritative.
        </p>
        <div className="task-detail__action-row" role="group">
          {TASK_ACTION_KINDS.map((kind) => {
            const disabledReason = disabledReasonFor(task, kind);
            const disabled = disabledReason !== null;
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
                  data-action-disabled={String(disabled)}
                  aria-disabled={disabled}
                  onClick={() => setPendingAction(kind)}
                >
                  {ACTION_LABELS[kind]}
                </button>
                {disabledReason !== null ? (
                  <span
                    className="task-detail__action-reason"
                    data-testid={`task-detail-action-reason-${kind}`}
                  >
                    {disabledReason}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {branchName !== null ? (
        <p className="task-detail__branch" data-testid="task-detail-branch">
          {`Branch: ${branchName}`}
        </p>
      ) : null}

      {pendingAction !== null ? (
        <ConfirmationModal
          isOpen={true}
          action={ACTION_LABELS[pendingAction]}
          confirmLabel={ACTION_LABELS[pendingAction]}
          disabledReason={pendingDisabledReason}
          onConfirm={() => setPendingAction(null)}
          onCancel={() => setPendingAction(null)}
        >
          <p
            className="task-detail__modal-action-label"
            data-testid="task-detail-modal-action-label"
          >
            {`Action: ${ACTION_LABELS[pendingAction]}`}
          </p>
        </ConfirmationModal>
      ) : null}
    </section>

    <RightInspector title="Task inspector">
      <TaskInspectorBody task={task} />
    </RightInspector>
    </>
  );
}
