/**
 * React context for the bottom-anchored Event Drawer (M6 events stream).
 *
 * Why a context and not local component state: the drawer toggle lives
 * in the NavBar / RunDetailShell header, while the drawer body lives at
 * the bottom of AppShell. Wiring those two surfaces through prop
 * threads would put toggle plumbing on every intermediate layout
 * component. A small context — `isOpen`, `setOpen`, `toggle` — keeps
 * the wiring flat and lets render-only unit tests assert the default
 * (closed) state without instantiating an entire route tree.
 *
 * The drawer is **collapsed by default** (criterion in the task
 * summary). It is also gated to run-scoped routes: a drawer toggle
 * outside `RunDetailShell` is meaningless. The gating itself lives in
 * the consuming components (NavBar, EventDrawer), which check
 * `DRAWER_ALLOWED_ROUTE_IDS` from `../router/routes.js` before
 * reading or writing this context. The context itself stays
 * agnostic so a test can mount it in isolation.
 *
 * Filename ends in `.ts` (not `.tsx`) on purpose: the fileScope for
 * this task only includes the `.ts` extension. We use
 * `React.createElement` rather than JSX in the provider so this file
 * stays parsable as plain TypeScript. Consumers that prefer JSX wrap
 * `EventDrawerProvider` themselves; the API is identical either way.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Shape exposed to consumers via {@link useEventDrawer}.
 *
 * `isOpen` is the canonical open/closed flag (closed by default).
 * `setOpen` sets the state explicitly; useful when a route transition
 * wants to force-close the drawer. `toggle` is the convenience used by
 * the nav button.
 */
export interface EventDrawerContextValue {
  readonly isOpen: boolean;
  readonly setOpen: (next: boolean) => void;
  readonly toggle: () => void;
}

/**
 * Default value used when a consumer reads the context outside any
 * provider. We choose a fail-loud default rather than a silent no-op:
 * a stray `useEventDrawer()` call in a tree that forgot the provider
 * is almost certainly a bug, and surfacing it via a thrown error
 * gives the developer a stack trace.
 */
const DEFAULT_VALUE: EventDrawerContextValue = Object.freeze({
  isOpen: false,
  setOpen: () => {
    throw new Error(
      "useEventDrawer was called outside an EventDrawerProvider. " +
        "Wrap the consuming tree in <EventDrawerProvider> first.",
    );
  },
  toggle: () => {
    throw new Error(
      "useEventDrawer was called outside an EventDrawerProvider. " +
        "Wrap the consuming tree in <EventDrawerProvider> first.",
    );
  },
});

const EventDrawerContext =
  createContext<EventDrawerContextValue>(DEFAULT_VALUE);

EventDrawerContext.displayName = "EventDrawerContext";

export interface EventDrawerProviderProps {
  readonly children: ReactNode;
  /**
   * Optional initial open state, defaulting to `false`. The drawer
   * **must** open collapsed on first mount; this prop exists for
   * Storybook / fixtures that want to render the expanded state for
   * screenshot review, not for production callers.
   */
  readonly initialOpen?: boolean;
}

/**
 * Provider that owns the drawer's open/closed state.
 *
 * Render-only unit-test sketch (run via Testing Library once the
 * renderer test harness lands):
 *   render(EventDrawerProvider({ children: <Consumer /> }));
 *   expect(consumer.isOpen).toBe(false);
 *   act(() => consumer.toggle());
 *   expect(consumer.isOpen).toBe(true);
 *
 * The provider intentionally does not re-create its memoised value
 * when `initialOpen` changes after mount — that prop is a one-shot
 * initial value, not a live-controlled flag. If a parent ever needs
 * controlled behaviour, lift state up and pass `setOpen` through.
 */
export function EventDrawerProvider(
  props: EventDrawerProviderProps,
): React.JSX.Element {
  const initialOpen = props.initialOpen ?? false;
  const [isOpen, setOpenState] = useState<boolean>(initialOpen);

  const setOpen = useCallback((next: boolean): void => {
    setOpenState(next);
  }, []);

  const toggle = useCallback((): void => {
    setOpenState((prev) => !prev);
  }, []);

  const value = useMemo<EventDrawerContextValue>(
    () => ({ isOpen, setOpen, toggle }),
    [isOpen, setOpen, toggle],
  );

  return React.createElement(
    EventDrawerContext.Provider,
    { value },
    props.children,
  );
}

/**
 * Consumer hook. Throws via the default-value setters if no provider
 * is in scope; see `DEFAULT_VALUE` above for the rationale.
 */
export function useEventDrawer(): EventDrawerContextValue {
  return useContext(EventDrawerContext);
}

/**
 * Exported only for unit tests that need to assert the default
 * "no provider" behaviour. Production code should never touch this.
 */
export const __INTERNAL_EVENT_DRAWER_CONTEXT = EventDrawerContext;
