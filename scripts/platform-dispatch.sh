#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="$1"; shift
case "$ACTION" in install|update|uninstall) ;; *) echo "Unknown action: $ACTION" >&2; exit 1 ;; esac
case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  MINGW*|MSYS*|CYGWIN*)
    SCRIPT="$ROOT/dist/windows/$ACTION.ps1"
    command -v cygpath >/dev/null 2>&1 && SCRIPT="$(cygpath -w "$SCRIPT")"
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" "$@"
    ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
exec bash "$ROOT/dist/$PLATFORM/$ACTION.sh" "$@"
