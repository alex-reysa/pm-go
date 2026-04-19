#!/usr/bin/env bash
# Phase 5 smoke — placeholder.
#
# The real end-to-end smoke (Phase 4 task-execution + POST /phases/:id/integrate
# + POST /phases/:id/audit for both phases + POST /plans/:id/complete
# + POST /plans/:id/release + durable-state assertions) lands in the
# Phase 5 "activities + workflows + API" reconciliation lane (Worker 4/5).
# This placeholder exists so the `smoke:phase5` package.json entry has a
# valid target while earlier lanes are in flight.
set -euo pipefail

echo "[phase5-smoke] placeholder — full smoke lands in the api+smoke reconciliation lane"
echo "[phase5-smoke] foundation status: merge_runs + phase_audit_reports + completion_audit_reports tables present (migration 0006); PhaseAuditor/CompletionAuditor stubs registered; phase-auditor@1 + completion-auditor@1 prompt placeholders in PROMPT_VERSIONS"
exit 0
