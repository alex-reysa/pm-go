#!/usr/bin/env bash
# Phase 7 matrix/chaos harness — shared helpers.
#
# Why this file exists:
#   phase7-matrix.sh and phase7-chaos.sh both copy fixtures into tmpdirs,
#   initialise a git repo, and invoke the same tsx entry points. Keeping
#   the boilerplate here lets each script focus on its own assertions.
#
# Intentionally thin: this file only exports functions + constants. It
# must be `source`d from the entry scripts, not executed directly.

# shellcheck shell=bash

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "[phase7-harness] requires bash" >&2
  return 1 2>/dev/null || exit 1
fi

PHASE7_DEV_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PHASE7_DEV_REPO_ROOT

# Paths to the four matrix fixtures. Scripts iterate this list so adding
# a fifth fixture is a one-line change here.
PHASE7_MATRIX_FIXTURES=(
  "single-package"
  "monorepo-workspaces"
  "nested-packages"
  "ts-project-references"
)
export PHASE7_MATRIX_FIXTURES

# phase7_prepare_fixture <fixture-name> <dest-dir>
#   Copy the named fixture from packages/sample-repos/<name> into <dest-dir>,
#   initialise a git repo inside it, configure a throwaway identity, and
#   make one initial commit so the stub implementer has a base to fork
#   from. Echoes the absolute dest path on stdout.
phase7_prepare_fixture() {
  local fixture="$1"
  local dest="$2"
  local src="$PHASE7_DEV_REPO_ROOT/packages/sample-repos/$fixture"
  if [[ ! -d "$src" ]]; then
    echo "[phase7-harness] fixture '$fixture' not found at $src" >&2
    return 1
  fi
  mkdir -p "$dest"
  # -a preserves structure; we copy the directory's contents, not the
  # directory itself, so the repo root IS <dest>.
  cp -R "$src"/. "$dest"/
  (
    cd "$dest"
    git init -q -b main
    git config user.email "phase7@harness.local"
    git config user.name "phase7-harness"
    git add -A
    git commit -q -m "fixture: initial $fixture commit"
  )
  echo "$dest"
}

# phase7_run_inprocess_smoke <fixture-name> <fixture-repo>
#   Drive the stub-only in-process smoke against a prepared fixture repo.
#   Returns the tsx exit code verbatim so callers can assert pass/fail.
phase7_run_inprocess_smoke() {
  local fixture="$1"
  local repo="$2"
  PHASE7_FIXTURE_NAME="$fixture" \
  PHASE7_FIXTURE_REPO="$repo" \
    pnpm -s exec tsx "$PHASE7_DEV_REPO_ROOT/scripts/lib/phase7-inprocess-smoke.ts"
}

# phase7_run_inprocess_chaos <mode> <fixture-repo>
#   Drive the chaos harness against a prepared fixture repo. <mode> is one
#   of merge_conflict | review_rejection | worker_kill. Env-var activation
#   mirrors the documented invocation pattern in docs/phases/phase7-harness.md.
#
#   merge_conflict / review_rejection: set the relevant STUB_FAILURE env
#   var at the outer invocation — the driver runs a single pass and the
#   failure mode fires inside it.
#
#   worker_kill: the outer invocation does NOT set the failure env. The
#   driver spawns a child with IMPLEMENTER_STUB_FAILURE=worker_kill
#   (that child crashes), then a second child with PHASE7_CHAOS_RESUME=1
#   (that child completes). This two-sub-process shape is what
#   simulates the worker restart; pushing the env var onto the outer
#   invocation would collapse that shape into a single crash.
phase7_run_inprocess_chaos() {
  local mode="$1"
  local repo="$2"
  case "$mode" in
    merge_conflict)
      IMPLEMENTER_STUB_FAILURE="$mode" \
      PHASE7_FIXTURE_REPO="$repo" \
      PHASE7_CHAOS_MODE="$mode" \
        pnpm -s exec tsx "$PHASE7_DEV_REPO_ROOT/scripts/lib/phase7-inprocess-chaos.ts"
      ;;
    review_rejection)
      REVIEWER_STUB_FAILURE="$mode" \
      PHASE7_FIXTURE_REPO="$repo" \
      PHASE7_CHAOS_MODE="$mode" \
        pnpm -s exec tsx "$PHASE7_DEV_REPO_ROOT/scripts/lib/phase7-inprocess-chaos.ts"
      ;;
    worker_kill)
      PHASE7_FIXTURE_REPO="$repo" \
      PHASE7_CHAOS_MODE="$mode" \
        pnpm -s exec tsx "$PHASE7_DEV_REPO_ROOT/scripts/lib/phase7-inprocess-chaos.ts"
      ;;
    *)
      echo "[phase7-harness] unknown chaos mode '$mode'" >&2
      return 2
      ;;
  esac
}
