#!/usr/bin/env bash
# Phase 7 process-runtime smoke test.
#
# Exercises the `claude` (process-runtime) executor path end-to-end:
#
#   1. Inserts a purpose-built mock `claude` binary (scripts/mock-claude/claude)
#      first on PATH — no real Anthropic API key required.
#   2. Boots the worker with all five *_RUNTIME=claude.
#   3. Runs a single-phase plan end-to-end against Postgres + Temporal.
#   4. Asserts the resulting agent_runs rows have the expected
#      role/executor/stopReason shape.
#   5. Asserts that at least one policy_decisions denial row was emitted for
#      the forbidden tool call the mock claude binary attempts.
#
# Prerequisites: Node >=22, pnpm >=10, Docker (Postgres + Temporal running).
#
# See docs/runtimes.md for the runtime model and process-runtime details.

set -euo pipefail

DEV_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEV_REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${TEMPORAL_ADDRESS:=localhost:7233}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=pm-go-worker}"
: "${API_PORT:=3001}"
: "${POSTGRES_CONTAINER:=pm-go-postgres-1}"

MOCK_CLAUDE_DIR="$DEV_REPO_ROOT/scripts/mock-claude"
if [[ ! -x "$MOCK_CLAUDE_DIR/claude" ]]; then
  echo "[phase7-process-runtime] mock claude binary not found or not executable: $MOCK_CLAUDE_DIR/claude" >&2
  exit 1
fi

for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[phase7-process-runtime] $tool is required but was not found on PATH" >&2
    exit 1
  fi
done

# Inject the mock claude binary first on PATH so all *_RUNTIME=claude roles
# fork it instead of any real claude binary.
export PATH="$MOCK_CLAUDE_DIR:$PATH"

# Verify the mock is now the active claude.
if ! command -v claude >/dev/null 2>&1; then
  echo "[phase7-process-runtime] claude not found on PATH after injection" >&2
  exit 1
fi
echo "[phase7-process-runtime] using mock claude: $(command -v claude)"
echo "[phase7-process-runtime] mock claude --version: $(claude --version)"

# All five roles run via the process-runtime (claude) executor.
export PLANNER_RUNTIME=claude
export IMPLEMENTER_RUNTIME=claude
export REVIEWER_RUNTIME=claude
export PHASE_AUDITOR_RUNTIME=claude
export COMPLETION_AUDITOR_RUNTIME=claude

# Keep other executor-mode variables in stub mode so the harness wiring
# (fixture loading, approval sequences) uses the existing stub helpers.
# The *_RUNTIME vars above drive the actual model invocation path.
: "${PLANNER_EXECUTOR_MODE:=stub}"
: "${IMPLEMENTER_EXECUTOR_MODE:=stub}"
: "${REVIEWER_EXECUTOR_MODE:=stub}"
: "${PHASE_AUDITOR_EXECUTOR_MODE:=stub}"
: "${COMPLETION_AUDITOR_EXECUTOR_MODE:=stub}"
: "${REVIEWER_SMOKE_SEQUENCE:=pass,pass,pass}"
: "${PHASE_AUDITOR_SMOKE_SEQUENCE:=pass,pass}"
: "${COMPLETION_AUDITOR_SMOKE_SEQUENCE:=pass}"
: "${PLANNER_STUB_FIXTURE_PATH:=$DEV_REPO_ROOT/packages/contracts/src/fixtures/orchestration-review/plan-phase5-smoke.json}"
: "${IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG:=p5-task-a=phase7-process-runtime/task-a.txt}"
: "${IMPLEMENTER_STUB_WRITE_FILE_CONTENTS:=phase7-process-runtime output}"

export PLANNER_EXECUTOR_MODE IMPLEMENTER_EXECUTOR_MODE \
  REVIEWER_EXECUTOR_MODE PHASE_AUDITOR_EXECUTOR_MODE \
  COMPLETION_AUDITOR_EXECUTOR_MODE REVIEWER_SMOKE_SEQUENCE \
  PHASE_AUDITOR_SMOKE_SEQUENCE COMPLETION_AUDITOR_SMOKE_SEQUENCE \
  PLANNER_STUB_FIXTURE_PATH IMPLEMENTER_STUB_WRITE_FILE_PATH_BY_SLUG \
  IMPLEMENTER_STUB_WRITE_FILE_CONTENTS

# ---------------------------------------------------------------------------
# Bring up the local stack if not running.
# ---------------------------------------------------------------------------

if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  echo "[phase7-process-runtime] starting docker compose stack"
  docker compose up -d >/dev/null
  sleep 3
fi

echo "[phase7-process-runtime] applying migrations"
DATABASE_URL="$DATABASE_URL" pnpm db:migrate >/dev/null

# ---------------------------------------------------------------------------
# Temp-clone isolation.
# ---------------------------------------------------------------------------

SMOKE_BASE="$(mktemp -d -t pm-go-phase7-process-runtime)"
SMOKE_REPO_ROOT="$SMOKE_BASE/repo"
export PLAN_ARTIFACT_DIR="${PLAN_ARTIFACT_DIR:-$SMOKE_BASE/artifacts}"
export WORKTREE_ROOT="${WORKTREE_ROOT:-$SMOKE_BASE/worktrees}"
export INTEGRATION_WORKTREE_ROOT="${INTEGRATION_WORKTREE_ROOT:-$SMOKE_BASE/integration-worktrees}"
export REPO_ROOT="$SMOKE_REPO_ROOT"
export DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE API_PORT

echo "[phase7-process-runtime] cloning DEV_REPO_ROOT → $SMOKE_REPO_ROOT"
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

echo "[phase7-process-runtime] building"
pnpm build >/dev/null

echo "[phase7-process-runtime] starting worker (logs: $WORKER_LOG)"
pnpm start:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[phase7-process-runtime] starting api (logs: $API_LOG)"
pnpm start:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[phase7-process-runtime] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[phase7-process-runtime] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    echo "[phase7-process-runtime] api did not start within 30s" >&2
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
  echo "[phase7-process-runtime] task $task_id did not reach $target in ${max}s (last=$last)" >&2
  return 1
}

# ---------------------------------------------------------------------------
# Drive a single-phase plan end-to-end.
# ---------------------------------------------------------------------------

SPEC_BODY_JSON="$(jq -Rs '.' < "$DEV_REPO_ROOT/examples/golden-path/spec.md")"
SPEC_PAYLOAD="$(jq -n \
  --arg title "Phase 7 process-runtime smoke" \
  --argjson body "$SPEC_BODY_JSON" \
  --arg repoRoot "$SMOKE_REPO_ROOT" \
  --arg source "manual" \
  '{title: $title, body: $body, repoRoot: $repoRoot, source: $source}')"

echo "[phase7-process-runtime] POST /spec-documents"
SPEC_RESPONSE="$(curl -sf -X POST "$API/spec-documents" \
  -H 'content-type: application/json' --data "$SPEC_PAYLOAD")"
SPEC_DOC_ID="$(echo "$SPEC_RESPONSE" | jq -r '.specDocumentId')"
SNAPSHOT_ID="$(echo "$SPEC_RESPONSE" | jq -r '.repoSnapshotId')"

echo "[phase7-process-runtime] POST /plans"
PLAN_RESPONSE="$(curl -sf -X POST "$API/plans" \
  -H 'content-type: application/json' --data "$(jq -n \
    --arg s "$SPEC_DOC_ID" --arg r "$SNAPSHOT_ID" \
    '{specDocumentId: $s, repoSnapshotId: $r}')")"
PLAN_ID="$(echo "$PLAN_RESPONSE" | jq -r '.planId')"
echo "[phase7-process-runtime] plan=$PLAN_ID"

# Wait for plan to be reconstructed.
for i in {1..30}; do
  if curl -sf "$API/plans/$PLAN_ID" | jq -e '.plan.phases | length > 0' >/dev/null 2>&1; then
    break
  fi
  sleep 1
  (( i == 30 )) && { echo "[phase7-process-runtime] plan never appeared after 30s" >&2; exit 1; }
done

PLAN_DOC="$(curl -sf "$API/plans/$PLAN_ID")"
ONE_TASK_ID="$(echo "$PLAN_DOC" | jq -r '.plan.phases[0].taskIds[0]')"
echo "[phase7-process-runtime] driving task $ONE_TASK_ID"

curl -sf -X POST "$API/tasks/$ONE_TASK_ID/run" \
  -H 'content-type: application/json' --data '{}' >/dev/null
wait_for_task_status "$ONE_TASK_ID" "in_review" 120

# ---------------------------------------------------------------------------
# Assertion 1: agent_runs rows have expected role/executor/stopReason shape.
# ---------------------------------------------------------------------------

echo "[phase7-process-runtime] === assertion 1: agent_runs shape ==="
RUN_COUNT="$(pg "SELECT count(*) FROM agent_runs
  WHERE task_id='$ONE_TASK_ID' AND executor='claude'")"
if [[ -z "$RUN_COUNT" ]] || (( RUN_COUNT < 1 )); then
  echo "[phase7-process-runtime] expected >=1 agent_runs row with executor='claude', got $RUN_COUNT" >&2
  exit 1
fi
echo "[phase7-process-runtime] agent_runs with executor=claude: $RUN_COUNT"

# Verify stop_reason is populated (end_turn for mock binary).
STOP_REASON_COUNT="$(pg "SELECT count(*) FROM agent_runs
  WHERE task_id='$ONE_TASK_ID' AND executor='claude' AND stop_reason IS NOT NULL")"
if (( STOP_REASON_COUNT < 1 )); then
  echo "[phase7-process-runtime] expected agent_runs.stop_reason to be set, got 0 rows with non-null stop_reason" >&2
  exit 1
fi
echo "[phase7-process-runtime] agent_runs with stop_reason set: $STOP_REASON_COUNT"

# ---------------------------------------------------------------------------
# Assertion 2: at least one policy_decisions denial row for the forbidden
# tool call the mock claude binary emits (`computer` tool).
# ---------------------------------------------------------------------------

echo "[phase7-process-runtime] === assertion 2: policy_decisions denial ==="
DENIAL_COUNT="$(pg "SELECT count(*) FROM policy_decisions
  WHERE subject_id='$ONE_TASK_ID' AND decision='denied'")"
if (( DENIAL_COUNT < 1 )); then
  echo "[phase7-process-runtime] expected >=1 policy_decisions row with decision='denied' for forbidden tool call, got $DENIAL_COUNT" >&2
  echo "[phase7-process-runtime] NOTE: this assertion requires the policy MCP bridge to be wired into the process-runtime executor." >&2
  echo "[phase7-process-runtime] If the bridge is not yet wired, this is a known gap — see docs/runtimes.md Known Limitations." >&2
  exit 1
fi
echo "[phase7-process-runtime] policy_decisions denial rows: $DENIAL_COUNT"

echo "phase7-process-runtime OK"
