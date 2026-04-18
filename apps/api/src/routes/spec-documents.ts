import { Hono } from "hono";
import type { Client as TemporalClient } from "@temporalio/client";
import { validateSpecDocument } from "@pm-go/contracts";
import type {
  SpecDocument,
  SpecToPlanWorkflowInput
} from "@pm-go/contracts";

export interface SpecDocumentsRouteDeps {
  temporal: TemporalClient;
  taskQueue: string;
  workflowName: string;
}

export function createSpecDocumentsRoute(deps: SpecDocumentsRouteDeps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!validateSpecDocument(body)) {
      return c.json({ error: "invalid SpecDocument payload" }, 400);
    }
    const specDocument = body as SpecDocument;

    // Phase 2 contract: SpecToPlanWorkflowInput carries UUID references, not
    // inline SpecDocument / RepoSnapshot objects. The API+Smoke lane replaces
    // this placeholder snapshot id with a real repo-snapshot lookup/ingest.
    const workflowInput: SpecToPlanWorkflowInput = {
      specDocumentId: specDocument.id,
      repoSnapshotId: "00000000-0000-0000-0000-000000000000",
      requestedBy: "api"
    };

    const handle = await deps.temporal.workflow.start(deps.workflowName, {
      args: [workflowInput],
      taskQueue: deps.taskQueue,
      workflowId: `spec-intake-${specDocument.id}`
    });

    return c.json(
      {
        specDocumentId: specDocument.id,
        workflowRunId: handle.firstExecutionRunId
      },
      202
    );
  });

  return app;
}
