#!/usr/bin/env bash
# Phase 5 smoke — PLACEHOLDER. Exits non-zero on purpose.
#
# Phase 5's exit criterion is "two-phase plan executes sequentially,
# advances only after each phase audit passes, and finishes with a
# passing plan-wide completion audit" (docs/roadmap/action-plan.md).
# That end-to-end path depends on Worker 4 (activities + workflows +
# API) and Worker 5 (the real smoke) which are not yet implemented.
#
# This script intentionally fails so that nobody — human, CI, another
# script — can misread a passing `smoke:phase5` as a real Phase 5 gate.
# When Worker 5 replaces this file with the real flow, it will exit 0
# only on the ten-assertion end-to-end path described in the plan.
set -euo pipefail

echo "[phase5-smoke] NOT YET IMPLEMENTED" >&2
echo "[phase5-smoke] Foundation lane (Worker 1) is complete on main." >&2
echo "[phase5-smoke] Merge primitives (Worker 2), auditor runners (Worker 3)," >&2
echo "[phase5-smoke] activities + workflows + API (Worker 4), and the real" >&2
echo "[phase5-smoke] smoke (Worker 5) still need to land." >&2
echo "[phase5-smoke] Exiting non-zero so the phase gate stays closed until then." >&2
exit 1
