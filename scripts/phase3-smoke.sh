#!/usr/bin/env bash
# Phase 3 end-to-end smoke test.
#
# Verifies the phase-3 vertical slice: POST /spec-documents ->
# POST /plans (SpecToPlanWorkflow) -> pick a task id out of the
# persisted plan -> POST /tasks/:id/run (TaskExecutionWorkflow) ->
# implementer (stub or live) runs inside a leased worktree -> diff-scope
# audit -> task status lands in ready_for_review or blocked. Finishes
# with Postgres + on-disk assertions.
#
# Preconditions:
#   pnpm docker:up            # starts postgres + temporal + temporal-ui
#   pnpm db:migrate           # applies db/migrations/*.sql
#   cp .env.example .env      # (then export DATABASE_URL etc.)
#
# Usage: pnpm smoke:phase3

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${TEMPORAL_ADDRESS:=localhost:7233}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=pm-go-worker}"
: "${API_PORT:=3001}"
: "${PLANNER_EXECUTOR_MODE:=stub}"
: "${IMPLEMENTER_EXECUTOR_MODE:=stub}"
: "${PLAN_ARTIFACT_DIR:=$REPO_ROOT/artifacts/plans}"
: "${WORKTREE_ROOT:=$REPO_ROOT/.worktrees}"
: "${REPO_ROOT_FOR_WORKTREES:=$REPO_ROOT}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE \
  API_PORT PLANNER_EXECUTOR_MODE IMPLEMENTER_EXECUTOR_MODE \
  PLAN_ARTIFACT_DIR WORKTREE_ROOT REPO_ROOT

# The worker and API read REPO_ROOT to decide where leases should live.
export REPO_ROOT="$REPO_ROOT_FOR_WORKTREES"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke] jq is required but was not found on PATH" >&2
  exit 1
fi

WORKER_LOG="$(mktemp)"
API_LOG="$(mktemp)"

cleanup() {
  local exit_code=$?
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${API_PID:-}" ]]    && kill "$API_PID"    2>/dev/null || true
  if (( exit_code != 0 )); then
    echo "--- worker log tail ---" >&2
    tail -n 60 "$WORKER_LOG" >&2 || true
    echo "--- api log tail ---" >&2
    tail -n 60 "$API_LOG" >&2 || true
  fi
  rm -f "$WORKER_LOG" "$API_LOG"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "[smoke] building (planner=$PLANNER_EXECUTOR_MODE implementer=$IMPLEMENTER_EXECUTOR_MODE)"
pnpm build >/dev/null

echo "[smoke] starting worker (logs: $WORKER_LOG)"
pnpm start:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[smoke] starting api (logs: $API_LOG)"
pnpm start:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[smoke] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[smoke] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[smoke] api did not start within 30s" >&2
    exit 1
  fi
done

# 1. POST /spec-documents with the golden-path spec.
SPEC_BODY_JSON="$(jq -Rs '.' < examples/golden-path/spec.md)"
SPEC_PAYLOAD="$(
  jq -n \
    --arg title "Phase 3 smoke" \
    --argjson body "$SPEC_BODY_JSON" \
    --arg repoRoot "$REPO_ROOT_FOR_WORKTREES" \
    --arg source "manual" \
    '{title: $title, body: $body, repoRoot: $repoRoot, source: $source}'
)"

echo "[smoke] POST /spec-documents"
SPEC_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/spec-documents" \
  -H 'content-type: application/json' \
  --data "$SPEC_PAYLOAD")"
SPEC_DOC_ID="$(echo "$SPEC_RESPONSE" | jq -r '.specDocumentId')"
SNAPSHOT_ID="$(echo "$SPEC_RESPONSE" | jq -r '.repoSnapshotId')"
echo "[smoke] spec=$SPEC_DOC_ID snapshot=$SNAPSHOT_ID"

# 2. POST /plans.
echo "[smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/plans" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" \
    --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[smoke] plan=$PLAN_ID"

# 3. Poll GET /plans/:id until persistence is reachable.
echo "[smoke] polling GET /plans/$PLAN_ID"
for i in {1..60}; do
  if curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID" >/dev/null 2>&1; then
    echo "[smoke] plan reachable after ${i}s"
    break
  fi
  sleep 1
  if (( i == 60 )); then
    echo "[smoke] plan never appeared after 60s" >&2
    exit 1
  fi
done

# 4. Pick phase 0's first task id from the persisted plan.
PLAN_DOC="$(curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID")"
TASK_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[0]')"
if [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]]; then
  echo "[smoke] could not derive task id from plan document" >&2
  exit 1
fi
echo "[smoke] task=$TASK_ID"

# 5. POST /tasks/:id/run.
echo "[smoke] POST /tasks/$TASK_ID/run"
RUN_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/tasks/$TASK_ID/run" \
  -H 'content-type: application/json' \
  --data '{}')"
WORKFLOW_RUN_ID="$(echo "$RUN_RESPONSE" | jq -r '.workflowRunId')"
echo "[smoke] started workflow: $WORKFLOW_RUN_ID"

# 6. Poll GET /tasks/:id until terminal status.
STATUS="?"
for i in {1..90}; do
  STATUS="$(curl -sf "http://localhost:$API_PORT/tasks/$TASK_ID" \
    | jq -r '.task.status // "?"')"
  if [[ "$STATUS" == "in_review" \
     || "$STATUS" == "ready_for_review" \
     || "$STATUS" == "blocked" \
     || "$STATUS" == "failed" ]]; then
    break
  fi
  sleep 1
  if (( i == 90 )); then
    echo "[smoke] task never reached terminal status (last: $STATUS)" >&2
    exit 1
  fi
done
echo "[smoke] task terminal status=$STATUS"

# 7. Verify durable rows.
LEASE_COUNT="$(docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc \
  "SELECT count(*) FROM worktree_leases WHERE task_id='$TASK_ID'" | tr -d '[:space:]')"
AR_COUNT="$(docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc \
  "SELECT count(*) FROM agent_runs WHERE task_id='$TASK_ID' AND role='implementer'" | tr -d '[:space:]')"

[[ "$LEASE_COUNT" == "1" ]] || {
  echo "[smoke] expected 1 lease row, got $LEASE_COUNT" >&2; exit 1
}
[[ "$AR_COUNT" == "1" ]] || {
  echo "[smoke] expected 1 implementer agent_run, got $AR_COUNT" >&2; exit 1
}

# 8. Verify the worktree path exists on disk.
LEASE_PATH="$(docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc \
  "SELECT worktree_path FROM worktree_leases WHERE task_id='$TASK_ID'" | tr -d '[:space:]')"
[[ -d "$LEASE_PATH" ]] || {
  echo "[smoke] worktree path missing: $LEASE_PATH" >&2; exit 1
}

echo "[smoke] PASS status=$STATUS lease=$LEASE_PATH"
exit 0
