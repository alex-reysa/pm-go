# Runbook: Blocked Tasks

A task in `plan_tasks.status='blocked'` has been short-circuited by one of
the Phase 7 policy gates or by the Phase 5 file-scope diff guard. Operators
see the dim red badge in the TUI plan-detail screen.

## Common causes

| Cause | Signal in `policy_decisions` | Signal in adjacent tables |
|---|---|---|
| Pre-flight budget gate tripped | `decision='budget_exceeded'`, `subject_type='task'` | `agent_runs.cost_usd` cumulative > `plan_tasks.budget.maxModelCostUsd` |
| Review-cycle exhausted | `decision='requires_human'` (cycles>cap) | `review_reports` count for task >= `task.maxReviewFixCycles + 1` |
| File-scope violation | _no policy_decisions row_ | `TaskExecutionWorkflow` log: "fileScope violations" |
| Merge conflict retry exhausted | _no policy_decisions row for the task_; check `merge_runs.failed_task_id` | `merge_runs` row with `failed_task_id` set to this task |
| Worktree lease lost | _no policy_decisions row_ | `worktree_leases` row stuck in `expired` / `revoked` |

## Diagnostic queries

Run these against `pm-go-postgres-1` (`docker exec -it pm-go-postgres-1 psql -U pmgo -d pm_go`).

### What blocked the task?

```sql
-- Most recent policy_decisions row for this task subject.
SELECT decision, reason, created_at
FROM policy_decisions
WHERE subject_id = '<TASK_ID>' AND subject_type = 'task'
ORDER BY created_at DESC LIMIT 5;
```

### How much budget had the task already burned?

```sql
SELECT
  count(*) AS runs,
  sum(cost_usd) AS total_usd,
  sum(coalesce(input_tokens, 0)
    + coalesce(cache_creation_tokens, 0)
    + coalesce(cache_read_tokens, 0)) AS total_prompt_tokens
FROM agent_runs
WHERE task_id = '<TASK_ID>';
```

Compare against the task's budget:

```sql
SELECT id, slug, budget FROM plan_tasks WHERE id = '<TASK_ID>';
```

### Review-cycle history

```sql
SELECT cycle_number, outcome, created_at
FROM review_reports
WHERE task_id = '<TASK_ID>'
ORDER BY cycle_number;
```

### Merge attempts

```sql
SELECT id, phase_id, mergedTaskIds, failed_task_id, started_at, completed_at
FROM merge_runs
WHERE failed_task_id = '<TASK_ID>'
ORDER BY started_at DESC;
```

### Lease state

```sql
SELECT id, status, expires_at, created_at
FROM worktree_leases
WHERE task_id = '<TASK_ID>'
ORDER BY created_at DESC;
```

### Activity-level spans (Phase 7 observability)

Pull every span emitted across the workflow_events read model for this
task's plan in trace order:

```sql
SELECT created_at, payload->>'name' AS span_name,
       payload->>'durationMs' AS ms, payload->>'status' AS status
FROM workflow_events
WHERE plan_id = '<PLAN_ID>' AND kind = 'span_emitted'
ORDER BY trace_id, created_at;
```

## Recovery actions

### Budget exceeded

1. **Confirm the overrun is real** — re-run the diagnostic query above.
2. **If the cap is too tight for the task's scope**, raise it:
   ```sql
   UPDATE plan_tasks
   SET budget = jsonb_set(budget, '{maxModelCostUsd}', '0.50'::jsonb)
   WHERE id = '<TASK_ID>';
   ```
3. **Re-drive the workflow** by POSTing `/tasks/:id/run`. The pre-flight
   gate will pass on the new cap. The earlier `agent_runs` rows still
   count — if you want a clean slate, archive them to a side table
   first.
4. **Otherwise treat the block as a real signal** — escalate to the spec
   author. Don't quietly raise budgets for chronic over-spenders.

### Review cycle exhausted

1. Inspect the latest `review_reports.findings` to understand what the
   reviewer keeps flagging.
2. If the findings are wrong (false positives), human-edit the plan to
   either widen `task.fileScope` or relax `task.acceptanceCriteria`.
3. To grant another cycle, raise `plan_tasks.maxReviewFixCycles` and
   re-issue `POST /tasks/:id/fix`.
4. If the reviewer is right and the implementer can't satisfy the
   constraint, mark the task `blocked` permanently and split it via a
   spec amendment.

### Manual approval (when the task ships behind a `requiresHumanApproval` gate)

1. Open the TUI, navigate to `Approvals` (`g A` from plan-detail).
2. Inspect the row's `risk_band` and the linked task.
3. Approve via `g A` again on the highlighted row, or POST directly:
   ```bash
   curl -X POST http://localhost:3001/tasks/<TASK_ID>/approve \
     -H 'content-type: application/json' \
     -d '{"approvedBy":"you@example.com"}'
   ```
4. The blocking workflow's `isApproved` poll picks the change up on its
   next 5 s tick.

### Restart the task

1. Verify the worktree lease is healthy (`worktree_leases.status='active'`).
   If not, see `stale-worktrees.md`.
2. POST `/tasks/:id/run` again. The workflow is idempotent — a re-entered
   `running` task replays the diff-scope check against the existing
   worktree.

## Escalation criteria

Page the spec owner when:

- Two consecutive budget gate trips with `over.usd > 5×maxModelCostUsd`.
- Three unique tasks block on the same `policy_decisions.reason`.
- A merge conflict retry exhausts and the conflicted paths overlap a
  shipped acceptance criterion.
- A worktree lease has been `expired` for >24 h with the operator
  unable to resolve it cleanly.

Page the on-call workflow owner when:

- Workflow_events stops gaining new rows for >5 min while the worker
  process is alive (likely a Temporal worker stall — restart it).
- A `policy_decisions` row exists with `decision='budget_exceeded'`
  but the task is still `running` (gate fired but state machine didn't
  observe — inspect worker log + Temporal UI).
