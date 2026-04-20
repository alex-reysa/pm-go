#!/usr/bin/env bash
# Phase 5 end-to-end smoke test.
#
# Drives a 2-phase plan through integration → audit → completion → release:
#   spec → plan → (phase 0: run+review each task → integrate → audit) →
#     (phase 1: run+review each task → integrate → audit) →
#     complete → release.
#
# Runs against a temp clone of the repo so `git update-ref refs/heads/main`
# doesn't touch the developer's checkout. Uses no-op testCommands in the
# fixture so validatePostMergeState passes against a fresh clone with no
# pnpm install.
#
# Preconditions:
#   pnpm docker:up            # starts postgres + temporal + temporal-ui
#   pnpm db:migrate           # applies db/migrations/*.sql
#   cp .env.example .env      # (then export DATABASE_URL etc.)
#
# Usage: pnpm smoke:phase5

set -euo pipefail

# ---------------------------------------------------------------------------
# F4: distinct variables for the dev repo (never reassigned) and the
# ephemeral smoke repo (exported as REPO_ROOT for worker + API). The
# "dev HEAD unchanged" assertion checks DEV_REPO_ROOT explicitly.
# ---------------------------------------------------------------------------

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
# Three tasks → three reviews, each 'pass' on cycle 1.
: "${REVIEWER_SMOKE_SEQUENCE:=pass,pass,pass}"
: "${PHASE_AUDITOR_SMOKE_SEQUENCE:=pass,pass}"
: "${COMPLETION_AUDITOR_SMOKE_SEQUENCE:=pass}"
# Point the stub planner at the dedicated Phase 5 fixture (lives in
# the DEV repo so the path is stable regardless of where the temp
# clone lands).
: "${PLANNER_STUB_FIXTURE_PATH:=$DEV_REPO_ROOT/packages/contracts/src/fixtures/orchestration-review/plan-phase5-smoke.json}"
# Per-slug stub write paths — each matches one task's fileScope.includes.
: "${IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG:=p5-task-a=phase5-smoke/task-a.txt,p5-task-b=phase5-smoke/task-b.txt,p5-task-c=phase5-smoke/task-c.txt}"
: "${IMPLEMENTER_STUB_WRITE_FILE_CONTENTS:=phase5 stub output}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[phase5-smoke] jq is required but was not found on PATH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Temp-clone isolation.
# ---------------------------------------------------------------------------

SMOKE_BASE="$(mktemp -d -t pm-go-phase5-smoke)"
SMOKE_REPO_ROOT="$SMOKE_BASE/repo"
export PLAN_ARTIFACT_DIR="${PLAN_ARTIFACT_DIR:-$SMOKE_BASE/artifacts}"
export WORKTREE_ROOT="${WORKTREE_ROOT:-$SMOKE_BASE/worktrees}"
export INTEGRATION_WORKTREE_ROOT="${INTEGRATION_WORKTREE_ROOT:-$SMOKE_BASE/integration-worktrees}"
# Worker + API operate against SMOKE_REPO_ROOT — never DEV_REPO_ROOT.
export REPO_ROOT="$SMOKE_REPO_ROOT"
export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE \
  API_PORT PLANNER_EXECUTOR_MODE IMPLEMENTER_EXECUTOR_MODE \
  REVIEWER_EXECUTOR_MODE REVIEWER_SMOKE_SEQUENCE \
  PHASE_AUDITOR_EXECUTOR_MODE PHASE_AUDITOR_SMOKE_SEQUENCE \
  COMPLETION_AUDITOR_EXECUTOR_MODE COMPLETION_AUDITOR_SMOKE_SEQUENCE \
  PLANNER_STUB_FIXTURE_PATH \
  IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG IMPLEMENTER_STUB_WRITE_FILE_CONTENTS

echo "[phase5-smoke] cloning DEV_REPO_ROOT → $SMOKE_REPO_ROOT"
git clone --local --no-hardlinks "$DEV_REPO_ROOT" "$SMOKE_REPO_ROOT" >/dev/null
# Ensure the clone has a proper `refs/heads/main` (git clone --local
# preserves the source's HEAD, but if HEAD was detached we materialize
# it here so PhaseAuditWorkflow has a ref to advance).
if ! git -C "$SMOKE_REPO_ROOT" show-ref --verify --quiet refs/heads/main; then
  git -C "$SMOKE_REPO_ROOT" checkout -b main >/dev/null 2>&1 || true
fi

# Record dev checkout HEAD — assertion 8 verifies these don't move.
DEV_HEAD_BEFORE="$(git -C "$DEV_REPO_ROOT" symbolic-ref HEAD 2>/dev/null || echo 'DETACHED')"
DEV_SHA_BEFORE="$(git -C "$DEV_REPO_ROOT" rev-parse HEAD)"
# Record smoke clone's main before any phase audit fires.
SMOKE_MAIN_BEFORE="$(git -C "$SMOKE_REPO_ROOT" rev-parse refs/heads/main)"

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

echo "[phase5-smoke] building (stub mode)"
pnpm build >/dev/null

echo "[phase5-smoke] starting worker (logs: $WORKER_LOG)"
pnpm start:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[phase5-smoke] starting api (logs: $API_LOG)"
pnpm start:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[phase5-smoke] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[phase5-smoke] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[phase5-smoke] api did not start within 30s" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Helper: wait until a task / phase / plan reaches a target status.
# ---------------------------------------------------------------------------

wait_for_task_status() {
  local task_id="$1"
  local target="$2"
  local max="${3:-120}"
  local last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "http://localhost:$API_PORT/tasks/$task_id" \
      | jq -r '.task.status // "?"')"
    if [[ "$last" == "$target" ]]; then
      echo "[phase5-smoke] task $task_id → $target (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "[phase5-smoke] task $task_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

wait_for_phase_status() {
  local phase_id="$1"
  local target="$2"
  local max="${3:-120}"
  local last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "http://localhost:$API_PORT/phases/$phase_id" \
      | jq -r '.phase.status // "?"')"
    if [[ "$last" == "$target" ]]; then
      echo "[phase5-smoke] phase $phase_id → $target (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "[phase5-smoke] phase $phase_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

wait_for_plan_status() {
  local plan_id="$1"
  local target="$2"
  local max="${3:-120}"
  local last="?"
  for i in $(seq 1 "$max"); do
    last="$(curl -sf "http://localhost:$API_PORT/plans/$plan_id" \
      | jq -r '.plan.status // "?"')"
    if [[ "$last" == "$target" ]]; then
      echo "[phase5-smoke] plan $plan_id → $target (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "[phase5-smoke] plan $plan_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

# Run a single task through Phase 4's state machine: run → in_review →
# review → ready_to_merge. Stub reviewer emits 'pass' per
# REVIEWER_SMOKE_SEQUENCE so one review cycle is enough.
run_task_through_review() {
  local task_id="$1"
  curl -sf -X POST "http://localhost:$API_PORT/tasks/$task_id/run" \
    -H 'content-type: application/json' --data '{}' >/dev/null
  wait_for_task_status "$task_id" "in_review" 120
  curl -sf -X POST "http://localhost:$API_PORT/tasks/$task_id/review" >/dev/null
  wait_for_task_status "$task_id" "ready_to_merge" 90
}

# ---------------------------------------------------------------------------
# Step 1-2: spec + plan.
# ---------------------------------------------------------------------------

SPEC_BODY_JSON="$(jq -Rs '.' < "$DEV_REPO_ROOT/examples/golden-path/spec.md")"
SPEC_PAYLOAD="$(jq -n \
  --arg title "Phase 5 smoke" \
  --argjson body "$SPEC_BODY_JSON" \
  --arg repoRoot "$SMOKE_REPO_ROOT" \
  --arg source "manual" \
  '{title: $title, body: $body, repoRoot: $repoRoot, source: $source}')"

echo "[phase5-smoke] POST /spec-documents"
SPEC_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/spec-documents" \
  -H 'content-type: application/json' --data "$SPEC_PAYLOAD")"
SPEC_DOC_ID="$(echo "$SPEC_RESPONSE" | jq -r '.specDocumentId')"
SNAPSHOT_ID="$(echo "$SPEC_RESPONSE" | jq -r '.repoSnapshotId')"

echo "[phase5-smoke] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/plans" \
  -H 'content-type: application/json' --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" \
    --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[phase5-smoke] plan=$PLAN_ID"

echo "[phase5-smoke] waiting for plan row"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[phase5-smoke] plan never appeared after 30s" >&2
    exit 1
  fi
done

PLAN_DOC="$(curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID")"
PHASE_0_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].id')"
PHASE_1_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[1].id')"
PHASE_0_TASK_IDS="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[]')"
PHASE_1_TASK_IDS="$(echo "$PLAN_DOC" | jq -r '.plan.phases[1].taskIds[]')"
echo "[phase5-smoke] phase0=$PHASE_0_ID phase1=$PHASE_1_ID"

# ---------------------------------------------------------------------------
# F1: SEQUENTIAL execution. Phase 0 runs to `completed` BEFORE any
# phase-1 /tasks/:id/run. This is the core invariant the smoke proves.
# ---------------------------------------------------------------------------

echo "[phase5-smoke] === phase 0: run each task through review ==="
while IFS= read -r TASK_ID; do
  [[ -z "$TASK_ID" ]] && continue
  run_task_through_review "$TASK_ID"
done <<< "$PHASE_0_TASK_IDS"

echo "[phase5-smoke] POST /phases/$PHASE_0_ID/integrate"
curl -sf -X POST "http://localhost:$API_PORT/phases/$PHASE_0_ID/integrate" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_0_ID" "auditing" 180

echo "[phase5-smoke] POST /phases/$PHASE_0_ID/audit"
curl -sf -X POST "http://localhost:$API_PORT/phases/$PHASE_0_ID/audit" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_0_ID" "completed" 120

# Sequential gate: main must now point at phase-0's integration head AND
# phase 1 must be 'executing' (transitioned by PhaseAuditWorkflow).
SMOKE_MAIN_AFTER_P0="$(git -C "$SMOKE_REPO_ROOT" rev-parse refs/heads/main)"
if [[ "$SMOKE_MAIN_AFTER_P0" == "$SMOKE_MAIN_BEFORE" ]]; then
  echo "[phase5-smoke] main did not advance after phase 0 audit" >&2
  exit 1
fi
PHASE_1_STATUS_AFTER_P0="$(curl -sf "http://localhost:$API_PORT/phases/$PHASE_1_ID" \
  | jq -r '.phase.status')"
if [[ "$PHASE_1_STATUS_AFTER_P0" != "executing" ]]; then
  echo "[phase5-smoke] phase 1 expected 'executing' after phase-0 pass, got '$PHASE_1_STATUS_AFTER_P0'" >&2
  exit 1
fi
echo "[phase5-smoke] sequential gate: main advanced, phase 1 now 'executing'"

echo "[phase5-smoke] === phase 1: run each task through review ==="
while IFS= read -r TASK_ID; do
  [[ -z "$TASK_ID" ]] && continue
  run_task_through_review "$TASK_ID"
  # Extra invariant: the fresh lease for this phase-1 task forked from
  # the post-phase-0 main sha (i.e. phase 1's updated baseSnapshotId),
  # not the pre-smoke baseline. Confirms F1 beyond status transitions.
  LEASE_BASE="$(pg "SELECT base_sha FROM worktree_leases WHERE task_id='$TASK_ID' AND kind='task' ORDER BY created_at DESC LIMIT 1")"
  if [[ "$LEASE_BASE" != "$SMOKE_MAIN_AFTER_P0" ]]; then
    echo "[phase5-smoke] phase-1 task $TASK_ID lease base_sha='$LEASE_BASE' does not match post-phase-0 main='$SMOKE_MAIN_AFTER_P0'" >&2
    exit 1
  fi
done <<< "$PHASE_1_TASK_IDS"

echo "[phase5-smoke] POST /phases/$PHASE_1_ID/integrate"
curl -sf -X POST "http://localhost:$API_PORT/phases/$PHASE_1_ID/integrate" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_1_ID" "auditing" 180

echo "[phase5-smoke] POST /phases/$PHASE_1_ID/audit"
curl -sf -X POST "http://localhost:$API_PORT/phases/$PHASE_1_ID/audit" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_phase_status "$PHASE_1_ID" "completed" 120

SMOKE_MAIN_AFTER_P1="$(git -C "$SMOKE_REPO_ROOT" rev-parse refs/heads/main)"
if [[ "$SMOKE_MAIN_AFTER_P1" == "$SMOKE_MAIN_AFTER_P0" ]]; then
  echo "[phase5-smoke] main did not advance after phase 1 audit" >&2
  exit 1
fi

echo "[phase5-smoke] POST /plans/$PLAN_ID/complete"
curl -sf -X POST "http://localhost:$API_PORT/plans/$PLAN_ID/complete" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_plan_status "$PLAN_ID" "completed" 120

echo "[phase5-smoke] POST /plans/$PLAN_ID/release"
curl -sf -X POST "http://localhost:$API_PORT/plans/$PLAN_ID/release" \
  -H 'content-type: application/json' --data '{}' >/dev/null

# Release workflow is async — poll for pr_summary artifact row.
for i in {1..60}; do
  PR_COUNT="$(pg "SELECT count(*) FROM artifacts WHERE plan_id='$PLAN_ID' AND kind='pr_summary'")"
  if [[ "$PR_COUNT" == "1" ]]; then
    break
  fi
  sleep 1
  if (( i == 60 )); then
    echo "[phase5-smoke] pr_summary artifact never landed within 60s" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# D11 assertions (12).
# ---------------------------------------------------------------------------

echo "[phase5-smoke] === durable-state assertions ==="

# 2. plan.status='completed' + completion_audit_report_id stamped.
PLAN_STATUS="$(pg "SELECT status FROM plans WHERE id='$PLAN_ID'")"
[[ "$PLAN_STATUS" == "completed" ]] || {
  echo "[phase5-smoke] plan.status expected completed, got '$PLAN_STATUS'" >&2; exit 1
}
PLAN_COMPLETION_ID="$(pg "SELECT COALESCE(completion_audit_report_id::text, '') FROM plans WHERE id='$PLAN_ID'")"
[[ -n "$PLAN_COMPLETION_ID" ]] || {
  echo "[phase5-smoke] plan.completion_audit_report_id is null" >&2; exit 1
}

# 3. 2 merge_runs with post_merge_snapshot_id + integration_head_sha set.
MERGE_COUNT="$(pg "SELECT count(*) FROM merge_runs WHERE plan_id='$PLAN_ID' AND post_merge_snapshot_id IS NOT NULL AND integration_head_sha IS NOT NULL")"
[[ "$MERGE_COUNT" == "2" ]] || {
  echo "[phase5-smoke] expected 2 fully-stamped merge_runs, got $MERGE_COUNT" >&2; exit 1
}

# 4. 2 phase_audit_reports all 'pass'.
PAR_COUNT="$(pg "SELECT count(*) FROM phase_audit_reports WHERE plan_id='$PLAN_ID' AND outcome='pass'")"
[[ "$PAR_COUNT" == "2" ]] || {
  echo "[phase5-smoke] expected 2 phase_audit_reports with pass, got $PAR_COUNT" >&2; exit 1
}

# 5. 1 completion_audit_reports with outcome='pass'.
CAR_COUNT="$(pg "SELECT count(*) FROM completion_audit_reports WHERE plan_id='$PLAN_ID' AND outcome='pass'")"
[[ "$CAR_COUNT" == "1" ]] || {
  echo "[phase5-smoke] expected 1 completion_audit_report pass, got $CAR_COUNT" >&2; exit 1
}

# 6. 2 integration worktree_leases rows for the two phases.
INT_LEASE_COUNT="$(pg "SELECT count(*) FROM worktree_leases WHERE kind='integration' AND (phase_id='$PHASE_0_ID' OR phase_id='$PHASE_1_ID')")"
[[ "$INT_LEASE_COUNT" == "2" ]] || {
  echo "[phase5-smoke] expected 2 integration leases, got $INT_LEASE_COUNT" >&2; exit 1
}

# 7. main sha matches phase 1's merged_head_sha; two advances total.
LATEST_MERGED_HEAD="$(pg "SELECT merged_head_sha FROM phase_audit_reports WHERE phase_id='$PHASE_1_ID' ORDER BY created_at DESC LIMIT 1")"
[[ "$SMOKE_MAIN_AFTER_P1" == "$LATEST_MERGED_HEAD" ]] || {
  echo "[phase5-smoke] smoke main ($SMOKE_MAIN_AFTER_P1) != phase-1 merged_head_sha ($LATEST_MERGED_HEAD)" >&2; exit 1
}

# 8. Dev repo HEAD unchanged (F4: explicitly DEV_REPO_ROOT).
DEV_HEAD_AFTER="$(git -C "$DEV_REPO_ROOT" symbolic-ref HEAD 2>/dev/null || echo 'DETACHED')"
DEV_SHA_AFTER="$(git -C "$DEV_REPO_ROOT" rev-parse HEAD)"
[[ "$DEV_HEAD_AFTER" == "$DEV_HEAD_BEFORE" ]] || {
  echo "[phase5-smoke] DEV symbolic-ref moved: '$DEV_HEAD_BEFORE' → '$DEV_HEAD_AFTER'" >&2; exit 1
}
[[ "$DEV_SHA_AFTER" == "$DEV_SHA_BEFORE" ]] || {
  echo "[phase5-smoke] DEV HEAD sha moved: $DEV_SHA_BEFORE → $DEV_SHA_AFTER" >&2; exit 1
}

# 9. phase-1 base_snapshot_id matches phase-0's post_merge_snapshot_id.
PHASE_1_BASE="$(pg "SELECT base_snapshot_id FROM phases WHERE id='$PHASE_1_ID'")"
PHASE_0_POST="$(pg "SELECT post_merge_snapshot_id FROM merge_runs WHERE phase_id='$PHASE_0_ID' ORDER BY started_at DESC LIMIT 1")"
[[ "$PHASE_1_BASE" == "$PHASE_0_POST" ]] || {
  echo "[phase5-smoke] phase 1 base_snapshot_id ($PHASE_1_BASE) != phase 0 post_merge_snapshot_id ($PHASE_0_POST)" >&2; exit 1
}

# 10. pr-summary + evidence-bundle artifacts on disk.
PR_URI="$(pg "SELECT uri FROM artifacts WHERE plan_id='$PLAN_ID' AND kind='pr_summary' ORDER BY created_at DESC LIMIT 1")"
EB_URI="$(pg "SELECT uri FROM artifacts WHERE plan_id='$PLAN_ID' AND kind='completion_evidence_bundle' ORDER BY created_at DESC LIMIT 1")"
PR_PATH="${PR_URI#file://}"
EB_PATH="${EB_URI#file://}"
[[ -s "$PR_PATH" ]] || { echo "[phase5-smoke] pr-summary missing at $PR_PATH" >&2; exit 1; }
[[ -s "$EB_PATH" ]] || { echo "[phase5-smoke] evidence-bundle missing at $EB_PATH" >&2; exit 1; }
grep -q "Phase 5 smoke — phase 0" "$PR_PATH" || {
  echo "[phase5-smoke] pr-summary does not mention phase 0 title" >&2; exit 1
}
grep -q "Phase 5 smoke — phase 1" "$PR_PATH" || {
  echo "[phase5-smoke] pr-summary does not mention phase 1 title" >&2; exit 1
}
EB_PA_COUNT="$(jq '.phaseAuditReportIds | length' "$EB_PATH")"
EB_MR_COUNT="$(jq '.mergeRunIds | length' "$EB_PATH")"
[[ "$EB_PA_COUNT" == "2" && "$EB_MR_COUNT" == "2" ]] || {
  echo "[phase5-smoke] evidence-bundle counts wrong: phaseAudits=$EB_PA_COUNT mergeRuns=$EB_MR_COUNT" >&2; exit 1
}

# 11. GET /plans/:id includes latestCompletionAudit.outcome='pass'.
LATEST_OUTCOME="$(curl -sf "http://localhost:$API_PORT/plans/$PLAN_ID" \
  | jq -r '.latestCompletionAudit.outcome // "null"')"
[[ "$LATEST_OUTCOME" == "pass" ]] || {
  echo "[phase5-smoke] GET /plans latestCompletionAudit.outcome expected pass, got '$LATEST_OUTCOME'" >&2; exit 1
}

# Informational: the current render-pr-summary test enforces
# byte-determinism. Full cross-run repeatability (assertion 12) requires a
# DB reset helper that's out of Worker 5 scope.

echo "[phase5-smoke] PASS plan=$PLAN_ID phases=2 merges=2 audits=2 completion=pass artifacts=2"
exit 0
