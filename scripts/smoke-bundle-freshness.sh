#!/usr/bin/env bash
# Bundle freshness smoke (v0.8.2 Task 0.3, F1).
#
# Removes the worker + temporal-workflows dist trees, rebuilds them, and
# then runs a static cross-check between source startToCloseTimeout
# declarations and the compiled bundles. A mismatch usually means a
# rebuild step was skipped — exactly the class of bug that burned 45
# minutes during v0.8.1 dogfood (F1).
#
# Designed to finish in well under 30 seconds on a warm local stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "${BUNDLE_FRESHNESS_NO_REBUILD:-0}" != "1" ]; then
  echo "[bundle-freshness] Removing stale dist trees..."
  rm -rf apps/worker/dist packages/temporal-workflows/dist

  echo "[bundle-freshness] Rebuilding worker + temporal-workflows..."
  pnpm --filter @pm-go/temporal-workflows build >/dev/null
  pnpm --filter @pm-go/worker build >/dev/null
fi

echo "[bundle-freshness] Comparing source vs dist startToCloseTimeout..."
exec pnpm exec tsx "$REPO_ROOT/scripts/smoke-bundle-freshness.ts"
