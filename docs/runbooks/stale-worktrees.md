# Runbook: Stale Worktrees

A worktree lease that is past its `expires_at` blocks the owning task
from progressing. Phase 5's `revokeExpiredLease` activity sweeps these
on a schedule, but operator intervention is sometimes needed when the
on-disk worktree carries dirty state the sweeper refuses to delete.

## Symptom

- TUI plan-detail shows a task stuck in `running` for hours past its
  budget's `maxWallClockMinutes`.
- `worktree_leases.status='expired'` rows are accumulating.
- A new `POST /tasks/:id/run` returns 202 but the workflow re-enters
  the lease path and reuses the expired row instead of creating a new
  one.

## Diagnostic queries

### Find every stale lease past its TTL

```sql
SELECT
  l.id,
  l.task_id,
  l.kind,
  l.status,
  l.worktree_path,
  l.branch_name,
  l.expires_at,
  now() - l.expires_at AS overdue,
  pt.slug AS task_slug,
  pt.status AS task_status
FROM worktree_leases l
LEFT JOIN plan_tasks pt ON pt.id = l.task_id
WHERE l.status IN ('active', 'expired')
  AND l.expires_at < now()
ORDER BY l.expires_at;
```

`overdue > '24 hours'::interval` is the soft escalation threshold —
the default `OperatingLimits.maxWorktreeLifetimeHours` is 24 h so
anything past that is structural (the sweeper is wedged or the worktree
is dirty).

### Inspect the on-disk state

```sh
cd <WORKTREE_PATH>
git status --porcelain
git log -1 --format='%h %s' HEAD
```

Compare `git rev-parse HEAD` against `lease.base_sha`. If they match,
nothing was committed; the lease can be safely torn down.

### Span trail (Phase 7)

```sql
SELECT created_at, payload->>'name' AS span,
       payload->>'status' AS status, payload->>'attrs' AS attrs
FROM workflow_events
WHERE plan_id = '<PLAN_ID>'
  AND kind = 'span_emitted'
  AND payload->>'name' LIKE '%worktree%'
ORDER BY created_at DESC
LIMIT 50;
```

A repeating `worker.activities.worktree.leaseWorktree` span with
`status='error'` usually means git refuses the operation (worktree
already exists at the path, branch already checked out elsewhere, etc.).

## Recovery actions

### Clean release (worktree clean, lease expired)

```bash
# Use the API; the activity wraps the worktree-manager release primitive.
curl -X POST http://localhost:3001/tasks/<TASK_ID>/release-lease  # if exposed
# Or run the worker activity directly via Temporal UI: invoke
# `releaseLease` with input { leaseId: '<LEASE_ID>' }.
```

The DB row flips to `released`; the on-disk worktree directory + the
git worktree registration are torn down.

### Dirty worktree — preserve state

If `git status --porcelain` shows changes the implementer left behind
that you want to keep:

1. `cd <WORKTREE_PATH>`
2. Inspect the diff: `git diff` and `git diff --staged`.
3. **Save the work as a commit on the lease branch**:
   ```sh
   git add -A && git commit -m "snapshot: rescued from stale worktree"
   git push origin <BRANCH_NAME>  # if you want a remote backup
   ```
4. Mark the lease `revoked`:
   ```sql
   UPDATE worktree_leases SET status='revoked' WHERE id='<LEASE_ID>';
   ```
5. **Manually delete the on-disk worktree**:
   ```sh
   git -C <REPO_ROOT> worktree remove --force <WORKTREE_PATH>
   ```

### When it's safe to nuke

A worktree is safe to delete (`git worktree remove --force`) when:

- `git status --porcelain` is empty (no uncommitted changes), OR
- The diff against `lease.base_sha` has been mirrored to a side
  branch / pushed remote, OR
- The owning task is already `blocked` or `failed` AND the operator has
  decided to abandon the work (spec amendment incoming).

Never nuke a worktree whose owning task is `in_review`, `fixing`, or
`ready_to_merge` — the reviewer / merge path is still consuming the
disk state.

### Bulk cleanup (off hours)

For a multi-day backlog of expired leases:

```sql
-- Dry run: list candidates first.
SELECT id, task_id, worktree_path, expires_at
FROM worktree_leases
WHERE status='expired' AND expires_at < now() - interval '7 days';
```

Then iterate the list with `worktree-manager`'s `revokeExpiredLease`
helper invoked directly via a one-off script (see
`packages/worktree-manager/src/`). Confirm each path is clean before
deleting; the helper's safety check should refuse a dirty worktree but
double-check the disk before committing.

## Escalation criteria

Page on-call when:

- A lease is `expired` for >7 days and the worktree path no longer
  exists on disk (DB row out of sync — needs manual `UPDATE` to
  `revoked` plus an audit trail for why).
- Two leases for the same task exist with overlapping
  `[created_at, expires_at]` windows (lease-uniqueness invariant
  violated — investigate the worker's lease creation path).
- The sweeper hasn't ticked in >24 h (`worktree_leases` shows no
  `revoked` transitions even though `expired` rows exist).
