#!/usr/bin/env bash
# Phase 4 end-to-end smoke test.
#
# Extends the Phase 3 vertical slice with the reviewer + fix loop:
#   spec -> plan -> task run -> in_review ->
#   POST /tasks/:id/review  (reviewer stub emits changes_requested) -> fixing ->
#   POST /tasks/:id/fix     (implementer re-runs with fix-mode preamble) -> in_review ->
#   POST /tasks/:id/review  (reviewer stub emits pass)                  -> ready_to_merge
#
# Verifies: 2 review_reports rows, 2 policy_decisions rows, 4 agent_runs
# (2 implementer + 2 auditor), latestReviewReport=pass on GET /tasks/:id,
# GET /tasks/:id/review-reports returns 2 entries in chronological order.
#
# Preconditions:
#   pnpm docker:up            # starts postgres + temporal + temporal-ui
#   pnpm db:migrate           # applies db/migrations/*.sql
#   cp .env.example .env      # (then export DATABASE_URL etc.)
#
# Usage: pnpm smoke:phase4

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
: "${REVIEWER_EXECUTOR_MODE:=stub}"
# Two-entry sequence: cycle 1 = changes_requested, cycle 2 = pass.
: "${REVIEWER_SMOKE_SEQUENCE:=changes_requested,pass}"
# Stub implementer needs to write inside the fixture task's fileScope so
# the post-commit diff-scope check does not flip the task to `blocked`
# before the reviewer runs. The golden-path plan's first task is
# `shared-schema-helpers`, whose fileScope.includes is
# `packages/contracts/src/shared/schema.ts`.
: "${IMPLEMENTER_STUB_WRITE_FILE_PATH:=packages/contracts/src/shared/schema.ts}"
: "${IMPLEMENTER_STUB_WRITE_FILE_CONTENTS:=// stub implementer output (phase 4 smoke)}"
: "${PLAN_ARTIFACT_DIR:=$REPO_ROOT/artifacts/plans}"
: "${WORKTREE_ROOT:=$REPO_ROOT/.worktrees}"
: "${REPO_ROOT_FOR_WORKTREES:=$REPO_ROOT}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE \
  API_PORT PLANNER_EXECUTOR_MODE IMPLEMENTER_EXECUTOR_MODE \
  REVIEWER_EXECUTOR_MODE REVIEWER_SMOKE_SEQUENCE \
  IMPLEMENTER_STUB_WRITE_FILE_PATH IMPLEMENTER_STUB_WRITE_FILE_CONTENTS \
  PLAN_ARTIFACT_DIR WORKTREE_ROOT REPO_ROOT

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
    tail -n 80 "$WORKER_LOG" >&2 || true
    echo "--- api log tail ---" >&2
    tail -n 80 "$API_LOG" >&2 || true
  fi
  rm -f "$WORKER_LOG" "$API_LOG"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

pg() {
  docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc "$1" | tr -d '[:space:]'
}

echo "[smoke] building (planner=$PLANNER_EXECUTOR_MODE implementer=$IMPLEMENTER_EXECUTOR_MODE reviewer=$REVIEWER_EXECUTOR_MODE)"
echo "[smoke] reviewer sequence: $REVIEWER_SMOKE_SEQUENCE"
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

# ---------------------------------------------------------------------------
# Phase 3 path: spec -> plan -> task -> in_review
# ---------------------------------------------------------------------------

SPEC_BODY_JSON="$(jq -Rs '.' < examples/golden-path/spec.md)"
SPEC_PAYLOAD="$(
  jq -n \
    --arg title "Phase 4 smoke" \
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

echo "[smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/plans" \
  -H 'content-type: application/json' \
  --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" \
    --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[smoke] plan=$PLAN_ID"

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

PLAN_DOC="$(curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID")"
TASK_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[0]')"
if [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]]; then
  echo "[smoke] could not derive task id from plan document" >&2
  exit 1
fi
echo "[smoke] task=$TASK_ID"

echo "[smoke] POST /tasks/$TASK_ID/run"
curl -sf -X POST "http://localhost:$API_PORT/tasks/$TASK_ID/run" \
  -H 'content-type: application/json' --data '{}' >/dev/null

wait_for_status() {
  local target="$1"
  local max="${2:-90}"
  local last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "http://localhost:$API_PORT/tasks/$TASK_ID" \
      | jq -r '.task.status // "?"')"
    if [[ "$last" == "$target" ]]; then
      echo "[smoke] task reached status=$target after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "[smoke] task did not reach status=$target in ${max}s (last=$last)" >&2
  return 1
}

wait_for_status "in_review" 90

# ---------------------------------------------------------------------------
# Phase 4 path: first review (changes_requested) -> fix -> second review (pass)
# ---------------------------------------------------------------------------

echo "[smoke] POST /tasks/$TASK_ID/review (cycle 1)"
REVIEW1_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/tasks/$TASK_ID/review")"
CYCLE1_RUN="$(echo "$REVIEW1_RESPONSE" | jq -r '.workflowRunId')"
echo "[smoke] review 1 workflow: $CYCLE1_RUN"

# Reviewer stub sequence[0]=changes_requested -> task transitions to 'fixing'.
wait_for_status "fixing" 60

echo "[smoke] POST /tasks/$TASK_ID/fix"
FIX_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/tasks/$TASK_ID/fix")"
FIX_RUN="$(echo "$FIX_RESPONSE" | jq -r '.workflowRunId')"
echo "[smoke] fix workflow: $FIX_RUN"

# Fix succeeds -> task transitions back to 'in_review'.
wait_for_status "in_review" 90

echo "[smoke] POST /tasks/$TASK_ID/review (cycle 2)"
REVIEW2_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/tasks/$TASK_ID/review")"
CYCLE2_RUN="$(echo "$REVIEW2_RESPONSE" | jq -r '.workflowRunId')"
echo "[smoke] review 2 workflow: $CYCLE2_RUN"

# Reviewer stub sequence[1]=pass -> task transitions to 'ready_to_merge'.
wait_for_status "ready_to_merge" 60

# ---------------------------------------------------------------------------
# Durable-state assertions
# ---------------------------------------------------------------------------

REVIEW_REPORT_COUNT="$(pg "SELECT count(*) FROM review_reports WHERE task_id='$TASK_ID'")"
[[ "$REVIEW_REPORT_COUNT" == "2" ]] || {
  echo "[smoke] expected 2 review_reports rows, got $REVIEW_REPORT_COUNT" >&2; exit 1
}

CYCLE1_OUTCOME="$(pg "SELECT outcome FROM review_reports WHERE task_id='$TASK_ID' AND cycle_number=1")"
CYCLE2_OUTCOME="$(pg "SELECT outcome FROM review_reports WHERE task_id='$TASK_ID' AND cycle_number=2")"
[[ "$CYCLE1_OUTCOME" == "changes_requested" ]] || {
  echo "[smoke] cycle 1 outcome expected changes_requested, got '$CYCLE1_OUTCOME'" >&2; exit 1
}
[[ "$CYCLE2_OUTCOME" == "pass" ]] || {
  echo "[smoke] cycle 2 outcome expected pass, got '$CYCLE2_OUTCOME'" >&2; exit 1
}

POLICY_COUNT="$(pg "SELECT count(*) FROM policy_decisions WHERE subject_type='review' AND subject_id IN (SELECT id FROM review_reports WHERE task_id='$TASK_ID')")"
[[ "$POLICY_COUNT" == "2" ]] || {
  echo "[smoke] expected 2 policy_decisions rows, got $POLICY_COUNT" >&2; exit 1
}

IMPL_RUN_COUNT="$(pg "SELECT count(*) FROM agent_runs WHERE task_id='$TASK_ID' AND role='implementer'")"
AUDIT_RUN_COUNT="$(pg "SELECT count(*) FROM agent_runs WHERE task_id='$TASK_ID' AND role='auditor'")"
[[ "$IMPL_RUN_COUNT" == "2" ]] || {
  echo "[smoke] expected 2 implementer agent_runs, got $IMPL_RUN_COUNT" >&2; exit 1
}
[[ "$AUDIT_RUN_COUNT" == "2" ]] || {
  echo "[smoke] expected 2 auditor agent_runs, got $AUDIT_RUN_COUNT" >&2; exit 1
}

# GET /tasks/:id should now return latestReviewReport with outcome=pass.
TASK_DOC="$(curl -sf "http://localhost:$API_PORT/tasks/$TASK_ID")"
LATEST_OUTCOME="$(echo "$TASK_DOC" | jq -r '.latestReviewReport.outcome // "null"')"
[[ "$LATEST_OUTCOME" == "pass" ]] || {
  echo "[smoke] GET /tasks/:id latestReviewReport.outcome expected pass, got '$LATEST_OUTCOME'" >&2; exit 1
}

# GET /tasks/:id/review-reports returns both reports in chronological order.
REPORTS_DOC="$(curl -sf "http://localhost:$API_PORT/tasks/$TASK_ID/review-reports")"
REPORT_COUNT="$(echo "$REPORTS_DOC" | jq -r '.reports | length')"
[[ "$REPORT_COUNT" == "2" ]] || {
  echo "[smoke] GET /review-reports expected 2, got $REPORT_COUNT" >&2; exit 1
}

echo "[smoke] PASS status=ready_to_merge reports=2 policy_decisions=2 agent_runs(implementer=2 auditor=2)"
exit 0
