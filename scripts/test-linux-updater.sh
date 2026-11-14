#!/usr/bin/env bash
# Preflight-only regression checks. No fetch, pull, build, service or data changes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
TEMP="$(mktemp -d "$TMP_BASE/outpost-updater-test.XXXXXX")"
cleanup() { case "$TEMP" in "$TMP_BASE"/outpost-updater-test.*) rm -rf -- "$TEMP" ;; esac; }
trap cleanup EXIT
REAL_GIT="$(command -v git)"
fixture() {
  mkdir -p "$1/dist/linux"
  cp "$ROOT/dist/linux/update.sh" "$1/dist/linux/update.sh"
  printf '{"name":"outpost"}\n' > "$1/package.json"
}
mkdir -p "$TEMP/bin"
cat > "$TEMP/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo 'Unexpected npm invocation' >&2
exit 99
EOF
chmod +x "$TEMP/bin/npm"
export PATH="$TEMP/bin:$PATH"
fixture "$TEMP/repo"
"$REAL_GIT" -C "$TEMP/repo" init -q
preflight() {
  local directory="$1" expected="$2" ownership="${3:-0}" output
  if output="$(GIT_TEST_ASSUME_DIFFERENT_OWNER="$ownership" bash "$directory/dist/linux/update.sh" --no-backup 2>&1)"; then
    echo 'Preflight unexpectedly continued into the updater' >&2; exit 1
  fi
  [[ "$output" == *"$expected"* ]] || { printf 'Expected %s; got:\n%s\n' "$expected" "$output" >&2; exit 1; }
  [[ "$output" != *'Unexpected npm invocation'* ]]
  if [[ "$ownership" == 1 ]]; then [[ "$output" == *'for this updater run only'* ]]; fi
}
preflight "$TEMP/repo" 'No git remote configured'
preflight "$TEMP/repo" 'No git remote configured' 1
# A source archive inside a different checkout must not update that parent.
fixture "$TEMP/repo/archive"
preflight "$TEMP/repo/archive" 'Git metadata is missing'
fixture "$TEMP/broken"
printf 'broken git metadata\n' > "$TEMP/broken/.git"
preflight "$TEMP/broken" 'Git cannot read this checkout'
# Linked worktrees have .git files, and must remain supported.
"$REAL_GIT" -C "$TEMP/repo" add package.json dist/linux/update.sh
"$REAL_GIT" -C "$TEMP/repo" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
"$REAL_GIT" -C "$TEMP/repo" worktree add -qb fixture-worktree "$TEMP/worktree"
preflight "$TEMP/worktree" 'No git remote configured'
preflight "$TEMP/worktree" 'No git remote configured' 1
bash -n "$ROOT/dist/linux/update.sh"
echo 'Linux updater preflight: checkout, sudo ownership, archive, corrupt metadata and linked worktree checks passed.'
