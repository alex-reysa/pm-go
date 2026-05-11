/**
 * React context for the Right Inspector slot.
 *
 * The inspector is *controlled* (the parent layout owns its open/closed
 * state), *closed by default*, and only allowed to open on a curated
 * list of routes. Two facts drive that shape:
 *
 *   1. **Controlled, not auto-opening.** Per docs/desktop/03-information-
 *      architecture.md §Disclosure Rules: the inspector must not pop
 *      open of its own accord on route enter. The parent (route body
 *      or `RunDetailShell`) decides when to show it.
 *   2. **Allow-list enforcement.** The IA Route Map flags inspector
 *      allowance per-route. To prevent a route body from silently
 *      showing an inspector on, say, `/runs`, the provider carries the
 *      current route id plus the allowed-id set. `setOpen(true)` on a
 *      disallowed route is a no-op and a `console.warn` — fail loud in
 *      dev, silent in prod-bundled builds where the message would
 *      leak through the renderer console.
 *
 * Filename ends in `.ts` (not `.tsx`) to match the task's fileScope.
 * The provider uses `React.createElement` rather than JSX for the
 * same reason.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import type { RouteId } from "../router/types.js";

/**
 * Shape exposed by {@link useRightInspector}.
 *
 * `isOpen` reflects the controlled state. `setOpen(next)` is the
 * parent's setter; calling `setOpen(true)` from a disallowed route
 * leaves `isOpen` false and emits a `console.warn`. `currentRouteId`
 * lets consumers (e.g. RightInspector itself) skip rendering on
 * disallowed routes even if `isOpen` somehow flipped to `true`.
 * `isAllowedHere` is the pre-computed boolean for the current route,
 * surfaced so the inspector-toggle button can self-disable.
 */
export interface RightInspectorContextValue {
  readonly isOpen: boolean;
  readonly setOpen: (next: boolean) => void;
  readonly currentRouteId: RouteId | null;
  readonly allowedRouteIds: readonly RouteId[];
  readonly isAllowedHere: boolean;
}

const NO_PROVIDER_WARNING =
  "useRightInspector was called outside a RightInspectorProvider. " +
  "Wrap the consuming tree in <RightInspectorProvider> first.";

/**
 * Default value when no provider is in scope. Reads are inert (closed,
 * empty allow-list); writes throw, mirroring `drawerContext.ts`. We
 * choose this asymmetry deliberately: a missing provider for a
 * read-only consumer (e.g. a route body that asks "is the inspector
 * open?") should degrade to "no, it isn't" rather than crashing the
 * page, but a write attempt is a clear programming error that should
 * surface immediately.
 */
const DEFAULT_VALUE: RightInspectorContextValue = Object.freeze({
  isOpen: false,
  setOpen: () => {
    throw new Error(NO_PROVIDER_WARNING);
  },
  currentRouteId: null,
  allowedRouteIds: Object.freeze([]) as readonly RouteId[],
  isAllowedHere: false,
});

const RightInspectorContext =
  createContext<RightInspectorContextValue>(DEFAULT_VALUE);

RightInspectorContext.displayName = "RightInspectorContext";

export interface RightInspectorProviderProps {
  readonly children: ReactNode;
  /**
   * Controlled open state. Parents typically initialise this to
   * `false`; the inspector must stay closed on route enter regardless
   * of the value the parent kept across navigation.
   */
  readonly isOpen: boolean;
  /** Setter the parent uses to update `isOpen` from button clicks etc. */
  readonly setOpen: (next: boolean) => void;
  /**
   * The route id currently mounted, or `null` outside a route tree
   * (e.g. during the attach flow). Used to gate `setOpen(true)`.
   */
  readonly currentRouteId: RouteId | null;
  /**
   * Allow-list of route ids on which the inspector may open. Pass
   * `INSPECTOR_ALLOWED_ROUTE_IDS` from `../router/routes.js` by
   * default; smaller subsets are accepted for surfaces that want a
   * tighter scope (e.g. a feature-flagged preview that should only
   * surface the inspector on `/runs/:planId`).
   */
  readonly allowedRouteIds: readonly RouteId[];
}

/**
 * Controlled provider. The parent owns `isOpen` + `setOpen`; the
 * provider's only logic is wrapping `setOpen` so that opening on a
 * disallowed route is silently rejected with a `console.warn`.
 */
export function RightInspectorProvider(
  props: RightInspectorProviderProps,
): React.JSX.Element {
  const {
    children,
    isOpen,
    setOpen: rawSetOpen,
    currentRouteId,
    allowedRouteIds,
  } = props;

  const isAllowedHere =
    currentRouteId !== null && allowedRouteIds.includes(currentRouteId);

  const setOpen = useCallback(
    (next: boolean): void => {
      if (next && !isAllowedHere) {
        // Dev guard: a route body tried to open the inspector on a
        // route flagged "inspector NOT allowed" by the IA. We do not
        // mutate state in this case; the inspector stays closed.
        // eslint-disable-next-line no-console -- intentional dev signal
        console.warn(
          `RightInspectorProvider: refused to open inspector on route ` +
            `"${currentRouteId ?? "<none>"}" — not in allowedRouteIds.`,
        );
        return;
      }
      rawSetOpen(next);
    },
    [isAllowedHere, currentRouteId, rawSetOpen],
  );

  const value = useMemo<RightInspectorContextValue>(
    () => ({
      isOpen: isOpen && isAllowedHere,
      setOpen,
      currentRouteId,
      allowedRouteIds,
      isAllowedHere,
    }),
    [isOpen, isAllowedHere, setOpen, currentRouteId, allowedRouteIds],
  );

  return React.createElement(
    RightInspectorContext.Provider,
    { value },
    children,
  );
}

/**
 * Consumer hook. Reading without a provider returns the inert default
 * (closed, no route, empty allow-list); writing throws — see
 * `DEFAULT_VALUE` for rationale.
 */
export function useRightInspector(): RightInspectorContextValue {
  return useContext(RightInspectorContext);
}

/**
 * Exported only for unit tests that want to assert the default
 * "no provider" behaviour. Production code should never touch this.
 */
export const __INTERNAL_RIGHT_INSPECTOR_CONTEXT = RightInspectorContext;
