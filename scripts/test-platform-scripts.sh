#!/usr/bin/env bash
# Read-only smoke checks: help, platform dispatch, argument forwarding and shell syntax.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
for file in "$ROOT"/*.sh "$ROOT"/dist/linux/*.sh "$ROOT"/dist/macos/*.sh "$ROOT"/scripts/*dispatch.sh; do
  bash -n "$file"
done
for platform in Linux Darwin; do
  uname() { printf '%s\n' "$TEST_PLATFORM"; }
  export -f uname
  export TEST_PLATFORM="$platform"
  for action in install update uninstall; do
    output="$(bash "$ROOT/$action.sh" --help)"
    [[ "$output" == *Usage:* ]] || { echo "Missing help: $platform/$action" >&2; exit 1; }
  done
done
unset -f uname
# Intercept the final executable to check dispatch without launching an installer.
cat > "$TEMP/bash" <<'EOF'
#!/bin/sh
printf '<%s>\n' "$@"
EOF
cp "$TEMP/bash" "$TEMP/powershell.exe"
chmod +x "$TEMP/bash" "$TEMP/powershell.exe"
REAL_BASH="$BASH"
for platform in Linux Darwin MINGW64_NT-10.0; do
  uname() { printf '%s\n' "$TEST_PLATFORM"; }
  export -f uname
  export TEST_PLATFORM="$platform"
  output="$(PATH="$TEMP:$PATH" "$REAL_BASH" "$ROOT/scripts/platform-dispatch.sh" install '--port=9001' 'argument with spaces')"
  case "$platform" in
    Linux) [[ "$output" == *dist/linux/install.sh* ]] ;;
    Darwin) [[ "$output" == *dist/macos/install.sh* ]] ;;
    MINGW*) [[ "$output" == *windows*install.ps1* ]] ;;
  esac
  [[ "$output" == *'<--port=9001>'* && "$output" == *'<argument with spaces>'* ]]
done
export TEST_PLATFORM=UnsupportedOS
if "$REAL_BASH" "$ROOT/scripts/platform-dispatch.sh" install --help > "$TEMP/unsupported.log" 2>&1; then
  echo 'Unsupported OS unexpectedly accepted.' >&2
  exit 1
fi
unset -f uname
echo 'Platform dispatch, argument forwarding, help and Bash syntax checks passed.'
