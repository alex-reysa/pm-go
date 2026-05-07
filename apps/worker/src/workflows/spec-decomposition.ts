import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  MilestoneManifest,
  SpecDecomposition,
  SpecDecompositionWorkflowInput,
  SpecDecompositionWorkflowResult,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

/**
 * Activity contract used by `SpecDecompositionWorkflow`. Mirrors the
 * `SpecToPlanActivities` shape — the workflow sandbox forbids dynamic
 * I/O imports so every side-effecting step hides behind this interface.
 */
interface SpecDecompositionActivities {
  initSpecDecomposition(input: {
    decompositionId: string;
    specDocumentId: string;
    repoSnapshotId: string;
  }): Promise<void>;
  markSpecDecompositionRunning(input: {
    decompositionId: string;
  }): Promise<void>;
  runDecomposerActivity(input: {
    specDocumentId: string;
    repoSnapshotId: string;
    requestedBy: string;
  }): Promise<{ manifest: MilestoneManifest; agentRun: AgentRun }>;
  finalizeSpecDecompositionReady(input: {
    decompositionId: string;
    manifest: MilestoneManifest;
  }): Promise<SpecDecomposition>;
  finalizeSpecDecompositionFailed(input: {
    decompositionId: string;
    errorReason: string;
  }): Promise<SpecDecomposition>;
  persistAgentRun(run: AgentRun): Promise<string>;
}

// `runDecomposerActivity` is the Opus call — give it the same generous
// 30-minute window the planner uses, since large specs (>50KB) take
// 5-10 minutes to decompose and we want to fail fast on retries rather
// than retry mid-call.
const { runDecomposerActivity } = proxyActivities<SpecDecompositionActivities>({
  startToCloseTimeout: "30 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("SpecDecompositionWorkflow")),
});

const {
  initSpecDecomposition,
  markSpecDecompositionRunning,
  finalizeSpecDecompositionReady,
  finalizeSpecDecompositionFailed,
  persistAgentRun,
} = proxyActivities<SpecDecompositionActivities>({
  startToCloseTimeout: "5 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("SpecDecompositionWorkflow")),
});

/**
 * Spec-to-manifest orchestration:
 *
 * 1. Insert the `pending` spec_decompositions row so an API caller
 *    polling `GET /spec-documents/:id/decompositions/:decompositionId`
 *    immediately after `POST /decompose` always finds the row.
 * 2. Flip status to `running` so the operator can see the workflow is
 *    actually executing the decomposer.
 * 3. Run the decomposer agent against the persisted spec + repo
 *    snapshot. The activity validates and audits the manifest before
 *    returning, so any structurally-bad output throws here.
 * 4. Persist the planner-shape AgentRun row for telemetry.
 * 5. Flip the row to `ready` with the manifest stored, or `failed`
 *    with an `error_reason` if step 3 threw.
 *
 * On any failure the catch path writes `failed` so the row never gets
 * stuck in `running`. The original error is re-thrown so Temporal sees
 * a workflow failure (and so retry policy can apply on transient
 * errors).
 */
export async function SpecDecompositionWorkflow(
  input: SpecDecompositionWorkflowInput,
): Promise<SpecDecompositionWorkflowResult> {
  await initSpecDecomposition({
    decompositionId: input.decompositionId,
    specDocumentId: input.specDocumentId,
    repoSnapshotId: input.repoSnapshotId,
  });
  await markSpecDecompositionRunning({
    decompositionId: input.decompositionId,
  });

  // Wrap every post-`markSpecDecompositionRunning` step in one catch
  // arm so a retry-exhausted failure in `persistAgentRun` or
  // `finalizeSpecDecompositionReady` cannot leave the row stuck at
  // `running`. Any throw past this point falls through to a
  // best-effort `finalize…Failed` and re-raises the original error so
  // Temporal's retry policy still sees it.
  try {
    const result = await runDecomposerActivity({
      specDocumentId: input.specDocumentId,
      repoSnapshotId: input.repoSnapshotId,
      requestedBy: input.requestedBy,
    });
    const manifest = result.manifest;
    const agentRun = result.agentRun;

    await persistAgentRun(agentRun);

    const decomposition = await finalizeSpecDecompositionReady({
      decompositionId: input.decompositionId,
      manifest,
    });

    return { decomposition };
  } catch (err) {
    const errorReason = describeWorkflowError(err);
    // Best-effort flip to `failed`. If this also throws (extremely
    // unlikely once we already passed `init` and `markRunning`, but
    // possible if the DB is gone), let the failure path's secondary
    // exception bubble — Temporal will retry the workflow per policy.
    let decomposition: SpecDecomposition | undefined;
    try {
      decomposition = await finalizeSpecDecompositionFailed({
        decompositionId: input.decompositionId,
        errorReason,
      });
    } catch (finalizeErr) {
      // Don't mask the original error. Wrap both into the
      // ApplicationFailure so an operator can see the chain.
      throw ApplicationFailure.create({
        message: `${errorReason} (and finalize-failed also threw: ${
          finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)
        })`,
        type: "SpecDecompositionFailure",
        nonRetryable: false,
      });
    }
    throw ApplicationFailure.create({
      message: errorReason,
      type: "SpecDecompositionFailure",
      nonRetryable: errorReason.startsWith("manifest validation failed"),
      details: [decomposition],
    });
  }
}

/**
 * Pull a sanitized one-liner out of an unknown caught value. Workflow
 * code cannot import `errorReasonForDecomposerFailure` from the
 * activity module (Temporal's workflow sandbox rejects activity-side
 * imports), so the same shape is reproduced here. Activity-level
 * sanitization still runs — this is the workflow-side fallback for
 * any synthetic error Temporal raises (e.g. activity timeout).
 */
function describeWorkflowError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split("\n", 1)[0]!.slice(0, 500);
  }
  return "unknown decomposer error";
}
