# Runbook: Failed Completion Audit

A `completion_audit_reports` row with `outcome != 'pass'` blocks the
release path. The plan's status flips to `blocked` (or stays
`auditing` if the workflow itself errored). The TUI's release screen
shows the auditor's findings inline.

## Symptom

- `POST /plans/:id/release` returns 409:
  `completion audit ... has outcome='changes_requested'; /release requires 'pass'`.
- TUI plan-detail's release row shows the audit verdict in dim red.
- `plans.completion_audit_report_id` is set, `plans.status='blocked'`.

## Diagnostic queries

### The full audit report

```sql
SELECT id, outcome, summary, checklist, findings, created_at
FROM completion_audit_reports
WHERE plan_id = '<PLAN_ID>'
ORDER BY created_at DESC
LIMIT 5;
```

### Per-finding breakdown

```sql
SELECT jsonb_array_elements(findings) AS finding
FROM completion_audit_reports
WHERE id = '<COMPLETION_AUDIT_REPORT_ID>';
```

Each finding carries `severity`, `category`, `evidenceCitations`,
`description`. Cross-reference the citations against the merged commit
range:

```bash
git log --oneline <merge_runs.base_sha>..<merge_runs.integration_head_sha> -- <PATH>
```

### Phase audits — were they all clean?

A completion-audit `changes_requested` after every phase audited `pass`
usually means the auditor found a cross-phase regression (something
landed in phase N that broke phase M's acceptance criteria).

```sql
SELECT phase_id, outcome, created_at, summary
FROM phase_audit_reports
WHERE plan_id = '<PLAN_ID>'
ORDER BY created_at;
```

### Auditor's spans (Phase 7)

```sql
SELECT created_at, payload->>'name' AS span,
       payload->>'durationMs' AS ms, payload->>'errorMessage' AS err
FROM workflow_events
WHERE plan_id = '<PLAN_ID>'
  AND kind = 'span_emitted'
  AND payload->>'name' LIKE '%completion-audit%'
ORDER BY created_at DESC;
```

If `errorMessage` is populated on a `runCompletionAuditor` span, the
model returned an unparseable response — `ApplicationFailure.nonRetryable`
should have surfaced via Temporal but the span captures the original
message verbatim.

### Stop-condition trip

Phase 7's `evaluateStopConditionActivity` fires inside
`CompletionAuditWorkflow` before the auditor runs. A nonRetryable
`StopConditionMet` failure indicates a structural limit was tripped
(high-severity findings, exhausted phase reruns):

```sql
SELECT created_at, payload->>'name' AS span, payload->>'errorMessage' AS err
FROM workflow_events
WHERE plan_id = '<PLAN_ID>'
  AND kind = 'span_emitted'
  AND payload->>'name' = 'worker.activities.policy.evaluateStopConditionActivity'
ORDER BY created_at DESC LIMIT 5;
```

## Interpreting the verdict

| `outcome` | What it means | Operator action |
|---|---|---|
| `pass` | Release is gated open. | Run `POST /plans/:id/release`. |
| `changes_requested` | Auditor found acceptance-criterion gaps. | Inspect findings → spec amendment + new task → re-drive plan. |
| `blocked` | Auditor refuses to render a verdict (evidence inconsistent, citations missing). | Same as `changes_requested` plus inspect the auditor's `summary` for the structural reason. |

Read the auditor's `summary` first — it's the one-paragraph human
narrative. Then walk `findings` for the per-citation evidence.

## Recovery actions

### Fix the gap, re-audit

1. Open a spec amendment that closes the gap. If the gap is a missing
   feature, write a new task. If the gap is a missing test for shipped
   code, write a fix-only task scoped to the affected file.
2. Drive the new task through the standard run → review → integrate →
   audit flow.
3. Re-issue `POST /plans/:id/complete`. The completion-audit workflow
   re-runs against the new state and (hopefully) returns `pass`.

The `plans.completion_audit_report_id` is stamped to the latest run on
each completion, so the operator only ever sees the most recent verdict.

### When to retry vs escalate

**Retry** when:

- The findings cite a single, narrow gap (one acceptance criterion, one
  file).
- The fix is < 30 min of implementer wall time.
- The auditor's reasoning is plainly correct.

**Escalate** when:

- Findings span multiple phases — the cross-phase regression suggests
  the partition was wrong; needs a re-plan, not a patch.
- Findings cite the auditor's own evidence as inconsistent (citation
  refers to a sha that doesn't exist) — the auditor is broken, page the
  workflow owner.
- Three consecutive completion-audit re-runs return non-pass with
  unrelated findings — the spec is too ambiguous; needs human review of
  the spec itself.

### Replay an audit verbatim

The completion-audit workflow is replay-safe: re-issuing
`POST /plans/:id/complete` with no DB mutation produces the same
verdict (modulo model nondeterminism). Useful for confirming an
intermittent verdict isn't sensor-jitter.

```bash
curl -X POST http://localhost:3001/plans/<PLAN_ID>/complete \
  -H 'content-type: application/json' \
  -d '{"requestedBy":"replay@example.com"}'
```

The new audit lands as a fresh `completion_audit_reports` row;
`plans.completion_audit_report_id` re-stamps to the new id.

## Escalation criteria

Page the plan owner when:

- The same finding appears in three consecutive completion audits
  despite operator-led fixes between runs.
- A `blocked` verdict is returned with a `summary` claiming the audit
  evidence itself is inconsistent.
- The completion auditor span's `durationMs` consistently exceeds
  10 minutes (model is timing out → check model availability + token
  budget).

Page the workflow owner when:

- `CompletionAuditWorkflow` fails non-retryably with `StopConditionMet`
  on a plan whose phases all show `pass` audits — `evaluateStopCondition`
  is tripping on stale state; investigate `policy_decisions` +
  `review_reports` for the plan.
- `plans.status` stays `auditing` for >30 min after `POST /complete`
  (workflow stalled — inspect Temporal UI for the workflow run).
