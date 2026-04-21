#!/usr/bin/env bash
# Phase 6 end-to-end smoke test.
#
# Drives the same 2-phase fixture as phase5-smoke through to release, then
# verifies the Phase 6 read surface consumed by apps/tui:
#   - GET /plans, /phases?planId, /tasks?{phaseId|planId}, /agent-runs?taskId
#   - GET /events (JSON replay) + sinceEventId cursor
#   - GET /events (SSE live-tail) emits frames for workflow_events rows
#   - GET /artifacts/:id streams the file with a sane content-type
#   - /artifacts rejects a synthetic artifact row whose uri escapes
#     PLAN_ARTIFACT_DIR (file:///etc/hosts) — hyper-prompt §7 invariant
#
# Standalone rather than chained onto phase5-smoke because phase5-smoke
# tears down its SMOKE_BASE on exit; we need the fixture still live when
# the Phase 6 assertions run.

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
: "${IMPLEMENTER_STUB_WRITE_FILE_CONTENTS:=phase5 stub output}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[phase6-smoke] $tool is required but was not found on PATH" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Temp-clone isolation (mirrors phase5-smoke).
# ---------------------------------------------------------------------------

SMOKE_BASE="$(mktemp -d -t pm-go-phase6-smoke)"
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

echo "[phase6-smoke] cloning DEV_REPO_ROOT → $SMOKE_REPO_ROOT"
git clone --local --no-hardlinks "$DEV_REPO_ROOT" "$SMOKE_REPO_ROOT" >/dev/null
if ! git -C "$SMOKE_REPO_ROOT" show-ref --verify --quiet refs/heads/main; then
  git -C "$SMOKE_REPO_ROOT" checkout -b main >/dev/null 2>&1 || true
fi

DEV_HEAD_BEFORE="$(git -C "$DEV_REPO_ROOT" symbolic-ref HEAD 2>/dev/null || echo 'DETACHED')"
DEV_SHA_BEFORE="$(git -C "$DEV_REPO_ROOT" rev-parse HEAD)"

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
    echo "SMOKE_REPO_ROOT=$SMOKE_REPO_ROOT" >&2
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

echo "[phase6-smoke] building (stub mode)"
pnpm build >/dev/null

echo "[phase6-smoke] starting worker (logs: $WORKER_LOG)"
pnpm start:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[phase6-smoke] starting api (logs: $API_LOG)"
pnpm start:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[phase6-smoke] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[phase6-smoke] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[phase6-smoke] api did not start within 30s" >&2
    exit 1
  fi
done

API="http://localhost:$API_PORT"

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------

wait_for_task_status() {
  local task_id="$1" target="$2" max="${3:-120}" last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "$API/tasks/$task_id" | jq -r '.task.status // "?"')"
    [[ "$last" == "$target" ]] && { echo "[phase6-smoke] task $task_id → $target (after ${i}s)"; return 0; }
    sleep 1
  done
  echo "[phase6-smoke] task $task_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

wait_for_phase_status() {
  local phase_id="$1" target="$2" max="${3:-120}" last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "$API/phases/$phase_id" | jq -r '.phase.status // "?"')"
    [[ "$last" == "$target" ]] && { echo "[phase6-smoke] phase $phase_id → $target (after ${i}s)"; return 0; }
    sleep 1
  done
  echo "[phase6-smoke] phase $phase_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

wait_for_plan_status() {
  local plan_id="$1" target="$2" max="${3:-120}" last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "$API/plans/$plan_id" | jq -r '.plan.status // "?"')"
    [[ "$last" == "$target" ]] && { echo "[phase6-smoke] plan $plan_id → $target (after ${i}s)"; return 0; }
    sleep 1
  done
  echo "[phase6-smoke] plan $plan_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

run_task_through_review() {
  local task_id="$1"
  curl -sf -X POST "$API/tasks/$task_id/run" \
    -H 'content-type: application/json' --data '{}' >/dev/null
  wait_for_task_status "$task_id" "in_review" 120
  curl -sf -X POST "$API/tasks/$task_id/review" >/dev/null
  wait_for_task_status "$task_id" "ready_to_merge" 90
}

# ---------------------------------------------------------------------------
# Drive the 2-phase fixture through to release (reuses phase5-smoke flow).
# ---------------------------------------------------------------------------

SPEC_BODY_JSON="$(jq -Rs '.' < "$DEV_REPO_ROOT/examples/golden-path/spec.md")"
SPEC_PAYLOAD="$(jq -n \
  --arg title "Phase 6 smoke" \
  --argjson body "$SPEC_BODY_JSON" \
  --arg repoRoot "$SMOKE_REPO_ROOT" \
  --arg source "manual" \
  '{title: $title, body: $body, repoRoot: $repoRoot, source: $source}')"

echo "[phase6-smoke] POST /spec-documents"
SPEC_RESPONSE="$(curl -sf -X POST "$API/spec-documents" \
  -H 'content-type: application/json' --data "$SPEC_PAYLOAD")"
SPEC_DOC_ID="$(echo "$SPEC_RESPONSE" | jq -r '.specDocumentId')"
SNAPSHOT_ID="$(echo "$SPEC_RESPONSE" | jq -r '.repoSnapshotId')"

echo "[phase6-smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "$API/plans" \
  -H 'content-type: application/json' --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[phase6-smoke] plan=$PLAN_ID"

for i in {1..30}; do
  curl -sf "$API/plans/$PLAN_ID" >/dev/null 2>&1 && break
  sleep 1
  (( i == 30 )) && { echo "[phase6-smoke] plan never appeared after 30s" >&2; exit 1; }
done

PLAN_DOC="$(curl -sf "$API/plans/$PLAN_ID")"
PHASE_0_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].id')"
PHASE_1_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[1].id')"
PHASE_0_TASK_IDS="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[]')"
PHASE_1_TASK_IDS="$(echo "$PLAN_DOC" | jq -r '.plan.phases[1].taskIds[]')"

echo "[phase6-smoke] === phase 0: run each task through review ==="
while IFS= read -r TASK_ID; do
  [[ -z "$TASK_ID" ]] && continue
  run_task_through_review "$TASK_ID"
done <<< "$PHASE_0_TASK_IDS"

curl -sf -X POST "$API/phases/$PHASE_0_ID/integrate" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_0_ID" "auditing" 180
curl -sf -X POST "$API/phases/$PHASE_0_ID/audit" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_0_ID" "completed" 120

echo "[phase6-smoke] === phase 1: run each task through review ==="
while IFS= read -r TASK_ID; do
  [[ -z "$TASK_ID" ]] && continue
  run_task_through_review "$TASK_ID"
done <<< "$PHASE_1_TASK_IDS"

curl -sf -X POST "$API/phases/$PHASE_1_ID/integrate" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_1_ID" "auditing" 180
curl -sf -X POST "$API/phases/$PHASE_1_ID/audit" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_1_ID" "completed" 120

curl -sf -X POST "$API/plans/$PLAN_ID/complete" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_plan_status "$PLAN_ID" "completed" 120

curl -sf -X POST "$API/plans/$PLAN_ID/release" \
  -H 'content-type: application/json' --data '{}' >/dev/null

# Wait for the release workflow to land pr_summary before asserting.
for i in {1..60}; do
  PR_COUNT="$(pg "SELECT count(*) FROM artifacts WHERE plan_id='$PLAN_ID' AND kind='pr_summary'")"
  [[ "$PR_COUNT" == "1" ]] && break
  sleep 1
  (( i == 60 )) && { echo "[phase6-smoke] pr_summary artifact never landed within 60s" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# Phase 6 read-surface assertions.
# ---------------------------------------------------------------------------

echo "[phase6-smoke] === Phase 6 read-surface assertions ==="

ONE_PHASE_TASK_ID="$(echo "$PHASE_0_TASK_IDS" | head -n1)"

# A. GET /plans lists our completed plan.
LIST_MATCH="$(curl -sf "$API/plans" \
  | jq -r --arg id "$PLAN_ID" '.plans[] | select(.id == $id) | .status')"
[[ "$LIST_MATCH" == "completed" ]] || {
  echo "[phase6-smoke] GET /plans did not return plan $PLAN_ID with status=completed (got '$LIST_MATCH')" >&2
  exit 1
}

# B. GET /phases?planId returns both phases.
PHASE_LIST_LEN="$(curl -sf "$API/phases?planId=$PLAN_ID" | jq -r '.phases | length')"
[[ "$PHASE_LIST_LEN" == "2" ]] || {
  echo "[phase6-smoke] GET /phases expected 2 phases, got $PHASE_LIST_LEN" >&2
  exit 1
}

# C. GET /tasks?phaseId returns phase-0's tasks.
PHASE0_TASK_LIST_LEN="$(curl -sf "$API/tasks?phaseId=$PHASE_0_ID" | jq -r '.tasks | length')"
(( PHASE0_TASK_LIST_LEN >= 1 )) || {
  echo "[phase6-smoke] GET /tasks?phaseId expected >=1 task, got $PHASE0_TASK_LIST_LEN" >&2
  exit 1
}

# D. GET /tasks?planId returns the full task set (3 in the phase5 fixture).
PLAN_TASK_LIST_LEN="$(curl -sf "$API/tasks?planId=$PLAN_ID" | jq -r '.tasks | length')"
[[ "$PLAN_TASK_LIST_LEN" == "3" ]] || {
  echo "[phase6-smoke] GET /tasks?planId expected 3 tasks, got $PLAN_TASK_LIST_LEN" >&2
  exit 1
}

# E. /tasks?phaseId and /tasks?planId are mutually exclusive scopes.
BOTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  "$API/tasks?phaseId=$PHASE_0_ID&planId=$PLAN_ID")"
[[ "$BOTH_STATUS" == "400" ]] || {
  echo "[phase6-smoke] GET /tasks with both scopes expected 400, got $BOTH_STATUS" >&2
  exit 1
}

# F. GET /agent-runs?taskId returns at least one run.
AGENT_RUNS_LEN="$(curl -sf "$API/agent-runs?taskId=$ONE_PHASE_TASK_ID" | jq -r '.agentRuns | length')"
(( AGENT_RUNS_LEN >= 1 )) || {
  echo "[phase6-smoke] GET /agent-runs expected >=1 run, got $AGENT_RUNS_LEN" >&2
  exit 1
}

# G. GET /events?planId (JSON replay) includes every Worker 1 emit kind.
EVENTS_JSON="$(curl -sf -H 'accept: application/json' "$API/events?planId=$PLAN_ID")"
TOTAL_EVENTS="$(echo "$EVENTS_JSON" | jq -r '.events | length')"
(( TOTAL_EVENTS >= 3 )) || {
  echo "[phase6-smoke] GET /events expected >=3 events, got $TOTAL_EVENTS" >&2
  exit 1
}
for kind in phase_status_changed task_status_changed artifact_persisted; do
  COUNT="$(echo "$EVENTS_JSON" | jq --arg k "$kind" '[.events[] | select(.kind == $k)] | length')"
  (( COUNT >= 1 )) || {
    echo "[phase6-smoke] no $kind events in replay" >&2
    exit 1
  }
done

# H. sinceEventId cursor returns strictly fewer events.
FIRST_EVENT_ID="$(echo "$EVENTS_JSON" | jq -r '.events[0].id')"
SINCE_LEN="$(curl -sf "$API/events?planId=$PLAN_ID&sinceEventId=$FIRST_EVENT_ID" \
  | jq -r '.events | length')"
(( SINCE_LEN < TOTAL_EVENTS )) || {
  echo "[phase6-smoke] sinceEventId did not narrow the set ($SINCE_LEN >= $TOTAL_EVENTS)" >&2
  exit 1
}

# I. SSE live-tail replays the backlog. --max-time bounds the curl so a
#    missing frame trips the 8s cap instead of hanging the smoke. 8s is
#    well above the replay's expected wall time (ready handshake + ~10
#    frames) yet still short enough that a broken stream fails fast.
SSE_OUTPUT="$(curl -sN --max-time 8 \
  -H 'accept: text/event-stream' \
  "$API/events?planId=$PLAN_ID" 2>/dev/null || true)"
echo "$SSE_OUTPUT" | grep -q '^event: ready' || {
  echo "[phase6-smoke] SSE stream missing 'ready' handshake" >&2
  echo "--- sse output head ---" >&2
  echo "$SSE_OUTPUT" | head -n 20 >&2
  exit 1
}
echo "$SSE_OUTPUT" | grep -q '^event: phase_status_changed' || {
  echo "[phase6-smoke] SSE stream missing phase_status_changed replay" >&2
  exit 1
}

# J. Artifact streaming returns the pr_summary body with a sane
#    content-type (text/markdown).
PR_ID="$(pg "SELECT id FROM artifacts WHERE plan_id='$PLAN_ID' AND kind='pr_summary' ORDER BY created_at DESC LIMIT 1")"
[[ -n "$PR_ID" ]] || {
  echo "[phase6-smoke] pg query returned no pr_summary id (docker exec failed or POSTGRES_CONTAINER=$POSTGRES_CONTAINER mismatch?)" >&2
  exit 1
}
ART_HEADERS="$(curl -sf -D - -o /tmp/phase6-smoke-pr.md "$API/artifacts/$PR_ID")"
ART_STATUS="$(echo "$ART_HEADERS" | awk 'NR==1 {print $2}')"
[[ "$ART_STATUS" == "200" ]] || {
  echo "[phase6-smoke] GET /artifacts/:id expected 200, got '$ART_STATUS'" >&2
  exit 1
}
echo "$ART_HEADERS" | grep -qi '^content-type:.*text/markdown' || {
  echo "[phase6-smoke] /artifacts/:id missing text/markdown content-type" >&2
  echo "--- headers ---" >&2
  echo "$ART_HEADERS" >&2
  exit 1
}
[[ -s /tmp/phase6-smoke-pr.md ]] || {
  echo "[phase6-smoke] pr_summary body was empty" >&2
  exit 1
}
rm -f /tmp/phase6-smoke-pr.md

# K. Traversal guard: a synthetic artifact row pointing at /etc/hosts via
#    file:// must be rejected with 403 (hyper-prompt §7 invariant).
# The pg() helper strips whitespace, which collapses psql's "INSERT 0 1"
# completion tag onto the returned id. Pull just the first row + trim.
SYNTH_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc \
  "INSERT INTO artifacts (id, plan_id, kind, uri, created_at) VALUES (gen_random_uuid(), '$PLAN_ID', 'pr_summary', 'file:///etc/hosts', now()) RETURNING id" \
  | head -n1 | tr -d '[:space:]')"
[[ -n "$SYNTH_ID" ]] || {
  echo "[phase6-smoke] traversal-guard INSERT returned no id (pg/docker exec failed)" >&2
  exit 1
}
TRAVERSAL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$API/artifacts/$SYNTH_ID")"
pg "DELETE FROM artifacts WHERE id='$SYNTH_ID'" >/dev/null
[[ "$TRAVERSAL_STATUS" == "403" ]] || {
  echo "[phase6-smoke] traversal guard expected 403, got $TRAVERSAL_STATUS" >&2
  exit 1
}

# L. Phase 5 read shape stays backward-compatible.
PLAN_DETAIL_KEYS="$(curl -sf "$API/plans/$PLAN_ID" | jq -r 'keys | sort | join(",")')"
[[ "$PLAN_DETAIL_KEYS" == "artifactIds,latestCompletionAudit,plan" ]] || {
  echo "[phase6-smoke] GET /plans/:id keys changed: '$PLAN_DETAIL_KEYS'" >&2
  exit 1
}

# M. Dev repo HEAD unchanged (temp-clone isolation).
DEV_HEAD_AFTER="$(git -C "$DEV_REPO_ROOT" symbolic-ref HEAD 2>/dev/null || echo 'DETACHED')"
DEV_SHA_AFTER="$(git -C "$DEV_REPO_ROOT" rev-parse HEAD)"
[[ "$DEV_HEAD_AFTER" == "$DEV_HEAD_BEFORE" && "$DEV_SHA_AFTER" == "$DEV_SHA_BEFORE" ]] || {
  echo "[phase6-smoke] dev repo HEAD moved during smoke" >&2
  exit 1
}

echo "[phase6-smoke] PASS plan=$PLAN_ID events=$TOTAL_EVENTS phases=2 tasks=3 artifacts>=2"
exit 0
