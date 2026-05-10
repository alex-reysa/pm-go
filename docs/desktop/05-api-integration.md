# pm-go Desktop API Integration

## Purpose

Desktop MVP is an attach-first client for the existing pm-go control-plane API.
It should not call Postgres, Temporal, Docker, git worktrees, or worker code
directly. Durable pm-go state is read and mutated only through `apps/api`.

This document maps Desktop UI requirements to the current HTTP/SSE surface and
defines the frontend read models Desktop should build on top of that surface.
The API remains the authority for state-machine rules; Desktop-side gates are
operator convenience only.

## Connection Model

### Health Identity

Desktop should treat the API as connected only after `GET /health` returns the
current identity envelope:

| Field | Required | Desktop use |
|---|---:|---|
| `status: "ok"` | yes | Basic liveness. |
| `service: "pm-go-api"` | yes | Guards against attaching to another service on the port. |
| `version` | yes | Display in settings/about and include in diagnostics. |
| `instance` | yes | Display connected stack identity. |
| `port` | yes | Verify the bound port matches the configured target when useful. |

The legacy `{ "status": "ok" }` shape is not sufficient for Desktop MVP except
behind an explicit dev-only override. A 2xx health response from a foreign
service must not unlock the runs list.

Current implementation note: `apps/api` can still emit the legacy shape when
identity dependencies are not wired in tests or older call sites. Desktop
should treat the production entrypoint identity envelope as its contract and
make any legacy acceptance an explicit dev-only mode. Updating older API
diagnostics docs is a follow-up, not a reason to weaken Desktop attachment.

### Attach States

| State | Meaning | Primary UI behavior |
|---|---|---|
| `not_configured` | No usable base URL after loading config. | Show attach form with default suggestion. |
| `probing` | `GET /health` is in flight. | Disable actions that require API state. |
| `connected` | Identity accepted. | Load runs and allow normal navigation. |
| `api_unreachable` | Network error, refused connection, DNS failure, timeout, or abort. | Show retry and stack-start hints such as `pm-go run --repo <repo>`. |
| `foreign_service` | HTTP responded but did not identify as `pm-go-api`. | Warn that the configured port is owned by another service. |
| `api_error` | Health passed, but a later endpoint failed. | Keep connection, show endpoint-specific recovery. |
| `stream_reconnecting` | HTTP reads work, but SSE is reconnecting. | Keep stale run data visible, show live-update degraded state. |

Desktop should remember the last successful base URL and selected plan id in
Desktop-local config only. It should not persist copied plan/task/approval
state as authority.

### Base URL Normalization

Use one normalization function for probes, JSON calls, artifact fetches, and
SSE:

1. Trim whitespace.
2. If empty, use `http://localhost:3001`.
3. Accept only `http:` and `https:` URLs. For local convenience, Desktop may
   convert `localhost:3001` or `127.0.0.1:3001` to `http://...`.
4. Reject credentials, query strings, and fragments.
5. Remove trailing slashes from the pathname.
6. Store and display the normalized value.
7. Construct request URLs with URL APIs rather than string concatenation.

The current TUI strips trailing slashes from `PM_GO_API_BASE_URL`; Desktop
should preserve that behavior and add validation suitable for a persisted
settings field.

## HTTP Client Behavior

### Request Conventions

| Request type | Desktop behavior |
|---|---|
| JSON reads | Send `Accept: application/json`; parse response text once; treat empty body as `null`. |
| JSON writes | Send `Content-Type: application/json`; include operator labels such as `requestedBy`, `approvedBy`, or `overriddenBy` when endpoints accept them. |
| Artifact reads | Use `GET /artifacts/:id`; do not fetch artifact `file://` URIs directly from the renderer. |
| SSE | Send `Accept: text/event-stream` to `GET /events?planId=...`. |

### Error Model

Desktop should use an `ApiError` equivalent that preserves:

| Field | Purpose |
|---|---|
| `status` | Branch on `400`, `403`, `404`, `409`, `5xx`, and network failures. |
| `body` | Preserve structured details such as `blockedPhaseIds`, `unreadyTaskIds`, or bulk-approval `skipped`. |
| `message` | Prefer `body.error` when present; otherwise use response text or `HTTP <status>`. |
| `requestId` | Nice to have if the API later emits one. |

`409 Conflict` is an expected operator precondition failure, not a crash. Render
the server's `error` inline near the action that was attempted, refresh the
relevant read models, and keep the operator on the same screen. Examples:

| Endpoint | Common `409` meaning |
|---|---|
| `POST /tasks/:taskId/run` | Owning phase is not `executing`. |
| `POST /tasks/:taskId/fix` | Task is not `fixing`, or latest review did not request changes. |
| `POST /phases/:phaseId/integrate` | Phase is not executable or tasks are not merge-ready. |
| `POST /phases/:phaseId/audit` | Phase is not `auditing`, merge run failed, or no integration head exists. |
| `POST /plans/:planId/complete` | Not every phase is completed or the final merge run is missing. |
| `POST /plans/:planId/release` | No passing completion audit is stamped on the plan. |
| `POST /tasks/:taskId/approve` | No pending task-scoped approval row exists. |
| `POST /plans/:planId/approve` | No pending plan-scoped approval row exists. |
| `POST /plans/:planId/approve-all-pending` | Missing `reason` is `400`; skipped rows are returned in a `200` body. |
| `PUT /spec-documents/:id/decompositions/:id/manifest` | Decomposition is not ready or provenance is frozen. |
| `POST /spec-documents/:id/decompositions/:id/plan-first` | Decomposition is not ready, has no milestones, or already has plan-first in flight. |

For `400`, keep the user in the form or modal and point to the invalid field
when the message identifies one. For `403` artifact responses, show the
artifact context but do not offer an alternate local path open. For `404`,
invalidate stale cached data and offer a reload. For `5xx`, preserve the action
context and point to API/worker diagnostics rather than retrying in a tight
loop.

## SSE And Refresh

### Subscription

Desktop should subscribe only after a run is selected:

```text
GET /events?planId=<planId>
Accept: text/event-stream
```

The server sends:

- a `ready` handshake event that is not a `WorkflowEvent`;
- replayed historical events after `sinceEventId`, if provided;
- live events polled from durable storage about every 1.5 seconds;
- heartbeat comments about every 15 seconds.

Current workflow event kinds:

| Kind | Invalidate |
|---|---|
| `phase_status_changed` | Plan detail, phases, runs list. |
| `task_status_changed` | Plan detail, task lists, selected task detail when relevant. |
| `artifact_persisted` | Plan detail, evidence/artifact views, release view. |

The TUI currently filters to those known kinds. Desktop should do the same but
log unknown future kinds at debug level and continue.

### Replay Cursor

Maintain a per-plan event cursor:

1. Initialize from the last event id seen in memory for the selected plan.
2. Open SSE with `sinceEventId=<cursor>` when present.
3. On every parsed `WorkflowEvent`, set the cursor to `event.id`.
4. Also support JSON replay through
   `GET /events?planId=<planId>&sinceEventId=<cursor>`, using `lastEventId`
   from the response when polling.

The cursor is a live-resume aid, not durable truth. If a cursor returns `404`,
Desktop should clear that plan cursor and replay without `sinceEventId`.

### Reconnect

Use abortable reconnect with exponential backoff:

| Parameter | MVP default |
|---|---:|
| Initial backoff | 250 ms |
| Max backoff | 5 seconds |
| Reset | After receiving a real workflow event. |
| Stop | When leaving the run cockpit or changing API base URL. |

While reconnecting, leave current run state on screen and mark live updates as
reconnecting. Do not block manual refresh or actions solely because SSE is
down.

### Polling Fallback

If SSE cannot be opened or repeatedly fails, Desktop should poll the selected
run at a conservative interval, initially 5 seconds:

| Read | Route |
|---|---|
| Run detail | `GET /plans/:planId` |
| Phases | `GET /phases?planId=:planId` |
| Tasks | `GET /tasks?planId=:planId` |
| Approvals | `GET /approvals?planId=:planId` |
| Budget | `GET /plans/:planId/budget-report` |
| Events replay | `GET /events?planId=:planId&sinceEventId=:cursor` |

Polling should pause when the window is hidden unless a mutation is in flight.
Every successful mutation should trigger an immediate refresh of the affected
read models regardless of SSE state.

## Route Map

### Connection And Intake

| UI requirement | Route | Current response/use |
|---|---|---|
| Attach to API | `GET /health` | Accept only identity envelope with `service: "pm-go-api"`. |
| Create spec-backed run | `POST /spec-documents` | Send `{ title, body, repoRoot, source: "manual" }`; receives `{ specDocumentId, repoSnapshotId }`. |
| Start full-spec plan | `POST /plans` | Send `{ specDocumentId, repoSnapshotId, requestedBy }`; receives `{ planId, workflowRunId }`. |
| List resumable runs | `GET /plans` | Returns `{ plans }` summaries ordered by `updatedAt` descending. |
| Open run cockpit | `GET /plans/:planId` | Returns `{ plan, artifactIds, latestCompletionAudit }`. |

### Optional Decomposition Flow

Decomposition routes are relevant if Desktop includes a read-only or gated
Workflow Builder preview. They are not required for the default MVP new-spec
path. The default MVP should not expose manifest editing or plan-first
decomposition controls unless a separate Layer-A product slice accepts them.

| UI requirement | Route | Current response/use |
|---|---|---|
| Start milestone decomposition | `POST /spec-documents/:specDocumentId/decompose` | Send `{ repoSnapshotId, requestedBy }`; receives `{ decompositionId, workflowRunId }`. |
| Read decomposition | `GET /spec-documents/:specDocumentId/decompositions/:decompositionId` | Returns `{ decomposition }` with `status`, optional `manifest`, optional `errorReason`. |
| Edit manifest before plan-first | `PUT /spec-documents/:specDocumentId/decompositions/:decompositionId/manifest` | Future/gated Layer-A flow; not part of default Desktop MVP. |
| Plan first milestone | `POST /spec-documents/:specDocumentId/decompositions/:decompositionId/plan-first` | Future/gated Layer-A flow; not part of default Desktop MVP. |

### Cockpit Reads

| UI requirement | Route | Current response/use |
|---|---|---|
| Phase list | `GET /phases?planId=:planId` | Narrow phase summaries ordered by phase index. |
| Phase detail/audit context | `GET /phases/:phaseId` | Returns `{ phase, latestMergeRun, latestPhaseAudit }`. |
| Task list | `GET /tasks?planId=:planId` or `GET /tasks?phaseId=:phaseId` | Narrow task rows for cockpit grouping. |
| Task detail | `GET /tasks/:taskId` | Returns `{ task, latestAgentRun, latestLease, latestReviewReport, taskPolicyDecisions, reviewSkippedDecision? }`. |
| Review history | `GET /tasks/:taskId/review-reports` | Returns chronological `{ reports }`. |
| Agent runs | `GET /agent-runs?taskId=:taskId` or `GET /agent-runs?planId=:planId&role=:role` | Returns `{ agentRuns }` newest first. |
| Agent tool calls | `GET /agent-runs/:runId/tool-calls` | Optional drill-in for diagnostics. |
| Approvals | `GET /approvals?planId=:planId` | Returns `{ approvals }` newest first. |
| Budget | `GET /plans/:planId/budget-report` | Computes and persists a fresh `BudgetReport`. |
| Events | `GET /events?planId=:planId` | JSON replay; returns `{ events, lastEventId }`. |
| Artifacts | `GET /artifacts/:id` | Streams contained artifact bytes with kind-aware content type. |
| Merge run | `GET /merge-runs/:id` | Optional phase-detail drill-in. |
| Phase audit report | `GET /phase-audit-reports/:id` | Optional evidence drill-in. |
| Completion audit report | `GET /completion-audit-reports/:id` | Optional release/evidence drill-in; latest audit is already in plan detail. |

### Operator Actions

| UI action | Route | Success | Primary gate |
|---|---|---:|---|
| Audit stored plan | `POST /plans/:planId/audit` | `200` | Plan exists; returns deterministic audit findings without starting Temporal. |
| Run task | `POST /tasks/:taskId/run` | `202` | Owning phase is `executing`. |
| Review task | `POST /tasks/:taskId/review` | `202` | UX should target `task.status === "in_review"`; server starts review. |
| Fix task | `POST /tasks/:taskId/fix` | `202` | Task is `fixing`; latest review outcome is `changes_requested`. |
| Approve task gate | `POST /tasks/:taskId/approve` | `200` | Latest task-scoped approval is pending. |
| Override review | `POST /tasks/:taskId/override-review` | `200` | Task is `blocked` or `fixing`; reason required; budget/scope blockers refused. |
| Integrate phase | `POST /phases/:phaseId/integrate` | `202` | Phase is `executing` or `integrating`; all tasks ready to merge or merged. |
| Audit phase | `POST /phases/:phaseId/audit` | `202` | Phase is `auditing`; latest merge run completed with integration head. |
| Override phase audit | `POST /phases/:phaseId/override-audit` | `200` | Phase is `blocked`; latest audit is `blocked` or `changes_requested`; reason required. |
| Approve plan gate | `POST /plans/:planId/approve` | `200` | Latest plan-scoped approval is pending. |
| Bulk approve pending gates | `POST /plans/:planId/approve-all-pending` | `200` | Reason required; endpoint skips unsafe rows and returns skip reasons. |
| Complete plan | `POST /plans/:planId/complete` | `202` | Every phase is completed; final merge run exists. |
| Release plan | `POST /plans/:planId/release` | `202` | Latest stamped completion audit outcome is `pass`. |

Every mutating action should use a confirmation modal, send the operator label
where supported, optimistically mark only the action request as pending, and
refresh server state after completion. Do not optimistically change plan, phase,
task, approval, or artifact state before the API confirms.

### Action Request Contracts

Use the current API body contracts exactly. Unknown future fields should not be
invented in Desktop-only clients.

| UI action | Request body | Success body | Refresh after response |
|---|---|---|---|
| Create spec document | `{ title, body, repoRoot, source: "manual" }` | `201 { specDocumentId, repoSnapshotId }` | New run form state only. |
| Start plan | `{ specDocumentId, repoSnapshotId, requestedBy? }` | `202 { planId, workflowRunId }` | `GET /plans/:planId`, then runs list. |
| Audit stored plan | none required | `200 { planId, approved, revisionRequested, findings }` | Plan detail if persisted audit state is later added. |
| Run task | `{ requestedBy? }` or empty body | `202 { taskId, workflowRunId }` | Task detail, task list, phase, plan detail, events. |
| Review task | empty body | `202 { taskId, workflowRunId, cycleNumber }` | Task detail, review history, task list, events. |
| Fix task | empty body | `202 { taskId, workflowRunId, reviewReportId, cycleNumber }` | Task detail, review history, task list, events. |
| Approve task gate | `{ approvedBy? }` or empty body | `200 { taskId, approval }` | Approvals, task detail, phase/plan state. |
| Override review | `{ reason, overriddenBy? }` | `200 { taskId, previousStatus, newStatus, policyDecisionId, reason, overriddenBy? }` | Task detail, approvals/policy state, task list. |
| Integrate phase | empty body | `202 { phaseId, workflowRunId, mergeRunIndex }` | Phase detail, phase list, task list, plan detail, events. |
| Audit phase | `{ requestedBy? }` or empty body | `202 { phaseId, mergeRunId, workflowRunId, auditIndex }` | Phase detail, evidence, plan detail, events. |
| Override phase audit | `{ reason, overriddenBy? }` | `200 { phaseId, previousStatus, newStatus, auditReportId, reason, overriddenBy?, overriddenAt }` | Phase detail, phase list, evidence, plan detail. |
| Approve plan gate | `{ approvedBy? }` or empty body | `200 { planId, approval }` | Approvals, plan detail, phase list. |
| Bulk approve pending gates | `{ reason, approvedBy? }` | `200 { planId, approvedCount, approvedIds, skippedCount, skipped }` | Approvals, tasks, phases, plan detail. |
| Complete plan | `{ requestedBy? }` or empty body | `202 { planId, workflowRunId, auditIndex }` | Plan detail, release/evidence, events. |
| Release plan | empty body | `202 { planId, workflowRunId, releaseIndex }` | Plan detail, evidence/artifacts, events. |

Expected `400` bodies generally include `{ error }`, especially for missing
required `reason` fields. Expected `409` bodies include `{ error }` plus
endpoint-specific fields such as `blockedPhaseIds`, `unreadyTaskIds`, or
blocker descriptions. Bulk approval skip details are returned in the `200`
body and must be displayed, not treated as errors. Preserve the full body for
diagnostics.

## Frontend Read Models

The renderer should consume typed read models that are smaller and more
UI-focused than raw API payloads. Keep raw payloads available for evidence
drawers where fidelity matters.

### RunSummary

Backed primarily by `GET /plans`.

| Field | Source |
|---|---|
| `id` | `PlanListItem.id` |
| `title` / `summary` | `PlanListItem` |
| `status` | `PlanListItem.status` |
| `riskLevels` | Derived from `risks[].level` |
| `hasCompletionAudit` | `completionAuditReportId !== null` |
| `createdAt` / `updatedAt` | `PlanListItem` |
| `attention` | Derived after joining cockpit reads when available: pending approvals, blocked/failed phases/tasks, failed audits, release-ready. |

Nice-to-have gap: `GET /plans` does not include repo identity, spec title,
pending approval count, blocked count, current phase, or release readiness, so
the runs list must either stay narrow or hydrate selected/visible rows.

### RunDetail

Backed by `GET /plans/:planId` plus plan-scoped cockpit reads.

| Field | Source |
|---|---|
| `plan` | `plan` |
| `phases` | `GET /phases?planId` or `plan.phases` |
| `tasks` | `GET /tasks?planId` or `plan.tasks` |
| `artifactIds` | `artifactIds` |
| `latestCompletionAudit` | `latestCompletionAudit` |
| `approvals` | `GET /approvals?planId` |
| `budget` | `GET /plans/:planId/budget-report` |
| `eventsCursor` | last event id from SSE or JSON replay |
| `actionAvailability` | Derived locally, then confirmed by server on mutation. |

Use `GET /plans/:planId` as the highest-fidelity run reconstruction. Use the
narrow list routes when refreshing panels independently.

### PhaseSummary

Backed by `GET /phases?planId` and optionally enriched by `GET /phases/:id`.

| Field | Source |
|---|---|
| `id`, `planId`, `index`, `title`, `summary`, `status` | Phase list |
| `integrationBranch` | Phase list |
| `startedAt`, `completedAt` | Phase list |
| `phaseAuditReportId` | Phase list |
| `taskCountsByStatus` | Derived from task list |
| `latestMergeRun` | Phase detail, loaded on expansion |
| `latestPhaseAudit` | Phase detail, loaded on expansion |

### TaskSummary

Backed by `GET /tasks?planId` or `GET /tasks?phaseId`.

| Field | Source |
|---|---|
| `id`, `planId`, `phaseId`, `slug`, `title`, `status`, `riskLevel`, `kind` | Task list |
| `approvalStatus` | Join with `ApprovalQueueItem` by `taskId` |
| `reviewState` | Derived from task detail when loaded; otherwise status-based |
| `budgetSpend` | Join with `BudgetSnapshot.perTaskBreakdown` |
| `availableActions` | Derived from phase, task, approvals, and latest completion audit |

### TaskDetail

Backed by `GET /tasks/:taskId`, with optional history reads.

| Field | Source |
|---|---|
| `task` | Full `Task` object |
| `fileScope`, `acceptanceCriteria`, `testCommands`, `budget` | `task` |
| `branchName` | `task.branchName` or `latestLease.branchName` |
| `worktreePath` | `latestLease.worktreePath` preferred; `task.worktreePath` fallback |
| `latestAgentRun` | Inline `latestAgentRun` |
| `agentRuns` | `GET /agent-runs?taskId` when opening diagnostics |
| `latestLease` | Inline `latestLease` |
| `latestReviewReport` | Inline `latestReviewReport` |
| `reviewReports` | `GET /tasks/:taskId/review-reports` when opening history |
| `taskPolicyDecisions` | Inline list |
| `reviewSkippedDecision` | Inline optional field |
| `relatedEvents` | Filtered `EventItem[]` by `taskId` |
| `relatedArtifacts` | Currently inferred from events or plan artifact ids; see gaps. |

### ApprovalQueueItem

Backed by `GET /approvals?planId`.

| Field | Source |
|---|---|
| `id`, `planId`, `taskId`, `subject`, `riskBand`, `status` | Approval row |
| `requestedBy`, `approvedBy`, `requestedAt`, `decidedAt`, `reason` | Approval row |
| `taskTitle`, `taskSlug`, `phaseTitle` | Join from task and phase read models |
| `isBulkEligible` | Derived for display only; server decides actual eligibility. |
| `bulkSkippedReason` | From `POST /plans/:id/approve-all-pending` response. |

### BudgetSnapshot

Backed by `GET /plans/:planId/budget-report`.

| Field | Source |
|---|---|
| `id`, `planId`, `generatedAt` | Budget report |
| `totalUsd`, `totalTokens`, `totalWallClockMinutes` | Budget report |
| `perTask` | `perTaskBreakdown[]`, joined with task titles |
| `overBudgetTasks` | Derived by comparing spend to task budgets when task details are available. |

Note: the current endpoint computes and persists a fresh snapshot on every read.
Desktop should avoid aggressive polling of budget data.

### EventItem

Backed by SSE and `GET /events`.

| Field | Source |
|---|---|
| `id`, `planId`, `kind`, `createdAt` | Workflow event |
| `phaseId`, `taskId` | Present on relevant variants |
| `artifactId`, `artifactKind`, `uri` | `artifact_persisted.payload` |
| `label` | Derived from kind and joined phase/task names |
| `severity` | Derived: failures/blockers can be emphasized after joining current state |
| `raw` | Original event payload for diagnostics |

### ArtifactSummary

Backed by plan `artifactIds`, artifact events, and fetched artifact responses.

| Field | Source |
|---|---|
| `id` | `artifactIds` or event payload |
| `kind` | Event payload when available; otherwise unknown until fetched or listed by future API |
| `planId`, `taskId` | Event payload or future artifact metadata |
| `createdAt` | Event payload `createdAt` or future artifact metadata |
| `contentType` | `GET /artifacts/:id` response header |
| `fetchStatus` | Client state |
| `trustedOpenState` | Main-process path validation result, not renderer-derived; unavailable for current streamed artifacts unless trusted path metadata exists |

### EvidenceBundleView

Backed by `latestCompletionAudit`, release artifact events, and artifact
fetches.

| Field | Source |
|---|---|
| `completionAudit` | `RunDetail.latestCompletionAudit` or `GET /completion-audit-reports/:id` |
| `checklist`, `findings`, `summary` | Completion audit report |
| `releaseArtifacts` | Artifact ids/events where kind is `pr_summary` or `completion_evidence_bundle` |
| `artifactContents` | Inert text/markdown/JSON fetched through `GET /artifacts/:id` |
| `releaseState` | Derived from latest completion audit outcome and release artifact presence |

Do not claim release success from the `POST /release` response alone. Show
release in progress until durable artifact/event state exists.

### ActionAvailability

Action availability should be a structured value attached to the selected run,
phase, task, and approval rows:

| Field | Meaning |
|---|---|
| `action` | Stable action id such as `task.run`, `phase.integrate`, `plan.release`. |
| `enabled` | Whether the client believes the action is currently worth offering. |
| `reason` | Human-readable disabled reason. |
| `requiresConfirmation` | Always true for mutating API actions. |
| `requiresReason` | True for bulk approve, review override, and audit override. |
| `pending` | Mutation in flight for this subject/action. |
| `lastError` | Last `ApiError` message, especially `409` details. |

## Action Gating

Desktop should mirror the TUI's client gates for obvious invalid actions:

| Action | Client convenience gate |
|---|---|
| Run task | Phase status is `executing`; task is not already merge-ready or merged. |
| Review task | Task status is `in_review`. |
| Fix task | Task status is `fixing`. |
| Integrate phase | Phase status is `executing` or `integrating`; every phase task is `ready_to_merge` or `merged`. |
| Audit phase | Phase status is `auditing`. |
| Approve task | At least one pending approval row matches the task. |
| Approve plan | At least one pending plan-scoped approval row exists. |
| Complete plan | Plan has phases and every phase status is `completed`. |
| Release plan | Latest completion audit exists and `outcome === "pass"`. |

These gates are not authority. They only reduce noisy confirmations. A stale
cache, concurrent worker transition, or deeper server precondition can still
return `409`; Desktop must surface the server message and refresh state.

Do not duplicate deeper policy logic client-side, including:

- latest review outcome rules for `fix`;
- merge-run integrity rules for `audit`;
- budget/scope blocker refusal for `override-review`;
- audit-blocker checks for `override-audit`;
- catastrophic and review-pass filters for bulk approval.

## Artifact Rendering And Security

Artifacts and generated evidence may contain model-produced Markdown, JSON, or
text. Treat content as untrusted relative to the renderer.

| Constraint | Desktop behavior |
|---|---|
| Fetch path | Always fetch via `GET /artifacts/:id`; never dereference artifact `uri` in the renderer. |
| Server containment | The API already realpath-checks files under `PLAN_ARTIFACT_DIR`; preserve and surface `403` failures. |
| Rendering | Render Markdown inertly: no raw HTML execution, no script, no remote image/script loads, sanitized links only. |
| JSON | Parse for structured views when safe; keep raw text fallback. |
| Binary/patch bundles | Offer download/reveal only after main-process validation and trusted metadata; do not inline arbitrary binary. |
| External links | Open only through allowlisted `shell.openExternalSafe` behavior. |
| Local paths | Open/reveal only through Electron main process after checking absolute path, existence, and expected root containment. |
| Worktree paths | Trust only paths returned by API state, then revalidate in main process before opening. |

The renderer should not receive raw filesystem access, raw IPC, `file://`
navigation rights, or shell command strings.

## API Gaps And Nice-To-Have Fields

The current API is enough for the core attach/read/action MVP. These additions
would reduce Desktop round-trips, fragile joins, or optional host integrations:

| Gap | Impact | Nice-to-have API shape |
|---|---|---|
| Run list lacks repo/spec identity | Runs list cannot show repo root, repo URL, spec title, branch, or head SHA without extra endpoints. | Add `repoSnapshot` and `specDocument` summary fields to `GET /plans`, or add `GET /plans/:id/context`. |
| Run list lacks attention counts | Desktop must hydrate cockpit reads to show pending approvals, blocked tasks, failed phases, and release readiness. | Add `attention: { pendingApprovals, blockedTasks, failedTasks, blockedPhases, releaseReady }` to `GET /plans`. |
| Artifact metadata list missing | `GET /plans/:id` returns only `artifactIds`; artifact kind/time may be known only from events. | Add `GET /artifacts?planId=:id` or return `artifacts: Artifact[]` from plan detail. |
| Artifact content has no filename/title header | Viewer labels are weak for evidence bundles and PR summaries. | Include `Content-Disposition` or an artifact metadata endpoint with `kind`, `title`, `createdAt`, `uri basename`. |
| Artifact local path metadata missing | Desktop cannot safely reveal an artifact directory from `GET /artifacts/:id` alone. | Add a contained artifact metadata endpoint or include validated local path metadata in an artifact list. |
| Task list is narrow | Cockpit task rows need branch, worktree, size hint, approval requirement, and possibly latest review state. | Add optional `include=detail` or a task cockpit projection. |
| Phase list lacks progress counts | Desktop derives counts by joining task list. | Add `taskCountsByStatus` to `GET /phases?planId`. |
| Action availability is client-derived | Desktop must mirror simple gates and still handle 409. | Add server-computed `availableActions` to plan/phase/task detail for display only, with mutations still authoritative. |
| SSE event kinds are sparse | Approval, budget, agent-run, and release progress panels may rely on polling. | Emit `approval_status_changed`, `budget_report_generated`, `agent_run_status_changed`, and `release_status_changed`. |
| Cursor lookup can 404 | Clearing stale cursors works, but clients cannot ask for "latest cursor only." | Add `GET /events?planId=:id&limit=0` or a plan `lastEventId` field. |
| Health identity and API README diverge | Some docs still mention legacy health response. | Keep `/health` identity as the Desktop contract and update older diagnostics text when touched. |
| Bulk approve is not in TUI client interface yet | Desktop needs this route for the MVP bulk-approval flow. | Add shared client method returning approved/skipped details. |
| Override endpoints are not in TUI client interface yet | Desktop task/phase drawers need reasoned overrides. | Add shared client methods for `override-review` and `override-audit`. |
| Completion/release progress is indirect | `POST` returns workflow ids, but durable success is inferred from audit/artifact state. | Add read-side release attempt/status projection if release evidence grows beyond artifacts. |

## Implementation Notes

- Share or extract the TUI API client patterns where practical: trailing slash
  stripping, `ApiError`, safe JSON parsing, SSE parsing, reconnect, and simple
  state-machine gates.
- Keep cache keys plan-scoped and resource-specific so SSE invalidation can be
  targeted: plans, plan detail, phases, tasks, approvals, budget, events,
  artifact content, task detail, and agent runs.
- Abort all in-flight requests and SSE streams when the base URL changes or the
  selected run changes.
- Treat every mutation as a server request followed by refresh. Local gates,
  disabled buttons, and optimistic pending states must never become durable
  state claims.
