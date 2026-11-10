#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/macos-service.sh"
sleep() { :; }
attempts=0
delayed() { attempts=$((attempts + 1)); [[ "$attempts" == 3 ]]; }
wait_for 12 delayed || { echo 'Successful retry incorrectly reported failure.' >&2; exit 1; }
[[ "$attempts" == 3 ]]
wait_for 3 true
if wait_for 6 false; then echo 'Timeout incorrectly reported success.' >&2; exit 1; fi
PORT=9001
curl() {
  [[ "$*" == *'--noproxy *'* && "$*" == *'--max-time 3'* && "$*" == *'http://127.0.0.1:9001/api/health'* ]]
}
panel_healthy
echo 'macOS immediate/delayed readiness, timeout and direct loopback checks passed.'
