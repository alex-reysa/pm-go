# pm-go Raw API Surface

Use this reference only when the CLI or typed operator tools are not the right surface: API tests, manual recovery, or debugging route behavior. Prefer `pm-go drive`, `pm-go why`, `pm-go status`, and the agentic operator for normal runs.

## Submit And Plan

```bash
SPEC_RESPONSE=$(
  curl -sS -X POST http://localhost:3001/spec-documents \
    -H 'Content-Type: application/json' \
    -d '{"title":"Feature","body":"...markdown spec...","repoRoot":"/path/to/repo","source":"manual"}'
)

SPEC_ID=$(echo "$SPEC_RESPONSE" | jq -r .specDocumentId)
SNAPSHOT_ID=$(echo "$SPEC_RESPONSE" | jq -r .repoSnapshotId)

curl -sS -X POST http://localhost:3001/plans \
  -H 'Content-Type: application/json' \
  -d "{\"specDocumentId\":\"$SPEC_ID\",\"repoSnapshotId\":\"$SNAPSHOT_ID\"}"
```

## Inspect

```bash
curl -sS http://localhost:3001/plans
curl -sS http://localhost:3001/plans/<plan-id>
curl -sS http://localhost:3001/tasks/<task-id>
curl -sS 'http://localhost:3001/events?planId=<plan-id>'
curl -sS 'http://localhost:3001/approvals?planId=<plan-id>'
```

## Manual Transitions

`pm-go drive` issues these in the right order. Use them directly only for targeted recovery or route tests.

```bash
curl -sS -X POST http://localhost:3001/tasks/<task-id>/run
curl -sS -X POST http://localhost:3001/tasks/<task-id>/review
curl -sS -X POST http://localhost:3001/tasks/<task-id>/fix
curl -sS -X POST http://localhost:3001/phases/<phase-id>/integrate
curl -sS -X POST http://localhost:3001/phases/<phase-id>/audit
curl -sS -X POST http://localhost:3001/plans/<plan-id>/complete
curl -sS -X POST http://localhost:3001/plans/<plan-id>/release
```

## Approvals

```bash
curl -sS -X POST http://localhost:3001/tasks/<task-id>/approve \
  -H 'Content-Type: application/json' \
  -d '{"approvedBy":"operator"}'

curl -sS -X POST http://localhost:3001/plans/<plan-id>/approve-all-pending \
  -H 'Content-Type: application/json' \
  -d '{"approvedBy":"operator","reason":"manual recovery"}'
```

## Layer-A

The public CLI is the preferred Layer-A surface:

```bash
pm-go decompose --repo . --spec ./feature.md --edit
```

Raw Layer-A endpoints exist for tests and recovery:

```bash
curl -sS -X POST http://localhost:3001/spec-documents/<spec-id>/decompose \
  -H 'Content-Type: application/json' \
  -d '{"repoSnapshotId":"<snapshot-id>"}'

curl -sS http://localhost:3001/spec-documents/<spec-id>/decompositions/<decomposition-id>

curl -sS -X PUT http://localhost:3001/spec-documents/<spec-id>/decompositions/<decomposition-id>/manifest \
  -H 'Content-Type: application/json' \
  -d '{"manifest":{...}}'

curl -sS -X POST http://localhost:3001/spec-documents/<spec-id>/decompositions/<decomposition-id>/plan-first
```
