import type { UUID } from "@pm-go/contracts";

/**
 * TUI-local route shape. Worker 3 may add `release` when it lands the
 * release view; `help` is a transient overlay on top of any route.
 */
export type Route =
  | { name: "plans" }
  | { name: "plan"; planId: UUID };
