#!/usr/bin/env bash
#
# Outpost installer for macOS (Apple Silicon and Intel, macOS 12+).
# Installs prerequisites (Xcode command-line tools, prebuilt Node.js 22.5+ and Minecraft
# Java runtimes), builds the app, verifies it, and can run it in the background at login
# with launchd.
#
# Usage: run from inside a cloned Outpost checkout:
#   ./install-macos.sh            (or: bash install-macos.sh)
#
# Non-interactive (accepts every default: Minecraft Java runtimes yes, launchd agent yes):
#   ./install-macos.sh -y
#
# Other options:
#   ./install-macos.sh --no-java         # skip Minecraft Java runtimes
#   ./install-macos.sh --port=9000       # listen on another port (default 8642)
#   ./install-macos.sh --remove-agent    # stop and remove the background (launchd) service
#
# Written for the bash 3.2 that ships with macOS: no associative arrays, mapfile or ${x,,}.
set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi
info()  { printf '%s==>%s %s\n' "$BLUE" "$NC" "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*"; }
err()   { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; }
die()   { err "$*"; exit 1; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$*" "$NC"; }

NONINTERACTIVE=0
JAVA=1
PORT_ARG=""
REMOVE_AGENT=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) NONINTERACTIVE=1 ;;
    --engine=*) die "Container setup on macOS is planned for a later phase. This installer currently targets Minecraft Java." ;;
    --no-containers) : ;; # Compatibility with earlier installer commands.
    --no-java) JAVA=0 ;;
    --port=*) PORT_ARG="${arg#--port=}" ;;
    --remove-agent) REMOVE_AGENT=1 ;;
    -h|--help)
      echo "Usage: $0 [-y|--yes] [--no-containers] [--no-java] [--port=N] [--remove-agent]"
      echo "  -y, --yes          Non-interactive: install Minecraft Java runtimes and accept launchd defaults."
      echo "  --no-containers    Compatibility option; containers are not installed."
      echo "  --no-java          Skip Minecraft Java runtime installation."
      echo "  --port=N           Port for the panel (default 8642)."
      echo "  --remove-agent     Stop and remove the background launchd service, then exit."
      echo "  Intel and Apple Silicon are detected automatically; no architecture flag is needed."
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

PORT="${PORT_ARG:-${PORT:-8642}}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "Invalid port: $PORT"

# confirm "question" [default: y|n]  — returns 0 for yes, 1 for no
confirm() {
  local prompt="$1" default="${2:-y}" reply suffix
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    [[ "$default" == "y" ]] && { ok "$prompt -> yes (default)"; return 0; }
    ok "$prompt -> no (default)"; return 1
  fi
  suffix="[Y/n]"; [[ "$default" == "n" ]] && suffix="[y/N]"
  read -r -p "$prompt $suffix " reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
heading "Outpost installer for macOS"

[[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS. On Linux use ./install.sh. Detected: $(uname -s)."
[[ $EUID -ne 0 ]] || die "Don't run this with sudo. Run it as your normal user; it asks for your password when it needs it."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]] && grep -qE '"name": *"(outpost|multicraft)"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  PROJECT_DIR="$SCRIPT_DIR"
else
  die "Run this from inside an Outpost checkout (e.g. 'git clone <repo-url> Outpost && cd Outpost && ./install-macos.sh')."
fi

AGENT_LABEL="com.outpost.panel"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
AGENT_TARGET="gui/$(id -u)/$AGENT_LABEL"
LOG_DIR="$HOME/Library/Logs/Outpost"

agent_loaded() { launchctl print "$AGENT_TARGET" >/dev/null 2>&1; }
stop_agent() {
  if agent_loaded; then
    launchctl bootout "$AGENT_TARGET" >/dev/null 2>&1 || launchctl unload "$AGENT_PLIST" >/dev/null 2>&1 || true
    # bootout returns before the process is fully gone; give it a moment to release the port.
    local i=0
    while agent_loaded && (( i < 10 )); do sleep 1; i=$((i + 1)); done
  fi
}

if [[ "$REMOVE_AGENT" == "1" ]]; then
  stop_agent
  rm -f "$AGENT_PLIST"
  ok "Removed the Outpost background service. Your data in $PROJECT_DIR/server/data is untouched."
  exit 0
fi

MACOS_VERSION="$(sw_vers -productVersion)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) LOCAL_TOOLS_PREFIX="/opt/homebrew" ;;
  x86_64) LOCAL_TOOLS_PREFIX="/usr/local" ;;
  *) die "Unsupported Mac architecture: $ARCH. Expected arm64 (Apple Silicon) or x86_64 (Intel)." ;;
esac
ok "macOS $MACOS_VERSION ($ARCH)"
ok "Project directory: $PROJECT_DIR"
case "$PROJECT_DIR" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
    warn "Outpost is in a privacy-protected folder (Desktop/Documents/Downloads). macOS may block the"
    warn "background service from reading it. If it fails to start at login, move the folder (e.g. to ~/Outpost)."
    ;;
esac

cleanup() {
  [[ -z "${INSTALL_TMP:-}" ]] || rm -rf "$INSTALL_TMP"
  [[ -n "${VERIFY_PID:-}" ]] && kill "$VERIFY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1 — Xcode command-line tools (git, clang, python3: node-pty is compiled from source)
# ---------------------------------------------------------------------------
heading "Step 1/6 — Xcode command-line tools"

if xcode-select -p >/dev/null 2>&1; then
  ok "Command-line tools already installed ($(xcode-select -p))"
else
  info "Opening the installer for Apple's command-line tools. Click \"Install\" in the window that appears."
  xcode-select --install >/dev/null 2>&1 || true
  info "Waiting for the command-line tools to finish installing (this can take 5–15 minutes)…"
  waited=0
  until xcode-select -p >/dev/null 2>&1; do
    sleep 10; waited=$((waited + 10))
    (( waited % 60 == 0 )) && info "Still waiting… ($((waited / 60)) min)"
    (( waited >= 3600 )) && die "Timed out. Finish installing the command-line tools, then re-run this script."
  done
  ok "Command-line tools installed"
fi

# ---------------------------------------------------------------------------
# Step 2 - Node.js and Minecraft Java runtimes
# ---------------------------------------------------------------------------
heading "Step 2/6 - Node.js and Minecraft Java runtimes"


node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj > 22 || (maj === 22 && min >= 5) ? 0 : 1);
  ' 2>/dev/null
}

if node_version_ok; then
  ok "Node.js $(node -v) ($(command -v node))"
else
  info "Installing official prebuilt Node.js 22 (no Homebrew compiler builds)..."
  case "$ARCH" in
    x86_64) NODE_ARCH="x64" ;;
    arm64) NODE_ARCH="arm64" ;;
  esac
  INSTALL_TMP="$(mktemp -d)"
  curl -fSL --retry 3 "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "$INSTALL_TMP/SHASUMS256.txt"
  NODE_ARCHIVE="$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v22[.][0-9]+[.][0-9]+-darwin-" arch "[.]tar[.]gz$") { print $2; exit }' "$INSTALL_TMP/SHASUMS256.txt")"
  [[ -n "$NODE_ARCHIVE" ]] || die "No official Node.js 22 download was found for $ARCH."
  # Use the versioned URL so a release during installation cannot change the archive.
  NODE_VERSION="${NODE_ARCHIVE#node-}"
  NODE_VERSION="${NODE_VERSION%-darwin-*}"
  curl -fSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" -o "$INSTALL_TMP/$NODE_ARCHIVE"
  awk -v file="$NODE_ARCHIVE" '$2 == file' "$INSTALL_TMP/SHASUMS256.txt" > "$INSTALL_TMP/node.sha256"
  (cd "$INSTALL_TMP" && shasum -a 256 -c node.sha256) || die "Node.js checksum verification failed."
  NODE_INSTALL_ROOT="$HOME/.local/share/outpost/node"
  mkdir -p "$NODE_INSTALL_ROOT"
  tar -xzf "$INSTALL_TMP/$NODE_ARCHIVE" -C "$NODE_INSTALL_ROOT"
  NODE_RUNTIME="$NODE_INSTALL_ROOT/${NODE_ARCHIVE%.tar.gz}"
  export PATH="$NODE_RUNTIME/bin:$PATH"
  hash -r
  node_version_ok || die "The downloaded Node.js runtime couldn't run on this Mac."
  rm -rf "$INSTALL_TMP"
  INSTALL_TMP=""
  if ! grep -Fqs "$NODE_RUNTIME/bin" "$HOME/.zprofile" 2>/dev/null; then
    if confirm "Add Node.js to ~/.zprofile for new Terminal windows?" y; then
      printf '\nexport PATH=%q/bin:"$PATH"\n' "$NODE_RUNTIME" >> "$HOME/.zprofile"
    fi
  fi
  ok "Node.js $(node -v) ($(command -v node))"
fi
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  *"/.nvm/"*|*"/.volta/"*|*"/.asdf/"*|*"/.fnm/"*)
    warn "Using a version-managed Node.js ($NODE_BIN). The background service is tied to this exact path;"
    warn "if you remove that Node version later, re-run this script."
    ;;
esac

# Download the Java versions Minecraft/modpack servers use into Outpost's runtime directory.
DATA_DIR="${DATA_DIR:-${OUTPOST_DATA_DIR:-${MULTICRAFT_DATA_DIR:-$PROJECT_DIR/server/data}}}"
[[ "$DATA_DIR" == /* ]] || DATA_DIR="$PROJECT_DIR/server/$DATA_DIR"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"
export DATA_DIR
JAVA_HOME_DIR=""
if [[ "$JAVA" == "1" ]]; then
  info "Installing Minecraft Java runtimes (prebuilt Temurin; no Homebrew)..."
  JAVA_HOME_DIR="$("$NODE_BIN" "$PROJECT_DIR/scripts/install-macos-java.mjs" "$DATA_DIR/runtimes" "$ARCH")" \
    || die "Minecraft Java runtime setup failed. See the output above and re-run to resume."
  export JAVA_HOME="$JAVA_HOME_DIR"
fi
info "macOS setup currently targets Minecraft Java. Containers, SteamCMD and Wine are planned for later."

. "$PROJECT_DIR/scripts/macos-service.sh"

# ---------------------------------------------------------------------------
# Step 3 — Install dependencies and build
# ---------------------------------------------------------------------------
heading "Step 3/6 — Installing dependencies and building"

# On a re-run, stop the background service first so it doesn't hold the port during verification.
if agent_loaded; then
  info "Stopping the running Outpost background service for the rebuild…"
  stop_agent
fi

cd "$PROJECT_DIR"
info "npm run setup (installs root, server and web dependencies)…"
npm run setup
info "npm run build (server/dist + web/dist)…"
npm run build

[[ -f "$PROJECT_DIR/server/dist/index.js" ]] || die "Build finished but server/dist/index.js is missing; check the build output above."
[[ -f "$PROJECT_DIR/web/dist/index.html" ]] || die "Build finished but web/dist/index.html is missing; check the build output above."
ok "Build complete"

if [[ -d "$PROJECT_DIR/node_modules/node-pty" || -d "$PROJECT_DIR/server/node_modules/node-pty" ]]; then
  ok "node-pty built (Host Console available)"
else
  warn "node-pty didn't build, so the Host Console will be unavailable. Everything else works."
fi

# ---------------------------------------------------------------------------
# Step 4 — Run once and verify it serves the panel
# ---------------------------------------------------------------------------
heading "Step 4/6 — Verifying"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  err "Something is already listening on port $PORT:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  die "Stop it (or re-run with --port=<other port>) and try again."
fi

VERIFY_LOG="$(mktemp -t outpost-install-check)"
# Run the compiled server directly (what `npm start` does) so $! is the real Node process.
if [[ -n "$JAVA_HOME_DIR" ]]; then export JAVA_HOME="$JAVA_HOME_DIR"; fi
( cd "$PROJECT_DIR/server" && exec env PORT="$PORT" "$NODE_BIN" dist/index.js ) >"$VERIFY_LOG" 2>&1 &
VERIFY_PID=$!

healthy=0
for _ in $(seq 1 30); do
  if panel_healthy >/dev/null 2>&1; then healthy=1; break; fi
  kill -0 "$VERIFY_PID" 2>/dev/null || break
  sleep 1
done

kill "$VERIFY_PID" >/dev/null 2>&1 || true
wait "$VERIFY_PID" 2>/dev/null || true
VERIFY_PID=""

if [[ "$healthy" == "1" ]]; then
  ok "Health check passed (http://localhost:$PORT/api/health)"
  rm -f "$VERIFY_LOG"
else
  err "Outpost didn't respond on port $PORT. Recent log output:"
  tail -n 30 "$VERIFY_LOG" || true
  die "Fix the error above and re-run this script (full log: $VERIFY_LOG)."
fi

# ---------------------------------------------------------------------------
# Step 5 — Run it: background service (launchd) or in this Terminal
# ---------------------------------------------------------------------------
heading "Step 5/6 — Running Outpost"

KEEP_AWAKE=0
RUN_MODE="none"
if confirm "Run Outpost in the background now and start it automatically when you log in (recommended)?" y; then
  RUN_MODE="agent"
  if confirm "Keep this Mac from idle-sleeping while Outpost runs (good for game servers; display can still sleep)?" n; then
    KEEP_AWAKE=1
  fi
elif confirm "Start Outpost in this Terminal window now instead (stops when you close the window or press Ctrl+C)?" y; then
  RUN_MODE="foreground"
fi

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

if [[ "$RUN_MODE" == "agent" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  AGENT_PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:$LOCAL_TOOLS_PREFIX/bin:$LOCAL_TOOLS_PREFIX/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  [[ -d /Applications/Docker.app/Contents/Resources/bin ]] && AGENT_PATH="$AGENT_PATH:/Applications/Docker.app/Contents/Resources/bin"

  PROGRAM_ARGS=""
  if [[ "$KEEP_AWAKE" == "1" ]]; then
    # caffeinate -i blocks idle sleep for as long as the panel process lives.
    PROGRAM_ARGS="    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
"
  fi
  PROGRAM_ARGS="$PROGRAM_ARGS    <string>$(xml_escape "$NODE_BIN")</string>
    <string>dist/index.js</string>"

  JAVA_ENV=""
  [[ -n "$JAVA_HOME_DIR" ]] && JAVA_ENV="    <key>JAVA_HOME</key><string>$(xml_escape "$JAVA_HOME_DIR")</string>"

  info "Writing ${AGENT_PLIST}..."
  cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
$PROGRAM_ARGS
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$PROJECT_DIR/server")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$AGENT_PATH")</string>
    <key>PORT</key><string>$PORT</string>
    <key>DATA_DIR</key><string>$(xml_escape "$DATA_DIR")</string>
    <key>LANG</key><string>en_US.UTF-8</string>
$JAVA_ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/outpost.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/outpost.log")</string>
</dict>
</plist>
EOF
  plutil -lint "$AGENT_PLIST" >/dev/null || die "The generated $AGENT_PLIST is invalid; please report this."

  stop_agent
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null || launchctl load -w "$AGENT_PLIST"
  launchctl enable "$AGENT_TARGET" >/dev/null 2>&1 || true

  info "Waiting for Outpost to come up…"
  if wait_for 45 panel_healthy; then
    ok "Outpost is running in the background"
  else
    err "The background service didn't answer on port $PORT. Last log lines:"
    tail -n 30 "$LOG_DIR/outpost.log" 2>/dev/null || true
    if grep -q 'Operation not permitted' "$LOG_DIR/outpost.log" 2>/dev/null; then
      warn "macOS blocked file access. Move the checkout out of Desktop/Documents/Downloads and re-run."
    fi
    warn "Inspect the login agent: launchctl print $AGENT_TARGET"
    die "The agent was installed but readiness could not be confirmed. Test: curl --noproxy '*' http://127.0.0.1:$PORT/api/health"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6 — Summary
# ---------------------------------------------------------------------------
heading "Step 6/6 — Done"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo "Outpost is installed at: $PROJECT_DIR"
echo "Panel data lives in:     $DATA_DIR"
echo "Open on this Mac:        http://localhost:$PORT"
[[ -n "$LAN_IP" ]] && echo "From other devices:      http://$LAN_IP:$PORT"
echo
echo "The first visit walks you through creating the admin account."
if [[ -n "$LAN_IP" ]]; then
  echo "If macOS asks whether \"node\" may accept incoming connections, click Allow for LAN access."
fi
echo

if [[ "$RUN_MODE" == "agent" ]]; then
  echo "Manage the background service:"
  echo "  Stop:      launchctl bootout $AGENT_TARGET"
  echo "  Start:     launchctl bootstrap gui/\$(id -u) $AGENT_PLIST"
  echo "  Restart:   launchctl kickstart -k $AGENT_TARGET"
  echo "  Logs:      tail -f $LOG_DIR/outpost.log"
  echo "  Remove:    $PROJECT_DIR/install.sh --remove-agent"
  echo
  echo "To update later: run ./update.sh (backs up data, pulls changes, rebuilds and restarts)."

  open "http://localhost:$PORT" >/dev/null 2>&1 || true
elif [[ "$RUN_MODE" == "foreground" ]]; then
  echo "Starting Outpost now. Press Ctrl+C to stop it. Later, start it again with:"
  echo "  cd \"$PROJECT_DIR\" && npm start"
  echo
  ( sleep 4; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
  cd "$PROJECT_DIR/server"
  trap - EXIT
  [[ -z "${INSTALL_TMP:-}" ]] || rm -rf "$INSTALL_TMP"
  exec env PORT="$PORT" "$NODE_BIN" dist/index.js
else
  echo "Start Outpost whenever you want it running:"
  echo "  cd \"$PROJECT_DIR\" && npm start"
  echo "Or re-run ./install-macos.sh to set up the background service."
fi
