import { eq } from "drizzle-orm";

import { mergeRuns, type PmGoDb } from "@pm-go/db";

/**
 * Build the deterministic workflow id used by the integrate route to
 * START the latest PhaseIntegrationWorkflow run. Returns null when no
 * merge_runs row exists for the phase yet (no integrate has been
 * issued, so there is no live workflow to signal).
 *
 * The integrate route (apps/api/src/routes/phases.ts:155) builds:
 *   `phase-integrate-${phaseId}-${mergeRunIndex}`
 * where `mergeRunIndex = (count of merge_runs for this phase) + 1` at
 * START time. After the start, the merge_runs row count for the
 * phase IS the latest mergeRunIndex.
 *
 * Pre-v0.8.2.1, every signal site used the wrong format —
 * `phase-integration-${phaseId}` (different prefix, missing index).
 * Signals never reached the live workflow, v0.8.2 silently swallowed
 * the resulting WorkflowNotFoundError, and the integration workflow
 * waited 24h on a signal that never arrived. v0.8.2.1 P1.1 fixes the
 * id reconstruction; v0.8.2.1 P1.2 adds DB re-polling inside the
 * workflow as defence-in-depth.
 */
export async function resolveLatestIntegrationWorkflowId(
  db: PmGoDb,
  phaseId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: mergeRuns.id })
    .from(mergeRuns)
    .where(eq(mergeRuns.phaseId, phaseId));
  if (rows.length === 0) return null;
  const mergeRunIndex = rows.length;
  return `phase-integrate-${phaseId}-${mergeRunIndex}`;
}
