/**
 * Right Inspector primitive.
 *
 * The inspector is a side panel anchored to the right of `AppShell`'s
 * outlet. It is *controlled*: the parent layout owns its open/closed
 * state via `RightInspectorProvider` (see `inspectorContext.ts`). It
 * is closed by default and refuses to open on routes that aren't in
 * the allow-list passed to its provider.
 *
 * The body of the inspector is whatever the route owner passes via
 * `children`. This component owns the chrome (panel frame, header
 * with the close button, allow-list gate); it does NOT own the
 * inspector's content. Route bodies that want to render an inspector
 * pass children + a title; routes that don't want one pass nothing
 * (the `RightInspector` element can be omitted entirely from the
 * layout).
 */

import React, { type ReactNode } from "react";

import { useRightInspector } from "./inspectorContext.js";

export interface RightInspectorProps {
  /**
   * Title shown in the inspector header. Inspector bodies usually pick
   * a noun (e.g. "Task detail", "Approval", "Artifact") so the panel
   * reads as a focus area rather than a generic sidebar.
   */
  readonly title: string;
  /**
   * Inspector body. Route owners pass whatever JSX they want here —
   * this component does NOT render a placeholder if `children` is
   * empty, because an empty inspector is almost certainly a bug.
   */
  readonly children: ReactNode;
  /**
   * Optional id for the inspector's labelled region. Defaults to
   * `"right-inspector"`. Override when multiple inspectors might
   * coexist in the DOM (rare, but possible during a transition
   * animation).
   */
  readonly regionId?: string;
}

export function RightInspector(
  props: RightInspectorProps,
): React.JSX.Element | null {
  const { title, children, regionId = "right-inspector" } = props;
  const { isOpen, setOpen, isAllowedHere } = useRightInspector();

  // The provider already coerces `isOpen` to false on disallowed
  // routes, but we double-check here so a future regression in the
  // provider can't sneak content onto a disallowed route.
  if (!isAllowedHere || !isOpen) {
    return null;
  }

  const titleId = `${regionId}-title`;
  return (
    <aside
      className="right-inspector"
      role="complementary"
      aria-labelledby={titleId}
      data-testid="right-inspector"
      data-open="true"
      id={regionId}
    >
      <header className="right-inspector__header">
        <h2 id={titleId} className="right-inspector__title">
          {title}
        </h2>
        <button
          type="button"
          className="right-inspector__close"
          onClick={() => setOpen(false)}
          aria-label="Close inspector"
          data-testid="right-inspector-close"
        >
          Close
        </button>
      </header>
      <div className="right-inspector__body">{children}</div>
    </aside>
  );
}

/**
 * Toggle button for the inspector — symmetric with `EventDrawerToggle`.
 * Returns `null` on routes where the inspector isn't allowed, so the
 * NavBar can pass it unconditionally without an extra wrapping check.
 */
export function RightInspectorToggle(): React.JSX.Element | null {
  const { isOpen, setOpen, isAllowedHere } = useRightInspector();
  if (!isAllowedHere) {
    return null;
  }
  return (
    <button
      type="button"
      className="right-inspector__toggle"
      onClick={() => setOpen(!isOpen)}
      aria-expanded={isOpen}
      aria-controls="right-inspector"
      data-testid="right-inspector-toggle"
    >
      {isOpen ? "Hide inspector" : "Show inspector"}
    </button>
  );
}
