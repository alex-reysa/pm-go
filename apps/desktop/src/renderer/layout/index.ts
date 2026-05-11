/**
 * Public barrel for `apps/desktop/src/renderer/layout/`.
 *
 * Phase-1 route bodies and the router config import from this barrel
 * rather than reaching into individual files. Keeping the public
 * surface here lets us reshuffle internals (e.g. splitting AppShell
 * into header / body / footer files) without touching every consumer.
 */

export { AppShell, type AppShellProps } from "./AppShell.js";
export { NavBar, type NavBarItem, type NavBarProps } from "./NavBar.js";
export {
  EventDrawer,
  EventDrawerToggle,
  type EventDrawerProps,
} from "./EventDrawer.js";
export {
  RightInspector,
  RightInspectorToggle,
  type RightInspectorProps,
} from "./RightInspector.js";
export {
  ConfirmationModal,
  type ConfirmationModalProps,
} from "./ConfirmationModal.js";
export {
  RunDetailShell,
  type RunDetailShellProps,
} from "./RunDetailShell.js";

export {
  EventDrawerProvider,
  useEventDrawer,
  type EventDrawerContextValue,
  type EventDrawerProviderProps,
} from "./drawerContext.js";
export {
  RightInspectorProvider,
  useRightInspector,
  type RightInspectorContextValue,
  type RightInspectorProviderProps,
} from "./inspectorContext.js";
export {
  LiveDataProvider,
  useLiveData,
  useLiveRun,
  useLiveRuns,
  type LiveApiError,
  type LiveDataContextValue,
  type LiveDataProviderProps,
  type LiveResourceState,
  type LiveRunResource,
  type LiveRunsResource,
} from "./liveDataContext.js";
