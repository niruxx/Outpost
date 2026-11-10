#!/usr/bin/env bash
# Shared with read-only regression checks; compatible with macOS Bash 3.2.
wait_for() {
  local limit="$1"; shift
  local i=0
  until "$@" >/dev/null 2>&1; do
    sleep 3; i=$((i + 3))
    (( i >= limit )) && return 1
  done
  # Without this, a successful retry inherits the failed arithmetic check above.
  return 0
}

panel_healthy() {
  curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$PORT/api/health"
}
