# Control-Plane API

The API is the operator and UI boundary for pm-go. It starts workflows, signals
blocked workflows, and reads durable state from Postgres. Clients should use this
surface instead of reaching into Temporal or database tables directly.

Default base URL:

```text
http://localhost:3001
```

Health check:

```bash
curl -sS http://localhost:3001/health
```

## Product Flow

```text
POST /spec-documents
POST /plans
POST /tasks/:taskId/run
POST /tasks/:taskId/review
POST /tasks/:taskId/fix          # only when review asks for changes
POST /phases/:phaseId/integrate
POST /tasks/:taskId/approve      # only when an approval gate exists
POST /phases/:phaseId/audit
POST /plans/:planId/complete
POST /plans/:planId/release
```

For a full walkthrough, see [../getting-started.md](../getting-started.md).

## Conventions

- IDs are UUID strings.
- Mutating endpoints return `202` when they start a Temporal workflow and `200`
  when they synchronously update durable state.
- State-machine conflicts return `409` with an actionable `error` message.
- `requestedBy`, `approvedBy`, and `overriddenBy` are operator labels for audit
  trails. Use an email, username, CI job id, or `local-dev`.
- The database is the durable read model. Temporal workflow IDs are an
  implementation detail except in logs.

## Operating Principles

These apply across the surface; they save more debugging time than any single
endpoint detail.

- **Inspect before forcing.** Before issuing an action that might 409, hit the
  matching `GET /plans/:id`, `GET /tasks/:id`, or `GET /phases/:id`. Errors
  carry actionable text but the read model carries the full state machine.
- **Bulk-approve over per-row loops.** When a plan has many low-risk reviewed
  tasks, prefer `POST /plans/:planId/approve-all-pending` to scripting
  per-task approves. The bulk endpoint also enforces the "review pass /
  skip-policy / merge-ready" gate per row, so it cannot silently approve
  unreviewed work.
- **Overrides encode human judgment, not blocker bypass.** `/override-review`
  is for review false positives; `/override-audit` is for accepted audit
  outcomes. They refuse (409) when the actual blocker is a budget overrun, a
  scope violation, a partition failure, an approval timeout, a merge
  failure, or a test failure. Fix the cause and re-drive instead.
- **Release means a passing completion audit landed.** A plan is not ready
  to release until `POST /plans/:id/complete` produces an audit with
  `outcome="pass"`. `POST /plans/:id/release` enforces this precondition.

## Spec And Plan

### `POST /spec-documents`

Persist a user feature spec and capture a repo snapshot.

```json
{
  "title": "Add phase detail endpoint",
  "body": "Markdown feature spec...",
  "repoRoot": "/absolute/path/to/repo",
  "source": "manual"
}
```

`source` is optional and defaults to `manual`. Response:

```json
{
  "specDocumentId": "uuid",
  "repoSnapshotId": "uuid"
}
```

### `POST /plans`

Start `SpecToPlanWorkflow`.

```json
{
  "specDocumentId": "uuid",
  "repoSnapshotId": "uuid",
  "requestedBy": "local-dev"
}
```

`requestedBy` is optional and defaults to `api`. Response:

```json
{
  "planId": "uuid",
  "workflowRunId": "temporal-run-id"
}
```

### `GET /plans`

List plans for dashboards. Returns summaries, not full task trees.

### `GET /plans/:planId`

Return the reconstructed `Plan`, artifact IDs, and latest completion audit:

```json
{
  "plan": {},
  "artifactIds": ["uuid"],
  "latestCompletionAudit": null
}
```

### `POST /plans/:planId/audit`

Run deterministic plan audit against the stored plan. Synchronous; no Temporal
workflow is started.

Response:

```json
{
  "planId": "uuid",
  "approved": true,
  "revisionRequested": false,
  "findings": []
}
```

`approved` is the inverse of `revisionRequested`. `findings` is empty when
`approved=true`; otherwise each entry carries `id`, `severity`, `title`,
`summary`, `filePath`, `confidence`, and `suggestedFixDirection`.

## Task Execution

### `GET /tasks`

List task summaries. Supports the dashboard use case; use `GET /tasks/:taskId`
for full task state.

### `GET /tasks/:taskId`

Return task details, latest agent run, latest worktree lease, and latest review
report.

### `POST /tasks/:taskId/run`

Start `TaskExecutionWorkflow`.

Precondition: the owning phase is `executing`.

```json
{
  "requestedBy": "local-dev"
}
```

Response:

```json
{
  "taskId": "uuid",
  "workflowRunId": "temporal-run-id"
}
```

### `POST /tasks/:taskId/review`

Start `TaskReviewWorkflow`. Use when a task is `in_review`.

Response includes the review cycle number.

### `POST /tasks/:taskId/fix`

Start `TaskFixWorkflow` against the latest review report.

Preconditions:

- task status is `fixing`;
- latest review report outcome is `changes_requested`.

### `GET /tasks/:taskId/review-reports`

Return chronological review reports for a task.

### `POST /tasks/:taskId/override-review`

Operator override for a review false positive.

```json
{
  "reason": "Reviewer finding is already covered by test X.",
  "overriddenBy": "local-dev"
}
```

This writes a human `policy_decisions` row and marks the task
`ready_to_merge`. It is intentionally narrow: budget and file-scope blockers
must be fixed and re-driven, not bypassed through this endpoint.

## Phase Integration And Audit

### `GET /phases`

List phase summaries.

### `GET /phases/:phaseId`

Return phase row, latest merge run, and latest phase audit.

### `POST /phases/:phaseId/integrate`

Start `PhaseIntegrationWorkflow`.

Preconditions:

- phase status is `executing` or `integrating`;
- every task in the phase is `ready_to_merge` or `merged`.

Response:

```json
{
  "phaseId": "uuid",
  "workflowRunId": "temporal-run-id",
  "mergeRunIndex": 1
}
```

### `GET /merge-runs/:id`

Return a merge run.

### `POST /phases/:phaseId/audit`

Start `PhaseAuditWorkflow`.

Preconditions:

- phase status is `auditing`;
- latest merge run completed without `failedTaskId`;
- latest merge run has `integrationHeadSha`.

```json
{
  "requestedBy": "local-dev"
}
```

### `GET /phase-audit-reports/:id`

Return a phase audit report.

### `POST /phases/:phaseId/override-audit`

Operator override for a blocked or changes-requested phase audit.

```json
{
  "reason": "Audit finding is accepted for this internal release.",
  "overriddenBy": "local-dev"
}
```

This stamps override evidence on the latest phase audit report and marks the
phase `completed`. It only applies to phases blocked by audit evidence.

## Approvals And Policy

### `GET /approvals?planId=:planId`

List approval requests for a plan, newest first.

### `POST /tasks/:taskId/approve`

Approve the latest pending task-scoped approval request.

```json
{
  "approvedBy": "local-dev"
}
```

### `POST /plans/:planId/approve`

Approve the latest pending plan-scoped approval request.

```json
{
  "approvedBy": "local-dev"
}
```

### `POST /plans/:planId/approve-all-pending`

Bulk approve every eligible pending approval request for a plan.

Request body:

```json
{
  "approvedBy": "local-dev",
  "reason": "Local dogfood approval after review pass."
}
```

`reason` is required. The endpoint skips catastrophic risk rows and task rows
without review pass, small-task skip policy, or merge-ready status.

Response:

```json
{
  "planId": "uuid",
  "approvedCount": 2,
  "approvedIds": ["uuid", "uuid"],
  "skippedCount": 1,
  "skipped": [
    {
      "id": "uuid",
      "taskId": "uuid",
      "reason": "riskBand=catastrophic"
    }
  ]
}
```

After flipping rows, the API signals the live `PhaseIntegrationWorkflow` for
each affected phase. The durable approval row is the source of truth — a
missing live workflow logs and continues; the next workflow run picks up the
approved row from the ledger.

### `GET /plans/:planId/budget-report`

Return the latest budget snapshot for a plan.

## Completion And Release

### `POST /plans/:planId/complete`

Start `CompletionAuditWorkflow`.

Precondition: every phase is `completed`.

```json
{
  "requestedBy": "local-dev"
}
```

Response:

```json
{
  "planId": "uuid",
  "workflowRunId": "temporal-run-id",
  "auditIndex": 1
}
```

### `GET /completion-audit-reports/:id`

Return a completion audit report.

### `POST /plans/:planId/release`

Start `FinalReleaseWorkflow`.

Precondition: the plan has a latest completion audit with `outcome="pass"`.

Response includes a workflow run ID and release index.

## Artifacts, Runs, And Events

### `GET /artifacts/:id`

Read an artifact by ID. The server enforces path containment under
`PLAN_ARTIFACT_DIR`.

### `GET /agent-runs`

List agent runs for dashboards and diagnostics.

### `GET /events?planId=:planId`

Return durable workflow events as JSON.

Optional query:

- `sinceEventId`: replay events after a known event.

Response:

```json
{
  "planId": "uuid",
  "events": [
    {
      "id": "uuid",
      "kind": "task_status_changed",
      "createdAt": "2026-04-25T10:00:00.000Z"
    }
  ],
  "lastEventId": "uuid"
}
```

`lastEventId` echoes the most recent event id in the page so a polling
client can pass it back as `?sinceEventId=` without re-reading the array.

### `GET /events?planId=:planId` with `Accept: text/event-stream`

Stream events as SSE. The TUI uses this path to update plan detail screens.
The server replays history first, then emits new events on a 1.5s tick, plus
a heartbeat comment every 15s to keep proxies from closing the connection.

## See Also

- [Getting started](../getting-started.md) — full walkthrough.
- [Runtimes](../runtimes.md) — runtime mode resolution and diagnostics.
- [Domain model](domain-model.md) — durable objects and invariants behind
  the routes above.
