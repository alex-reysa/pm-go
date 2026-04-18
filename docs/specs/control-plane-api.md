# Control-Plane API

This is the initial API shape for the Node control plane. The UI should consume these contracts rather than reaching into workflow internals directly.

## Principles

- keep request handlers thin
- use the API to start workflows, signal workflows, and query durable state
- stream durable events to the UI instead of synthesizing transient state client-side

## Recommended Endpoints

### `POST /spec-documents`

Create and persist a spec document.

Request body:

- `title`
- `body`
- `repoRoot`
- optional `repoUrl`

Response:

- persisted `specDocumentId`
- initial `repoSnapshotId`

### `POST /plans`

Start `SpecToPlanWorkflow`.

Request body:

- `specDocumentId`
- `repoSnapshotId`

Response:

- `planId`
- `workflowRunId`

### `POST /plans/:planId/audit`

Start `PlanAuditWorkflow` or signal re-audit.

### `GET /plans/:planId`

Return the structured plan plus rendered artifacts and current status.

### `POST /tasks/:taskId/run`

Start `TaskExecutionWorkflow`.

### `POST /tasks/:taskId/approve`

Record a human approval decision and signal the blocked workflow.

### `POST /tasks/:taskId/retry`

Retry a blocked or failed task if policy allows it.

### `GET /tasks/:taskId`

Return task status, assigned branch/worktree, latest review outcome, and policy state.

### `POST /merges`

Start `IntegrationWorkflow` for an approved plan or subset of ready tasks.

### `POST /plans/:planId/completion-audit`

Start `CompletionAuditWorkflow` against the latest merged state.

### `GET /completion-audits/:completionAuditId`

Return the checklist, findings, evidence references, and release-readiness
verdict for a completion audit run.

### `POST /releases`

Start `FinalReleaseWorkflow` from a passing `completionAuditReportId`.

### `GET /events`

Stream durable event-log updates via SSE.

## UI Boundaries

The UI should be able to answer these questions from API payloads alone:

- What plan is running?
- Which tasks are blocked and why?
- Which findings are open?
- Which merges are waiting?
- Which approvals are outstanding?
- Is the plan actually release-ready according to audited evidence?
