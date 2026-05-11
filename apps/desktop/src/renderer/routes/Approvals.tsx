/**
 * Run-scoped Approvals queue route.
 *
 * Renders the approvals fixture envelope (pending + decided rows) with
 * the joined task/phase context the cockpit needs:
 *
 *   - risk band, subject (task / phase / plan), status badge
 *   - reason / decided-by / decided-at when the row has been decided
 *   - requested-by / requested-at on every row
 *   - per-row "Approve" affordance for pending rows that opens a
 *     {@link ConfirmationModal} with the M4-deferred copy
 *
 * The component is *body-only*: it does not own the run-scoped layout
 * frame (banner + section nav + event-drawer affordance + right
 * inspector). The router config mounts each route under
 * {@link RunDetailShell}, which carries those affordances. Smoke
 * tests reconstruct the same wrap so they can assert the toggle
 * and surrounding context survive every fixture state — including
 * the simulated 403 error envelope.
 *
 * State branching is explicit:
 *
 *   - `state === "happy"` → render the row table.
 *   - `state === "empty"` → render the empty-state callout while
 *     keeping the section chrome rendered.
 *   - `state === "error"` → render the inline `ApiError` callout but
 *     keep the section chrome AND any stale rows the envelope still
 *     carries (M2 fixtures use `data: []` here, but the rendering
 *     stays envelope-agnostic so M3 can keep partial state visible).
 */

import React, { useState } from "react";

import { ConfirmationModal } from "../layout/ConfirmationModal.js";
import {
  FIXTURE_BANNER_LABEL,
  type ApprovalQueueItem,
  type ApprovalsList,
  type FixtureDataset,
} from "../fixtures/index.js";

export interface ApprovalsRouteProps {
  /**
   * Fixture envelope to render. M3 will replace the prop type with the
   * live-API equivalent in one find-and-replace pass.
   */
  readonly dataset: FixtureDataset<ApprovalsList>;
  /**
   * Test/Storybook hook: when non-null, the route renders the
   * confirmation modal for the approval-id passed here on first
   * paint. Production callers leave this `undefined` so the modal
   * starts closed and only opens on a button click. Documented as
   * test-only so a real route never accidentally pre-opens the
   * modal.
   */
  readonly initialPendingConfirmationId?: string | null;
}

/**
 * Human-readable label for the approval status badge.
 */
function formatStatus(status: ApprovalQueueItem["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "skipped":
      return "Skipped";
  }
}

/**
 * Render the rows table (happy + non-empty error states share this
 * helper). Extracted so the state-branch in the component body stays
 * readable.
 */
function ApprovalsTable({
  rows,
  onApprove,
}: {
  rows: readonly ApprovalQueueItem[];
  onApprove: (id: string) => void;
}): React.JSX.Element {
  return (
    <ul className="approvals__rows" data-testid="approvals-rows">
      {rows.map((row) => (
        <li
          key={row.id}
          className="approvals__row"
          data-approval-id={row.id}
          data-approval-status={row.status}
          data-testid={`approvals-row-${row.id}`}
        >
          <div className="approvals__row-header">
            <span
              className="approvals__subject"
              data-testid={`approvals-row-${row.id}-subject`}
            >
              {row.subject}
            </span>
            <span
              className={`approvals__risk approvals__risk--${row.riskBand}`}
              data-testid={`approvals-row-${row.id}-risk`}
            >
              risk: {row.riskBand}
            </span>
            <span
              className="approvals__status"
              data-testid={`approvals-row-${row.id}-status`}
            >
              {formatStatus(row.status)}
            </span>
          </div>
          <div className="approvals__row-body">
            {row.taskTitle !== null ? (
              <p className="approvals__row-title">{row.taskTitle}</p>
            ) : null}
            {row.phaseTitle !== null ? (
              <p className="approvals__row-phase">
                phase: {row.phaseTitle}
              </p>
            ) : null}
            <dl className="approvals__row-meta">
              <dt>requested by</dt>
              <dd data-testid={`approvals-row-${row.id}-requested-by`}>
                {row.requestedBy ?? "—"}
              </dd>
              <dt>requested at</dt>
              <dd data-testid={`approvals-row-${row.id}-requested-at`}>
                {row.requestedAt}
              </dd>
              {row.decidedAt !== null ? (
                <>
                  <dt>decided by</dt>
                  <dd data-testid={`approvals-row-${row.id}-approved-by`}>
                    {row.approvedBy ?? "—"}
                  </dd>
                  <dt>decided at</dt>
                  <dd data-testid={`approvals-row-${row.id}-decided-at`}>
                    {row.decidedAt}
                  </dd>
                </>
              ) : null}
              {row.reason !== null ? (
                <>
                  <dt>reason</dt>
                  <dd data-testid={`approvals-row-${row.id}-reason`}>
                    {row.reason}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
          {row.status === "pending" ? (
            <div className="approvals__row-actions">
              <button
                type="button"
                className="approvals__approve"
                data-testid={`approvals-approve-${row.id}`}
                onClick={() => onApprove(row.id)}
              >
                Approve
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Approvals(props: ApprovalsRouteProps): React.JSX.Element {
  const { dataset, initialPendingConfirmationId } = props;
  // `useState`'s initial value comes from the optional prop so test
  // renders can pre-open the modal without simulating a click.
  const [pendingConfirmationId, setPendingConfirmationId] = useState<
    string | null
  >(initialPendingConfirmationId ?? null);

  // The fixture envelope's `state` is the single discriminator the
  // component branches on. We keep the section chrome (banner,
  // heading) rendered on every branch so "preserve surrounding
  // context on error" is satisfied without per-branch duplication.
  const isError = dataset.state === "error";
  const isEmpty = dataset.state === "empty" || dataset.data.length === 0;

  const pendingRow =
    pendingConfirmationId !== null
      ? dataset.data.find((row) => row.id === pendingConfirmationId) ?? null
      : null;

  return (
    <section
      className="approvals"
      data-route="run.approvals"
      data-testid="approvals-route"
      data-fixture-state={dataset.state}
      aria-labelledby="approvals-title"
    >
      <header className="approvals__header">
        <h2 id="approvals-title">Approvals</h2>
        <p
          className="approvals__fixture-banner"
          data-testid="approvals-fixture-banner"
        >
          {FIXTURE_BANNER_LABEL} · {dataset.label}
        </p>
      </header>
      {isError ? (
        <div
          className="approvals__error"
          role="alert"
          data-testid="approvals-error"
        >
          <p className="approvals__error-title">
            Failed to load approvals (HTTP {dataset.error.status})
          </p>
          <p className="approvals__error-message">{dataset.error.message}</p>
        </div>
      ) : null}
      {isEmpty && !isError ? (
        <p
          className="approvals__empty"
          data-testid="approvals-empty"
        >
          No approvals in the queue.
        </p>
      ) : null}
      {!isEmpty ? (
        <ApprovalsTable
          rows={dataset.data}
          onApprove={(id) => setPendingConfirmationId(id)}
        />
      ) : null}
      <ConfirmationModal
        isOpen={pendingRow !== null}
        action={
          pendingRow !== null
            ? `Approve ${pendingRow.subject}: ${
                pendingRow.taskTitle ??
                pendingRow.phaseTitle ??
                pendingRow.id
              }`
            : "Approve"
        }
        confirmLabel="Approve"
        onConfirm={() => setPendingConfirmationId(null)}
        onCancel={() => setPendingConfirmationId(null)}
      >
        {pendingRow !== null ? (
          <p className="approvals__confirm-summary">
            Risk {pendingRow.riskBand} · requested by{" "}
            {pendingRow.requestedBy ?? "—"}.
          </p>
        ) : null}
      </ConfirmationModal>
    </section>
  );
}
