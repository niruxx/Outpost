#!/usr/bin/env bash
#
# Outpost installer for macOS (Apple Silicon and Intel, macOS 12+).
# Installs prerequisites (Xcode command-line tools, Homebrew, Node.js 22.5+, optionally Java 21
# and a container engine), builds the app, verifies it, and can run it in the background at login
# with launchd.
#
# Usage: run from inside a cloned Outpost checkout:
#   ./install-macos.sh            (or: bash install-macos.sh)
#
# Non-interactive (accepts every default: Java yes, Docker Desktop yes, launchd agent yes):
#   ./install-macos.sh -y
#
# Other options:
#   ./install-macos.sh --engine=podman   # Podman instead of Docker Desktop
#   ./install-macos.sh --no-containers   # skip the container engine
#   ./install-macos.sh --no-java         # skip Java (only needed for Minecraft Java servers)
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
ENGINE=""          # docker | podman | "" (ask; default docker)
CONTAINERS=1
JAVA=1
PORT_ARG=""
REMOVE_AGENT=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) NONINTERACTIVE=1 ;;
    --engine=docker|--engine=podman) ENGINE="${arg#--engine=}" ;;
    --no-containers) CONTAINERS=0 ;;
    --no-java) JAVA=0 ;;
    --port=*) PORT_ARG="${arg#--port=}" ;;
    --remove-agent) REMOVE_AGENT=1 ;;
    -h|--help)
      echo "Usage: $0 [-y|--yes] [--engine=docker|podman] [--no-containers] [--no-java] [--port=N] [--remove-agent]"
      echo "  -y, --yes          Non-interactive: accept every default (Java, Docker Desktop, launchd agent)."
      echo "  --engine=ENGINE    Container engine: docker (Docker Desktop, default) or podman."
      echo "  --no-containers    Don't install a container engine."
      echo "  --no-java          Don't install Java 21 (only Minecraft Java servers need it)."
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  arm64) BREW_DEFAULT_PREFIX="/opt/homebrew" ;;
  x86_64) BREW_DEFAULT_PREFIX="/usr/local" ;;
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

# Cache the sudo password once up front (Homebrew, Docker Desktop and the Java link all need it).
info "Some steps need administrator rights. Enter your Mac password if asked."
sudo -v || die "Couldn't get administrator rights. Your user must be an admin on this Mac."
# Keep the sudo timestamp fresh until the script exits.
( while true; do sudo -n true 2>/dev/null; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) &
SUDO_KEEPALIVE_PID=$!
cleanup() {
  kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true
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
# Step 2 — Homebrew, Node.js, Java, container engine
# ---------------------------------------------------------------------------
heading "Step 2/6 — Homebrew and prerequisites"

find_brew() {
  # Use this architecture's prefix: /usr/local on Intel, /opt/homebrew on Apple Silicon.
  if [[ -x "$BREW_DEFAULT_PREFIX/bin/brew" ]]; then echo "$BREW_DEFAULT_PREFIX/bin/brew"
  elif command -v brew >/dev/null 2>&1; then command -v brew
  else return 1; fi
}

if BREW="$(find_brew)"; then
  ok "Homebrew found ($BREW)"
else
  info "Installing Homebrew…"
  BREW_INSTALL_REF="HEAD"
  if [[ "$ARCH" == "x86_64" ]]; then
    # Parent of Homebrew/install e078684, which removed Intel installation support.
    # Pin only the bootstrap script; brew and its packages still receive updates.
    BREW_INSTALL_REF="7a133dcc74051ee4efc79467ed215dfedf45aea2"
    warn "Homebrew's latest installer no longer supports Intel Macs. Using its last Intel-compatible installer."
    warn "Intel Homebrew is Tier 3: some packages may build from source or be unavailable."
  fi
  BREW_INSTALL_URL="https://raw.githubusercontent.com/Homebrew/install/$BREW_INSTALL_REF/install.sh"
  BREW_INSTALL_SCRIPT="$(curl -fsSL "$BREW_INSTALL_URL")" \
    || die "Couldn't download the Homebrew installer. Check your connection and re-run this script."
  [[ -n "$BREW_INSTALL_SCRIPT" ]] || die "The downloaded Homebrew installer is empty. Re-run this script."
  NONINTERACTIVE=1 /bin/bash -c "$BREW_INSTALL_SCRIPT" \
    || die "Homebrew installation failed. Check the output above, then re-run this script."
  BREW="$(find_brew)" || die "Homebrew installation didn't finish. See https://brew.sh and re-run this script."
  ok "Homebrew installed ($BREW)"
fi
eval "$("$BREW" shellenv)"
BREW_PREFIX="$("$BREW" --prefix)"

# Make brew available in new Terminal windows too.
ZPROFILE="$HOME/.zprofile"
if ! grep -qs "brew shellenv" "$ZPROFILE" "$HOME/.zshrc" "$HOME/.bash_profile" 2>/dev/null; then
  if confirm "Add Homebrew to your shell profile ($ZPROFILE) so 'brew', 'node' and 'npm' work in new Terminal windows?" y; then
    printf '\neval "$(%s shellenv)"\n' "$BREW" >> "$ZPROFILE"
    ok "Updated $ZPROFILE"
  fi
fi

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
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v) at $(command -v node) is too old (need 22.5+). Installing a current one with Homebrew."
  fi
  if "$BREW" list --formula node >/dev/null 2>&1; then
    info "Upgrading Homebrew's Node.js…"
    "$BREW" upgrade node || true
  else
    info "Installing Node.js with Homebrew…"
    "$BREW" install node
  fi
  export PATH="$BREW_PREFIX/bin:$PATH"
  hash -r
  node_version_ok || die "Node.js 22.5+ still isn't first on your PATH ($(command -v node || echo 'not found')). Remove the older Node.js (nvm/installer) or put $BREW_PREFIX/bin first, then re-run."
  ok "Node.js $(node -v) ($(command -v node))"
fi
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  *"/.nvm/"*|*"/.volta/"*|*"/.asdf/"*|*"/.fnm/"*)
    warn "Using a version-managed Node.js ($NODE_BIN). The background service is tied to this exact path;"
    warn "if you remove that Node version later, re-run this script."
    ;;
esac

# Java: Outpost discovers JDKs in /Library/Java/JavaVirtualMachines, so link Homebrew's JDK there.
JAVA_HOME_DIR=""
if [[ "$JAVA" == "1" ]]; then
  if JAVA_HOME_DIR="$(/usr/libexec/java_home -v 21+ 2>/dev/null)"; then
    ok "Java 21+ found ($JAVA_HOME_DIR)"
  elif confirm "Install Java 21 (needed for Minecraft Java servers: Vanilla, Paper, Purpur, Spigot)?" y; then
    info "Installing OpenJDK 21 with Homebrew…"
    "$BREW" install openjdk@21
    JDK_SRC="$BREW_PREFIX/opt/openjdk@21/libexec/openjdk.jdk"
    [[ -d "$JDK_SRC" ]] || die "Homebrew's JDK wasn't found at $JDK_SRC."
    info "Linking it into /Library/Java/JavaVirtualMachines so macOS and Outpost can find it…"
    sudo mkdir -p /Library/Java/JavaVirtualMachines
    sudo ln -sfn "$JDK_SRC" /Library/Java/JavaVirtualMachines/openjdk-21.jdk
    JAVA_HOME_DIR="$(/usr/libexec/java_home -v 21+ 2>/dev/null)" || die "Java 21 was installed but macOS can't find it."
    ok "Java 21 ready ($JAVA_HOME_DIR)"
  else
    info "Skipping Java. Minecraft Java servers won't start until you install Java 21+."
  fi
fi

# Container engine (Docker / Portainer / app-catalog instances)
PORTAINER_IMAGE="docker.io/portainer/portainer-ce:lts"

wait_for() {  # wait_for <seconds> <command...>
  local limit="$1"; shift
  local i=0
  until "$@" >/dev/null 2>&1; do
    sleep 3; i=$((i + 3))
    (( i >= limit )) && return 1
  done
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "A Docker engine is already running ($(docker context show 2>/dev/null || echo default))"
    return 0
  fi
  if [[ ! -d "/Applications/Docker.app" ]] && ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker Desktop with Homebrew…"
    "$BREW" install --cask docker-desktop || "$BREW" install --cask docker || return 1
  fi
  if [[ -d "/Applications/Docker.app" ]]; then
    info "Starting Docker Desktop. Accept its license and finish its setup window if one appears."
    open -a Docker || true
    info "Waiting for the Docker engine (up to 3 minutes)…"
    if wait_for 180 docker info; then
      ok "Docker is running"
      return 0
    fi
    warn "Docker Desktop isn't ready yet. Finish its first-run setup; Outpost picks it up once it's running."
    return 1
  fi
  warn "A docker command exists but no engine is running. Start Docker Desktop, OrbStack or Colima."
  return 1
}

install_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    info "Installing Podman with Homebrew…"
    "$BREW" install podman || return 1
  fi
  if ! podman machine inspect >/dev/null 2>&1; then
    info "Creating the Podman virtual machine…"
    podman machine init || return 1
  fi
  if ! podman info >/dev/null 2>&1; then
    info "Starting the Podman virtual machine…"
    podman machine start || return 1
  fi
  ok "Podman is running"
  warn "On macOS, Podman runs in a VM. One-click Portainer may not see the engine; Docker Desktop is the smoother option."
}

if [[ "$CONTAINERS" == "1" ]] && confirm "Set up a container engine for Docker, Portainer and app-catalog instances?" y; then
  if [[ -z "$ENGINE" ]]; then
    if command -v podman >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
      ENGINE=podman
    elif [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
      ENGINE=docker
    else
      read -r -p "Which engine: docker (Docker Desktop) or podman? [docker] " ENGINE || ENGINE=""
      ENGINE="${ENGINE:-docker}"
    fi
  fi
  case "$ENGINE" in
    docker) install_docker || warn "Docker setup didn't finish; see above." ;;
    podman) install_podman || warn "Podman setup didn't finish; see above." ;;
    *) warn "Unknown engine '$ENGINE'; skipping container setup."; ENGINE="" ;;
  esac
  if [[ -n "$ENGINE" ]] && "$ENGINE" info >/dev/null 2>&1 \
     && confirm "Pre-download the Portainer image so one-click Portainer instances start immediately?" y; then
    "$ENGINE" pull "$PORTAINER_IMAGE" && ok "Portainer image ready" \
      || warn "Couldn't pull $PORTAINER_IMAGE; it'll be pulled when you create a Portainer instance."
  fi
else
  ENGINE=""
  info "Skipping container support. Re-run with --engine=docker or --engine=podman to add it later."
fi

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
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then healthy=1; break; fi
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
  AGENT_PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

  info "Writing $AGENT_PLIST…"
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
  if wait_for 45 curl -fsS "http://localhost:$PORT/api/health"; then
    ok "Outpost is running in the background"
  else
    err "The background service didn't answer on port $PORT. Last log lines:"
    tail -n 30 "$LOG_DIR/outpost.log" 2>/dev/null || true
    warn "If the log mentions 'Operation not permitted', move the Outpost folder out of Desktop/Documents/Downloads and re-run."
  fi
fi

# ---------------------------------------------------------------------------
# Step 6 — Summary
# ---------------------------------------------------------------------------
heading "Step 6/6 — Done"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo "Outpost is installed at: $PROJECT_DIR"
echo "Panel data lives in:     $PROJECT_DIR/server/data"
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
  echo "  Remove:    $PROJECT_DIR/install-macos.sh --remove-agent"
  echo
  echo "To update later: git pull, then re-run ./install-macos.sh (it rebuilds and restarts the service)."
  if [[ "$ENGINE" == "docker" ]]; then
    echo "Tip: enable Docker Desktop → Settings → General → \"Start Docker Desktop when you sign in\"."
  fi
  open "http://localhost:$PORT" >/dev/null 2>&1 || true
elif [[ "$RUN_MODE" == "foreground" ]]; then
  echo "Starting Outpost now. Press Ctrl+C to stop it. Later, start it again with:"
  echo "  cd \"$PROJECT_DIR\" && npm start"
  echo
  ( sleep 4; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
  cd "$PROJECT_DIR/server"
  trap - EXIT
  kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true
  exec env PORT="$PORT" "$NODE_BIN" dist/index.js
else
  echo "Start Outpost whenever you want it running:"
  echo "  cd \"$PROJECT_DIR\" && npm start"
  echo "Or re-run ./install-macos.sh to set up the background service."
fi
