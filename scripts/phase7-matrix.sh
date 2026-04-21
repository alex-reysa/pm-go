#!/usr/bin/env bash
# Phase 7 matrix smoke.
#
# Drives a minimal phase5-shape round trip (planner stub → implementer
# stub with file-write → reviewer stub pass) against each of the four
# sample-repo fixtures under packages/sample-repos/. Each fixture is
# copied into a fresh tmpdir + git-init'd; the smoke passes if all four
# fixtures exit 0.
#
# This harness intentionally runs against **stub executors only** — no
# Claude API calls, no Postgres, no Temporal. The full-stack Phase 7
# assertion lives in Worker 4's phase7-smoke.sh.
#
# Usage: pnpm smoke:phase7-matrix

set -euo pipefail

DEV_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEV_REPO_ROOT"

# shellcheck source=./lib/phase7-harness.sh
source "$DEV_REPO_ROOT/scripts/lib/phase7-harness.sh"

SMOKE_BASE="$(mktemp -d -t pm-go-phase7-matrix)"
trap 'rm -rf "$SMOKE_BASE"' EXIT INT TERM

pass_count=0
fail_count=0
failed_fixtures=()

echo "[matrix] running ${#PHASE7_MATRIX_FIXTURES[@]} sample-repo fixtures against stub executors"
for fixture in "${PHASE7_MATRIX_FIXTURES[@]}"; do
  fixture_dir="$SMOKE_BASE/$fixture"
  phase7_prepare_fixture "$fixture" "$fixture_dir" >/dev/null
  if phase7_run_inprocess_smoke "$fixture" "$fixture_dir"; then
    pass_count=$((pass_count + 1))
    echo "[matrix] ${fixture}: PASS"
  else
    fail_count=$((fail_count + 1))
    failed_fixtures+=("$fixture")
    echo "[matrix] ${fixture}: FAIL" >&2
  fi
done

echo "[matrix] ${pass_count}/${#PHASE7_MATRIX_FIXTURES[@]} fixtures green"
if (( fail_count > 0 )); then
  echo "[matrix] failing fixtures: ${failed_fixtures[*]}" >&2
  exit 1
fi
exit 0
