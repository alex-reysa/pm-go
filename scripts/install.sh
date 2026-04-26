#!/usr/bin/env bash
#
# pm-go installer.
#
# Idempotent: safe to re-run for upgrades. Clones (or pulls) pm-go into
# $PM_GO_INSTALL_DIR (default ~/.pm-go), installs deps, builds the
# workspace, and symlinks `bin/pm-go` into a directory on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/alex-reysa/pm-go/main/scripts/install.sh | bash
#   # or
#   bash scripts/install.sh           # from a clone, just rebuilds + relinks
#
# Env knobs:
#   PM_GO_INSTALL_DIR   where the repo lives (default: ~/.pm-go/pm-go)
#   PM_GO_BIN_DIR       where to symlink (default: /usr/local/bin if writable, else ~/.local/bin)
#   PM_GO_REF           git ref to check out (default: main)
#   PM_GO_REPO_URL      override the upstream URL (default: https://github.com/alex-reysa/pm-go.git)

set -euo pipefail

INSTALL_PARENT="${PM_GO_INSTALL_DIR:-$HOME/.pm-go}"
INSTALL_DIR="$INSTALL_PARENT/pm-go"
REF="${PM_GO_REF:-main}"
REPO_URL="${PM_GO_REPO_URL:-https://github.com/alex-reysa/pm-go.git}"

say() { printf '[pm-go install] %s\n' "$*"; }
die() { printf '[pm-go install] error: %s\n' "$*" >&2; exit 1; }

# 1. Tooling check.
command -v git >/dev/null  || die "git is required but not on PATH"
command -v node >/dev/null || die "node is required (>= 22)"
if ! command -v pnpm >/dev/null; then
  say "pnpm not found; attempting to enable corepack"
  if command -v corepack >/dev/null; then
    corepack enable >/dev/null 2>&1 || true
  fi
  command -v pnpm >/dev/null || die "pnpm is required. Install with: npm install -g pnpm"
fi

# 2. Fetch / update sources. If we're already running from inside a
#    pm-go checkout, install in place rather than re-cloning.
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
if [ -f "$SCRIPT_REPO_ROOT/bin/pm-go" ] && [ -d "$SCRIPT_REPO_ROOT/.git" ]; then
  INSTALL_DIR="$SCRIPT_REPO_ROOT"
  say "installing in-place from $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  say "updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin --quiet
  git -C "$INSTALL_DIR" checkout "$REF" --quiet
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  mkdir -p "$INSTALL_PARENT"
  say "cloning $REPO_URL into $INSTALL_DIR"
  git clone --quiet --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi

# 3. Install deps + build.
say "installing dependencies (this can take a minute on first run)"
( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile=false )
say "building workspace"
( cd "$INSTALL_DIR" && pnpm -r build )

# 4. Symlink bin/pm-go to a PATH directory.
LAUNCHER="$INSTALL_DIR/bin/pm-go"
[ -x "$LAUNCHER" ] || die "launcher missing or not executable: $LAUNCHER"

if [ -n "${PM_GO_BIN_DIR:-}" ]; then
  BIN_DIR="$PM_GO_BIN_DIR"
elif [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
ln -sf "$LAUNCHER" "$BIN_DIR/pm-go"
say "symlinked $BIN_DIR/pm-go -> $LAUNCHER"

# 5. PATH hint, if needed.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "warning: $BIN_DIR is not on PATH"
    say "  add to your shell rc:  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

cat <<EOF

[pm-go install] done.

Try it out from any project:

    cd /path/to/your/repo
    pm-go doctor                                       # diagnose stack
    pm-go run --repo . --spec ./feature.md             # boot + plan + drive

The default --runtime auto picks up Claude Code OAuth (~/.claude/.credentials.json)
or ANTHROPIC_API_KEY, whichever is present. Run 'pm-go doctor' to confirm.
EOF
