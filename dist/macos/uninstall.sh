#!/usr/bin/env bash
# Removes this user's launchd agent and checkout build output; keeps data by default.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
YES=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) echo "Usage: ./uninstall.sh [-y|--yes] [--purge] (purge requires typing delete)"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo "This script requires macOS." >&2; exit 1; }
if [[ "$YES" == 0 ]]; then
  read -r -p "Remove Outpost's login agent and build output? [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]] || exit 0
fi
bash "$ROOT/dist/macos/install.sh" --remove-agent
echo "Stop any separately started Outpost process before deleting its files."
for folder in node_modules server/node_modules web/node_modules server/dist web/dist; do
  rm -rf "$ROOT/$folder"
done
if [[ "$PURGE" == 1 ]]; then
  DATA="${DATA_DIR:-${OUTPOST_DATA_DIR:-${MULTICRAFT_DATA_DIR:-$ROOT/server/data}}}"
  [[ "$DATA" == /* ]] || DATA="$ROOT/server/$DATA"
  DATA="$(cd "$DATA" && pwd -P)"
  case "$DATA" in "$ROOT"/*) ;; *) echo "External data retained for manual cleanup: $DATA" >&2; exit 1 ;; esac
  read -r -p "Permanently delete $DATA (worlds, database, Java runtimes)? Type delete: " reply
  [[ "$reply" != delete ]] || rm -rf "$DATA"
fi
echo "Uninstalled. Checkout, shared Node.js/Java installations and update backups retained."
