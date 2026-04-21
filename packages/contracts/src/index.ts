export * from "./events.js";
export * from "./execution.js";
export * from "./plan.js";
export * from "./policy.js";
export * from "./review.js";
export * from "./workflow.js";
export * from "./shared/schema.js";
export * from "./validators/core/index.js";
export * from "./validators/orchestration-review/index.js";
export * from "./validators/events/index.js";
export * from "./json-schema/core/index.js";
export * from "./json-schema/orchestration-review/index.js";
export * from "./json-schema/events/index.js";

// Phase 7 — Worker 4 reconcile.
//
// `policy-exports.ts` is fully covered by `export * from "./policy.js"` +
// the validator/json-schema barrels above (it's a sub-barrel that
// Worker 1 wrote so we could merge cleanly without three-way conflicts;
// re-exporting it here is a no-op but keeps the barrel discoverable for
// downstream code that imports from `@pm-go/contracts/policy-exports`).
//
// `observability-exports.ts` IS load-bearing — `Span`, `SpanContext`,
// `TraceContext`, `SpanStatus` and their validators / JSON schemas are
// only reachable through this sub-barrel. Phase 7 W4 wires them into
// the root surface so `import { Span } from "@pm-go/contracts"` works.
export * from "./policy-exports.js";
export * from "./observability-exports.js";

