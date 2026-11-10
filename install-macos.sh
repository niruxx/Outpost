#!/usr/bin/env bash
# Compatibility entry point; prefer ./install.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/dist/macos/install.sh" "$@"
