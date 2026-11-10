#!/usr/bin/env bash
# Back up data, fast-forward the checkout, then rebuild using the macOS installer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
YES=0
BACKUP=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) echo "Usage: ./update.sh [-y|--yes] [--no-backup]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "This script requires macOS." >&2; exit 1; }
cd "$ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo "Commit or stash local changes before updating." >&2; exit 1; }
if [[ "$YES" == 0 ]]; then
  read -r -p "Back up and update this Outpost checkout? [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]] || exit 0
fi
TARGET="gui/$(id -u)/com.outpost.panel"
PLIST="$HOME/Library/LaunchAgents/com.outpost.panel.plist"
WAS_RUNNING=0
if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
  WAS_RUNNING=1
  sleep 3
else
  echo "Stop any foreground Outpost process before continuing."
fi
restore_agent() {
  [[ "$WAS_RUNNING" == 0 ]] || launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
}
trap restore_agent EXIT
DATA="${DATA_DIR:-${OUTPOST_DATA_DIR:-${MULTICRAFT_DATA_DIR:-$ROOT/server/data}}}"
[[ "$DATA" == /* ]] || DATA="$ROOT/server/$DATA"
BACKUPS="$(dirname "$ROOT")/outpost-update-backups"
mkdir -p "$BACKUPS"
STAMP="$(date +%Y%m%d-%H%M%S)"
git rev-parse HEAD > "$BACKUPS/previous-commit-$STAMP.txt"
if [[ "$BACKUP" == 1 && -d "$DATA" ]]; then
  tar -czf "$BACKUPS/data-$STAMP.tar.gz" -C "$(dirname "$DATA")" "$(basename "$DATA")"
fi
git pull --ff-only
# Preserve the installed Java set; new runtimes can be added by running install.sh again.
ARGS=(--no-java)
[[ "$YES" == 0 ]] || ARGS+=(-y)
bash "$ROOT/dist/macos/install.sh" "${ARGS[@]}"
WAS_RUNNING=0
echo "Update complete. Rollback commit and any data backup are in $BACKUPS."
