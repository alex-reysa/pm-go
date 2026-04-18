# Database Notes

Postgres is the system of record for durable control-plane state.

Minimum persisted entities:

- `spec_documents`
- `repo_snapshots`
- `plans`
- `plan_tasks`
- `task_dependencies`
- `agent_runs`
- `worktree_leases`
- `review_reports`
- `completion_audit_reports`
- `merge_runs`
- `policy_decisions`
- `artifacts`

Database rules:

- treat workflow state as durable business state, not transient logs
- avoid storing only rendered markdown where structured data exists
- destructive migrations require explicit human approval and should be classified as high risk
- V1 should keep migrations simple and linear
