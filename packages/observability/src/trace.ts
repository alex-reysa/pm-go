import type { UUID } from "@pm-go/contracts";
import type { TraceContext } from "@pm-go/contracts/observability";

import { newUuid } from "./ids.js";

/**
 * Reserve a fresh `{ traceId, rootSpanId }` pair for a new plan
 * lifecycle. **Intentionally side-effect-free.** No DB row is
 * persisted here — the caller is responsible for emitting an event
 * (typically the first `withSpan` invocation under the new trace)
 * that threads these ids into `workflow_events`. Keeping
 * `startTrace` pure means it is safe to call from any context,
 * including pre-workflow bootstrap code where no DB handle exists.
 *
 * The `planId` argument is currently unused by the reservation
 * itself — it is accepted so callers can log the association and
 * so a future upgrade to plan-bound trace ids (e.g. deterministic
 * namespaced UUIDs) doesn't change the signature.
 */
export function startTrace(planId: UUID): TraceContext {
  void planId;
  return {
    traceId: newUuid(),
    rootSpanId: newUuid(),
  };
}
