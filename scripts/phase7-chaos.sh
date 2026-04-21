#!/usr/bin/env bash
# Phase 7 chaos smoke.
#
# Drives one plan per failure mode and asserts durable-state recovery:
#   - IMPLEMENTER_STUB_FAILURE=merge_conflict  → task transitions to blocked
#     after retry exhaustion (does NOT silently succeed)
#   - REVIEWER_STUB_FAILURE=review_rejection   → task transitions to blocked
#     with a review_cycles_exceeded policy-decision breadcrumb
#   - IMPLEMENTER_STUB_FAILURE=worker_kill     → task stays running across
#     a worker-process kill, then resumes to ready_to_merge on the next
#     clean pass
#
# Runs against stub executors only. No Postgres, no Temporal. The full
# DB + Temporal replay assertion (policy-decision rows, workflow_events
# spans) lives in Worker 4's phase7-smoke.sh.
#
# Usage: pnpm smoke:phase7-chaos
#        PHASE7_CHAOS_ONLY=merge_conflict bash scripts/phase7-chaos.sh

set -euo pipefail

DEV_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEV_REPO_ROOT"

# shellcheck source=./lib/phase7-harness.sh
source "$DEV_REPO_ROOT/scripts/lib/phase7-harness.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "[chaos] jq is required but was not found on PATH" >&2
  exit 1
fi

SMOKE_BASE="$(mktemp -d -t pm-go-phase7-chaos)"
trap 'rm -rf "$SMOKE_BASE"' EXIT INT TERM

# Each mode runs against a fresh single-package fixture clone. Using the
# simplest fixture keeps the harness focused on the failure-mode
# transitions rather than repo shape.
CHAOS_MODES=(merge_conflict review_rejection worker_kill)
if [[ -n "${PHASE7_CHAOS_ONLY:-}" ]]; then
  CHAOS_MODES=("$PHASE7_CHAOS_ONLY")
fi

pass_count=0
fail_count=0
failed_modes=()

# Uppercase display name for the per-mode log line.
pretty_mode() {
  case "$1" in
    merge_conflict)    echo "MERGE_CONFLICT" ;;
    review_rejection)  echo "REVIEW_REJECTION" ;;
    worker_kill)       echo "WORKER_KILL" ;;
    *) echo "$1" ;;
  esac
}

echo "[chaos] running ${#CHAOS_MODES[@]} failure mode(s) against stub executors"
for mode in "${CHAOS_MODES[@]}"; do
  fixture_dir="$SMOKE_BASE/$mode"
  phase7_prepare_fixture "single-package" "$fixture_dir" >/dev/null

  state_file="$fixture_dir/.phase7-chaos-state.json"
  PHASE7_CHAOS_STATE_FILE="$state_file" \
    phase7_run_inprocess_chaos "$mode" "$fixture_dir" \
      > "$SMOKE_BASE/$mode.out" 2>&1 || true

  if [[ ! -f "$state_file" ]]; then
    echo "[chaos] $(pretty_mode "$mode"): FAIL — no state file at $state_file" >&2
    echo "--- chaos output ---" >&2
    cat "$SMOKE_BASE/$mode.out" >&2 || true
    fail_count=$((fail_count + 1))
    failed_modes+=("$mode")
    continue
  fi

  status="$(jq -r '.taskStatus' "$state_file")"
  reason="$(jq -r '.blockedReason // ""' "$state_file")"
  resumed="$(jq -r '.resumed // false' "$state_file")"
  killed_nonzero="$(jq -r '.killPassNonZero // false' "$state_file")"

  expected_ok=false
  case "$mode" in
    merge_conflict)
      if [[ "$status" == "blocked" && "$reason" == "merge_conflict" ]]; then
        expected_ok=true
      fi
      ;;
    review_rejection)
      if [[ "$status" == "blocked" && "$reason" == "review_cycles_exceeded" ]]; then
        expected_ok=true
      fi
      ;;
    worker_kill)
      # After the restart the task must land in ready_to_merge AND the
      # kill pass must have exited non-zero (otherwise we didn't
      # actually simulate the kill — we silently succeeded).
      if [[ "$status" == "ready_to_merge" && "$resumed" == "true" && "$killed_nonzero" == "true" ]]; then
        expected_ok=true
      fi
      ;;
  esac

  if $expected_ok; then
    pass_count=$((pass_count + 1))
    case "$mode" in
      merge_conflict)
        echo "[chaos] $(pretty_mode "$mode") -> blocked OK"
        ;;
      review_rejection)
        echo "[chaos] $(pretty_mode "$mode") -> blocked(review_cycles_exceeded) OK"
        ;;
      worker_kill)
        echo "[chaos] $(pretty_mode "$mode") -> kill->running->resume->ready_to_merge OK"
        ;;
    esac
  else
    fail_count=$((fail_count + 1))
    failed_modes+=("$mode")
    echo "[chaos] $(pretty_mode "$mode"): FAIL — status='$status' reason='$reason' resumed='$resumed' killed_nonzero='$killed_nonzero'" >&2
    echo "--- chaos output ---" >&2
    cat "$SMOKE_BASE/$mode.out" >&2 || true
    echo "--- state ---" >&2
    cat "$state_file" >&2 || true
  fi
done

echo "[chaos] ${pass_count}/${#CHAOS_MODES[@]} modes recovered durably"
if (( fail_count > 0 )); then
  echo "[chaos] failing modes: ${failed_modes[*]}" >&2
  exit 1
fi
exit 0
