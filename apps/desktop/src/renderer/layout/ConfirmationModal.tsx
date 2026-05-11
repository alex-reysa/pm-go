/**
 * Reusable confirmation-modal primitive.
 *
 * Used by every mutating action surface (release, integrate-phase,
 * approve, retry, cancel) to gate destructive or run-affecting calls
 * behind a confirm step. The modal:
 *
 *   - Names the **action** in the header so the operator can tell
 *     what they're confirming at a glance.
 *   - Shows a **disabled-reason** when the action can't currently
 *     proceed (e.g. "Phase has uncommitted task gates"). When a
 *     disabled-reason is present, the confirm button is disabled and
 *     labelled accordingly.
 *   - Always shows the literal copy `"M4 will wire this to the API."`
 *     so reviewers can't miss that this is a layout primitive, not a
 *     functional confirm. M4 owns the actual API plumbing; this
 *     component only provides the visual contract.
 *
 * The modal does NOT mount its own backdrop overlay yet — that lands
 * with the actual focus-trap library in M4. For now it renders an
 * inert `<dialog>` element with `open={isOpen}`, which is enough to
 * exercise the show/hide contract and accessible to screen readers.
 */

import React, { type ReactNode } from "react";

export interface ConfirmationModalProps {
  /**
   * Whether the modal is shown. Parent owns this; the modal does not
   * trigger itself.
   */
  readonly isOpen: boolean;
  /**
   * Short description of the action being confirmed. Rendered as the
   * dialog title — keep it noun-phrased ("Integrate phase 3") rather
   * than imperative ("Integrate"), so the title also names the target.
   */
  readonly action: string;
  /**
   * Optional body. Use this to add context the title can't carry —
   * e.g. an impact summary or a list of side effects.
   */
  readonly children?: ReactNode;
  /**
   * If non-null, the confirm button is disabled and this string is
   * shown next to it as the user-visible reason. Use it to surface
   * server-side `409` reasons or local validation gates.
   */
  readonly disabledReason?: string | null;
  /**
   * Confirm-button label. Defaults to `"Confirm"`. Override for
   * destructive surfaces (e.g. `"Cancel run"`) so the verb matches
   * the action.
   */
  readonly confirmLabel?: string;
  /** Cancel-button label. Defaults to `"Cancel"`. */
  readonly cancelLabel?: string;
  /**
   * Confirm callback. Wiring is deferred to M4; for now this is
   * usually a `console.log` stub or a no-op. The component itself
   * does not gate based on `disabledReason` — callers must check
   * `disabledReason !== null` before treating the click as
   * confirmation. The button is, however, visually disabled when
   * `disabledReason` is non-null, so a stray click is unlikely.
   */
  readonly onConfirm: () => void;
  /** Cancel / dismiss callback. */
  readonly onCancel: () => void;
}

/**
 * Internal helper: the immutable copy that the task summary requires
 * be rendered as a placeholder. Keeping it as a constant makes the
 * "search for the literal string" reviewer step deterministic.
 */
const M4_PLACEHOLDER_COPY = "M4 will wire this to the API.";

export function ConfirmationModal(
  props: ConfirmationModalProps,
): React.JSX.Element | null {
  const {
    isOpen,
    action,
    children,
    disabledReason = null,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
  } = props;

  if (!isOpen) {
    return null;
  }

  const isDisabled = disabledReason !== null;
  const titleId = "confirmation-modal-title";
  const bodyId = "confirmation-modal-body";
  return (
    <div
      className="confirmation-modal__backdrop"
      role="presentation"
      data-testid="confirmation-modal-backdrop"
      onClick={onCancel}
    >
      {/*
        Stop click propagation so a click inside the dialog body does
        not trigger the backdrop's onCancel. The backdrop's role is
        `presentation` — only the inner `<div role="dialog">` is the
        accessible region.
      */}
      <div
        className="confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="confirmation-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="confirmation-modal__header">
          <h2 id={titleId} className="confirmation-modal__title">
            {action}
          </h2>
        </header>
        <div id={bodyId} className="confirmation-modal__body">
          {children}
          <p
            className="confirmation-modal__placeholder"
            data-testid="confirmation-modal-m4-copy"
          >
            {M4_PLACEHOLDER_COPY}
          </p>
          {isDisabled ? (
            <p
              className="confirmation-modal__disabled-reason"
              data-testid="confirmation-modal-disabled-reason"
              role="status"
            >
              {disabledReason}
            </p>
          ) : null}
        </div>
        <footer className="confirmation-modal__footer">
          <button
            type="button"
            className="confirmation-modal__cancel"
            onClick={onCancel}
            data-testid="confirmation-modal-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirmation-modal__confirm"
            onClick={onConfirm}
            disabled={isDisabled}
            aria-disabled={isDisabled}
            data-testid="confirmation-modal-confirm"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
