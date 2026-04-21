import { randomUUID } from "node:crypto";

import type { UUID } from "@pm-go/contracts";

/**
 * UUID generator, factored out so tests can replace it. Phase 7 spans
 * use RFC 4122 UUIDs (v4) for both trace and span ids instead of the
 * OTel-native 16-byte / 8-byte hex ids so the values can be stored in
 * `text` columns alongside the rest of pm-go's correlation keys
 * (plan/phase/task/run ids are all UUIDs). If Phase 8 introduces a
 * workflow-level interceptor that talks to an external OTel exporter,
 * that layer can translate.
 */
export function newUuid(): UUID {
  return randomUUID();
}
