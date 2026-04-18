#!/usr/bin/env bash
# Phase 2 end-to-end smoke test.
#
# Verifies the vertical slice: HTTP POST /spec-documents -> repo snapshot
# + spec persisted -> POST /plans -> Temporal SpecToPlanWorkflow ->
# planner activity (stub or live) -> audit -> persist plan + artifact ->
# Markdown on disk -> Postgres verification queries.
#
# Preconditions:
#   pnpm docker:up            # starts postgres + temporal + temporal-ui
#   pnpm db:migrate           # applies db/migrations/*.sql
#   cp .env.example .env      # (then export DATABASE_URL etc.)
#
# Usage: pnpm smoke:phase2
#
# By default runs with PLANNER_EXECUTOR_MODE=stub so no Anthropic API
# key is required. To run against the real Claude planner, export
# ANTHROPIC_API_KEY and PLANNER_EXECUTOR_MODE=live before invoking.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${TEMPORAL_ADDRESS:=localhost:7233}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=pm-go-worker}"
: "${API_PORT:=3001}"
: "${PLANNER_EXECUTOR_MODE:=stub}"
: "${PLAN_ARTIFACT_DIR:=$REPO_ROOT/artifacts/plans}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE \
  API_PORT PLANNER_EXECUTOR_MODE PLAN_ARTIFACT_DIR

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
    tail -n 40 "$WORKER_LOG" >&2 || true
    echo "--- api log tail ---" >&2
    tail -n 40 "$API_LOG" >&2 || true
  fi
  rm -f "$WORKER_LOG" "$API_LOG"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "[smoke] building workspace (planner mode=$PLANNER_EXECUTOR_MODE)"
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

# 1. POST /spec-documents with golden-path body + current repo as repoRoot.
SPEC_BODY_JSON="$(jq -Rs '.' < examples/golden-path/spec.md)"
SPEC_PAYLOAD="$(
  jq -n \
    --arg title "Add /plans/:planId/phases/:phaseId GET endpoint" \
    --argjson body "$SPEC_BODY_JSON" \
    --arg repoRoot "$REPO_ROOT" \
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

# 2. POST /plans to start the workflow.
echo "[smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/plans" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" \
    --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
WORKFLOW_RUN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.workflowRunId')"
echo "[smoke] plan=$PLAN_ID workflowRun=$WORKFLOW_RUN_ID"

# 3. Poll GET /plans/:planId until the workflow has persisted.
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

# 4. Verify durable rows.
psql_count() {
  docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc "$1" \
    | tr -d '[:space:]'
}

COUNT_PLANS=$(psql_count "select count(*) from plans where id='$PLAN_ID'")
COUNT_PHASES=$(psql_count "select count(*) from phases where plan_id='$PLAN_ID'")
COUNT_TASKS=$(psql_count "select count(*) from plan_tasks where plan_id='$PLAN_ID'")
COUNT_AR=$(psql_count "select count(*) from agent_runs where role='planner'")
COUNT_ART=$(psql_count "select count(*) from artifacts where plan_id='$PLAN_ID' and kind='plan_markdown'")

[[ "$COUNT_PLANS" == "1" ]] || {
  echo "[smoke] expected 1 plan row, got $COUNT_PLANS" >&2; exit 1
}
[[ "$COUNT_PHASES" -ge 1 ]] || {
  echo "[smoke] expected >=1 phase, got $COUNT_PHASES" >&2; exit 1
}
[[ "$COUNT_TASKS" -ge 2 ]] || {
  echo "[smoke] expected >=2 tasks, got $COUNT_TASKS" >&2; exit 1
}
[[ "$COUNT_AR" -ge 1 ]] || {
  echo "[smoke] expected >=1 planner agent_run, got $COUNT_AR" >&2; exit 1
}
[[ "$COUNT_ART" == "1" ]] || {
  echo "[smoke] expected 1 plan_markdown artifact, got $COUNT_ART" >&2; exit 1
}

# 5. Verify the markdown artifact on disk.
MD_FILE="$PLAN_ARTIFACT_DIR/$PLAN_ID.md"
[[ -s "$MD_FILE" ]] || {
  echo "[smoke] markdown missing or empty: $MD_FILE" >&2; exit 1
}
grep -q "Plan ID" "$MD_FILE" || {
  echo "[smoke] markdown missing 'Plan ID' header in $MD_FILE" >&2; exit 1
}

echo "[smoke] PASS: plan=$PLAN_ID phases=$COUNT_PHASES tasks=$COUNT_TASKS artifact=$MD_FILE"
exit 0
