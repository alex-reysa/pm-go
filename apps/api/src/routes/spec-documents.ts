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

    const workflowInput: SpecToPlanWorkflowInput = {
      specDocument,
      // repoSnapshot and requestedBy are required by SpecToPlanWorkflowInput but
      // Phase 1b stub workflow only touches specDocument. Pass minimal
      // placeholders so the type contract is satisfied end-to-end.
      repoSnapshot: {
        id: "00000000-0000-0000-0000-000000000000",
        repoRoot: "/",
        defaultBranch: "main",
        headSha: "0000000000000000000000000000000000000000",
        languageHints: [],
        frameworkHints: [],
        buildCommands: [],
        testCommands: [],
        ciConfigPaths: [],
        capturedAt: new Date().toISOString()
      },
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
