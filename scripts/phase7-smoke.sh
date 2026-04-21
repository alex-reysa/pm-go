#!/usr/bin/env bash
# Phase 7 end-to-end smoke test.
#
# Drives the same 2-phase fixture as phase5/phase6-smoke far enough to
# exercise the Phase 7 surfaces, then asserts:
#
#   1. Trace correlation: at least one workflow_events row carries both
#      a non-null trace_id AND span_id (proves the broad withSpan wrap
#      is live across the worker activity layer).
#   2. Approval round-trip: create a pending approval_requests row by
#      direct DB insert, POST /tasks/:id/approve, observe row flips to
#      'approved'. (The full workflow integration of the approval gate
#      is exercised by the Phase 7 matrix harness; this smoke validates
#      the API + read-model end of the loop.)
#   3. Budget gate firing: with a task whose maxModelCostUsd=0.01 and
#      a stub agent_run row carrying cost_usd=0.05, the worker's
#      evaluateBudgetGateActivity decision is `ok:false`; assert the
#      blocked decision is observable on a re-driven workflow run by
#      checking for a policy_decisions row with decision='budget_exceeded'
#      after we POST /tasks/:id/run.
#   4. Bonus: GET /plans/:id/budget-report returns a non-empty report.
#   5. Bonus: GET /approvals?planId=<uuid> returns the approved request.
#
# Standalone — does not chain onto phase5/6-smoke. Brings up the local
# stack only if it isn't already running.

set -euo pipefail

DEV_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEV_REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${TEMPORAL_ADDRESS:=localhost:7233}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=pm-go-worker}"
: "${API_PORT:=3001}"
: "${PLANNER_EXECUTOR_MODE:=stub}"
: "${IMPLEMENTER_EXECUTOR_MODE:=stub}"
: "${REVIEWER_EXECUTOR_MODE:=stub}"
: "${PHASE_AUDITOR_EXECUTOR_MODE:=stub}"
: "${COMPLETION_AUDITOR_EXECUTOR_MODE:=stub}"
: "${REVIEWER_SMOKE_SEQUENCE:=pass,pass,pass}"
: "${PHASE_AUDITOR_SMOKE_SEQUENCE:=pass,pass}"
: "${COMPLETION_AUDITOR_SMOKE_SEQUENCE:=pass}"
: "${PLANNER_STUB_FIXTURE_PATH:=$DEV_REPO_ROOT/packages/contracts/src/fixtures/orchestration-review/plan-phase5-smoke.json}"
: "${IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG:=p5-task-a=phase5-smoke/task-a.txt,p5-task-b=phase5-smoke/task-b.txt,p5-task-c=phase5-smoke/task-c.txt}"
: "${IMPLEMENTER_STUB_WRITE_FILE_CONTENTS:=phase7 stub output}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[phase7-smoke] $tool is required but was not found on PATH" >&2
    exit 1
  fi
done

# Bring the local stack up only if it isn't already running. Idempotent.
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  echo "[phase7-smoke] starting docker compose stack"
  docker compose up -d >/dev/null
  sleep 3
fi

# Apply migrations (idempotent — drizzle's migrator stamps a version table).
echo "[phase7-smoke] applying migrations"
DATABASE_URL="$DATABASE_URL" pnpm db:migrate >/dev/null

# ---------------------------------------------------------------------------
# Temp-clone isolation (mirrors phase5/6-smoke).
# ---------------------------------------------------------------------------

SMOKE_BASE="$(mktemp -d -t pm-go-phase7-smoke)"
SMOKE_REPO_ROOT="$SMOKE_BASE/repo"
export PLAN_ARTIFACT_DIR="${PLAN_ARTIFACT_DIR:-$SMOKE_BASE/artifacts}"
export WORKTREE_ROOT="${WORKTREE_ROOT:-$SMOKE_BASE/worktrees}"
export INTEGRATION_WORKTREE_ROOT="${INTEGRATION_WORKTREE_ROOT:-$SMOKE_BASE/integration-worktrees}"
export REPO_ROOT="$SMOKE_REPO_ROOT"
export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE \
  API_PORT PLANNER_EXECUTOR_MODE IMPLEMENTER_EXECUTOR_MODE \
  REVIEWER_EXECUTOR_MODE REVIEWER_SMOKE_SEQUENCE \
  PHASE_AUDITOR_EXECUTOR_MODE PHASE_AUDITOR_SMOKE_SEQUENCE \
  COMPLETION_AUDITOR_EXECUTOR_MODE COMPLETION_AUDITOR_SMOKE_SEQUENCE \
  PLANNER_STUB_FIXTURE_PATH \
  IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG IMPLEMENTER_STUB_WRITE_FILE_CONTENTS

echo "[phase7-smoke] cloning DEV_REPO_ROOT → $SMOKE_REPO_ROOT"
git clone --local --no-hardlinks "$DEV_REPO_ROOT" "$SMOKE_REPO_ROOT" >/dev/null
if ! git -C "$SMOKE_REPO_ROOT" show-ref --verify --quiet refs/heads/main; then
  git -C "$SMOKE_REPO_ROOT" checkout -b main >/dev/null 2>&1 || true
fi

WORKER_LOG="$(mktemp)"
API_LOG="$(mktemp)"

cleanup() {
  local exit_code=$?
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${API_PID:-}" ]]    && kill "$API_PID"    2>/dev/null || true
  if (( exit_code != 0 )); then
    echo "--- worker log tail ---" >&2
    tail -n 120 "$WORKER_LOG" >&2 || true
    echo "--- api log tail ---" >&2
    tail -n 60 "$API_LOG" >&2 || true
    echo "--- smoke env ---" >&2
    echo "SMOKE_BASE=$SMOKE_BASE" >&2
  fi
  rm -f "$WORKER_LOG" "$API_LOG"
  rm -rf "$SMOKE_BASE"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

pg() {
  docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc "$1" \
    | tr -d '[:space:]'
}

# psql exec without trimming whitespace — for multi-row queries.
pg_raw() {
  docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc "$1"
}

echo "[phase7-smoke] building (stub mode)"
pnpm build >/dev/null

echo "[phase7-smoke] starting worker (logs: $WORKER_LOG)"
pnpm start:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[phase7-smoke] starting api (logs: $API_LOG)"
pnpm start:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[phase7-smoke] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[phase7-smoke] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[phase7-smoke] api did not start within 30s" >&2
    exit 1
  fi
done

API="http://localhost:$API_PORT"

wait_for_task_status() {
  local task_id="$1" target="$2" max="${3:-120}" last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "$API/tasks/$task_id" | jq -r '.task.status // "?"')"
    [[ "$last" == "$target" ]] && return 0
    sleep 1
  done
  echo "[phase7-smoke] task $task_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

# ---------------------------------------------------------------------------
# Drive a single task through to in_review so we have:
#   - real workflow_events rows (for trace assertion)
#   - a real plan + tasks (for approval insert + budget aggregation)
# ---------------------------------------------------------------------------

SPEC_BODY_JSON="$(jq -Rs '.' < "$DEV_REPO_ROOT/examples/golden-path/spec.md")"
SPEC_PAYLOAD="$(jq -n \
  --arg title "Phase 7 smoke" \
  --argjson body "$SPEC_BODY_JSON" \
  --arg repoRoot "$SMOKE_REPO_ROOT" \
  --arg source "manual" \
  '{title: $title, body: $body, repoRoot: $repoRoot, source: $source}')"

echo "[phase7-smoke] POST /spec-documents"
SPEC_RESPONSE="$(curl -sf -X POST "$API/spec-documents" \
  -H 'content-type: application/json' --data "$SPEC_PAYLOAD")"
SPEC_DOC_ID="$(echo "$SPEC_RESPONSE" | jq -r '.specDocumentId')"
SNAPSHOT_ID="$(echo "$SPEC_RESPONSE" | jq -r '.repoSnapshotId')"

echo "[phase7-smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "$API/plans" \
  -H 'content-type: application/json' --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[phase7-smoke] plan=$PLAN_ID"

# Wait for plan to be reconstructed (planner workflow runs).
for i in {1..30}; do
  if curl -sf "$API/plans/$PLAN_ID" | jq -e '.plan.phases | length > 0' >/dev/null 2>&1; then
    break
  fi
  sleep 1
  (( i == 30 )) && { echo "[phase7-smoke] plan never appeared after 30s" >&2; exit 1; }
done

PLAN_DOC="$(curl -sf "$API/plans/$PLAN_ID")"
PHASE_0_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].id')"
ONE_TASK_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[0]')"

echo "[phase7-smoke] driving task $ONE_TASK_ID through run+review"
curl -sf -X POST "$API/tasks/$ONE_TASK_ID/run" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_task_status "$ONE_TASK_ID" "in_review" 120

# ---------------------------------------------------------------------------
# Assertion 1: trace correlation — at least one workflow_events row has
# both trace_id AND span_id populated. Proves the broad withSpan wrap
# is live (events.ts proof-of-wire would only emit a single trace per
# emitWorkflowEvent — the broad wrap multiplies that across every
# durable-write activity).
# ---------------------------------------------------------------------------

echo "[phase7-smoke] === assertion 1: trace correlation ==="
TRACE_COUNT="$(pg "SELECT count(*) FROM workflow_events
  WHERE plan_id='$PLAN_ID' AND trace_id IS NOT NULL AND span_id IS NOT NULL")"
if [[ -z "$TRACE_COUNT" ]] || (( TRACE_COUNT < 1 )); then
  echo "[phase7-smoke] expected >=1 workflow_events row with non-null trace_id+span_id, got $TRACE_COUNT" >&2
  exit 1
fi
echo "[phase7-smoke] trace correlation: $TRACE_COUNT spans"

# ---------------------------------------------------------------------------
# Assertion 2: approval round-trip via the API.
# Insert a pending approval_requests row directly (the workflow path
# that creates one is exercised by the Phase 7 matrix harness — here
# we just validate the API + ledger flip).
# ---------------------------------------------------------------------------

echo "[phase7-smoke] === assertion 2: approval round-trip ==="
APPROVAL_ID="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
pg "INSERT INTO approval_requests (id, plan_id, task_id, subject, risk_band, status)
    VALUES ('$APPROVAL_ID', '$PLAN_ID', '$ONE_TASK_ID', 'task', 'high', 'pending')" >/dev/null

# POST /tasks/:id/approve
APPROVE_RESPONSE="$(curl -sf -X POST "$API/tasks/$ONE_TASK_ID/approve" \
  -H 'content-type: application/json' --data '{"approvedBy":"smoke@example.com"}')"
APPROVED_STATUS="$(echo "$APPROVE_RESPONSE" | jq -r '.approval.status')"
if [[ "$APPROVED_STATUS" != "approved" ]]; then
  echo "[phase7-smoke] approval status expected 'approved', got '$APPROVED_STATUS'" >&2
  exit 1
fi
DB_STATUS="$(pg "SELECT status FROM approval_requests WHERE id='$APPROVAL_ID'")"
if [[ "$DB_STATUS" != "approved" ]]; then
  echo "[phase7-smoke] DB approval row not flipped (got '$DB_STATUS')" >&2
  exit 1
fi
echo "[phase7-smoke] approval round-trip: pending → approved"

# ---------------------------------------------------------------------------
# Assertion 3: budget gate firing. We synthesise a budget overrun by
# inserting a stub agent_run row whose cost_usd exceeds the task's
# maxModelCostUsd. Then we POST /tasks/:id/run, which re-enters
# TaskExecutionWorkflow → evaluateBudgetGateActivity. Because the task
# already has prior spend that overflows the budget, the workflow
# transitions to `blocked` and persists a policy_decisions row with
# decision='budget_exceeded'.
# ---------------------------------------------------------------------------

echo "[phase7-smoke] === assertion 3: budget gate firing ==="
# Pick a fresh task from phase 0 (one we haven't run yet) so the
# blocked transition is unambiguous. The Phase 5 fixture has 3 tasks;
# the second one is still 'pending'.
BUDGET_TASK_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[1]')"

# Tighten the task budget to a tiny cap, then attribute a cost above it.
pg "UPDATE plan_tasks SET budget = jsonb_build_object('maxWallClockMinutes', 30, 'maxModelCostUsd', 0.01)
    WHERE id='$BUDGET_TASK_ID'" >/dev/null
RUN_ID="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
pg "INSERT INTO agent_runs
    (id, task_id, workflow_run_id, role, depth, status, risk_level, executor, model,
     prompt_version, permission_mode, cost_usd, started_at, completed_at)
    VALUES
    ('$RUN_ID', '$BUDGET_TASK_ID', 'wf-pre-budget', 'implementer', 1, 'completed', 'low',
     'claude', 'claude-sonnet-4-6', 'implementer@1', 'default',
     0.05, '2026-04-21T00:00:00Z', '2026-04-21T00:01:00Z')" >/dev/null

# Re-drive the task. The workflow's pre-flight budget gate should
# return ok:false → updateTaskStatus(blocked) + persistPolicyDecision.
curl -sf -X POST "$API/tasks/$BUDGET_TASK_ID/run" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_task_status "$BUDGET_TASK_ID" "blocked" 60

# Assert the policy_decisions row landed with the right reason.
DECISION_COUNT="$(pg "SELECT count(*) FROM policy_decisions
  WHERE subject_id='$BUDGET_TASK_ID' AND decision='budget_exceeded'")"
if (( DECISION_COUNT < 1 )); then
  echo "[phase7-smoke] expected policy_decisions row with decision='budget_exceeded', got $DECISION_COUNT" >&2
  exit 1
fi
echo "[phase7-smoke] budget gate fired → blocked + policy_decisions row"

# ---------------------------------------------------------------------------
# Bonus 4: GET /plans/:id/budget-report returns a non-empty report.
# ---------------------------------------------------------------------------

echo "[phase7-smoke] === bonus 4: budget-report endpoint ==="
BUDGET_REPORT="$(curl -sf "$API/plans/$PLAN_ID/budget-report")"
TOTAL_USD="$(echo "$BUDGET_REPORT" | jq -r '.totalUsd')"
PER_TASK_LEN="$(echo "$BUDGET_REPORT" | jq -r '.perTaskBreakdown | length')"
if (( PER_TASK_LEN < 1 )); then
  echo "[phase7-smoke] /budget-report perTaskBreakdown is empty" >&2
  exit 1
fi
echo "[phase7-smoke] budget-report: total=\$$TOTAL_USD across $PER_TASK_LEN task(s)"

# ---------------------------------------------------------------------------
# Bonus 5: GET /approvals?planId=<uuid> returns the approved request.
# ---------------------------------------------------------------------------

echo "[phase7-smoke] === bonus 5: approvals listing ==="
APPROVALS="$(curl -sf "$API/approvals?planId=$PLAN_ID")"
APPROVED_COUNT="$(echo "$APPROVALS" | jq -r '[.approvals[] | select(.status == "approved")] | length')"
if (( APPROVED_COUNT < 1 )); then
  echo "[phase7-smoke] /approvals?planId=$PLAN_ID returned no approved rows" >&2
  exit 1
fi
echo "[phase7-smoke] approvals listing: $APPROVED_COUNT approved row(s)"

echo "phase7-smoke OK"
