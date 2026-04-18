#!/usr/bin/env bash
# Phase 1b end-to-end smoke test.
#
# Verifies the vertical slice: HTTP POST -> Hono route -> Temporal client ->
# worker activity -> Drizzle insert -> Postgres row.
#
# Preconditions (run these first if not already):
#   pnpm docker:up              # starts postgres + temporal + temporal-ui
#   pnpm db:migrate             # applies db/migrations/*.sql
#   cp .env.example .env        # (then export DATABASE_URL etc.)
#
# Usage: pnpm smoke:phase1b

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${TEMPORAL_ADDRESS:=localhost:7233}"
: "${TEMPORAL_NAMESPACE:=default}"
: "${TEMPORAL_TASK_QUEUE:=pm-go-worker}"
: "${API_PORT:=3001}"

SPEC_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
WORKER_LOG="$(mktemp)"
API_LOG="$(mktemp)"

cleanup() {
  local exit_code=$?
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${API_PID:-}" ]]    && kill "$API_PID"    2>/dev/null || true
  rm -f "$WORKER_LOG" "$API_LOG"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "[smoke] starting worker (logs: $WORKER_LOG)"
pnpm dev:worker >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "[smoke] starting api (logs: $API_LOG)"
pnpm dev:api >"$API_LOG" 2>&1 &
API_PID=$!

echo "[smoke] waiting for api on :$API_PORT"
for i in {1..30}; do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
    echo "[smoke] api ready"
    break
  fi
  sleep 1
  if (( i == 30 )); then echo "[smoke] api did not start" >&2; exit 1; fi
done

echo "[smoke] posting spec document id=$SPEC_ID"
RESPONSE="$(curl -sf -X POST "http://localhost:$API_PORT/spec-documents" \
  -H 'content-type: application/json' \
  --data "$(cat <<JSON
{
  "id": "$SPEC_ID",
  "title": "phase1b smoke",
  "source": "manual",
  "body": "end-to-end smoke test payload",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
)")"
echo "[smoke] api response: $RESPONSE"

echo "[smoke] waiting for worker to persist row"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-pm-go-postgres-1}"
for i in {1..20}; do
  ROW_COUNT="$(docker exec "$POSTGRES_CONTAINER" psql -U pmgo -d pm_go -tAc "select count(*) from spec_documents where id = '$SPEC_ID'" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$ROW_COUNT" == "1" ]]; then
    echo "[smoke] PASS: row $SPEC_ID persisted"
    exit 0
  fi
  sleep 1
done

echo "[smoke] FAIL: row not found in spec_documents after 20s" >&2
echo "--- worker log tail ---" >&2
tail -n 30 "$WORKER_LOG" >&2
echo "--- api log tail ---" >&2
tail -n 30 "$API_LOG" >&2
exit 1
