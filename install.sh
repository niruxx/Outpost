#!/usr/bin/env bash
#
# Outpost installer for Linux (Debian/Ubuntu, Arch/Manjaro, Fedora/RHEL — openSUSE too,
# best-effort). Installs prerequisites (Node.js 22.5+, git, optionally Java), builds the app,
# and optionally sets it up as a systemd service that starts on boot.
#
# Usage: run from inside a cloned Outpost checkout:
#   ./install.sh
#
# Non-interactive (accepts every default — Java yes, sandbox + Docker yes, systemd no):
#   ./install.sh -y
#
# Container engine for Docker/Portainer/app instances (default: Docker):
#   ./install.sh --engine=podman      # rootless Podman instead (no root daemon)
#   ./install.sh --no-containers      # skip container support entirely
#
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
ENGINE=""        # docker | podman | "" (ask; default docker)
CONTAINERS=1
WINE=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) NONINTERACTIVE=1 ;;
    --engine=docker|--engine=podman) ENGINE="${arg#--engine=}" ;;
    --no-containers) CONTAINERS=0 ;;
    --wine) WINE=1 ;;
    -h|--help)
      echo "Usage: $0 [-y|--yes] [--engine=docker|podman] [--no-containers] [--wine]"
      echo "  -y, --yes            Non-interactive: accept every default (Java, sandbox, Docker; skips systemd)."
      echo "  --engine=ENGINE      Container engine for Docker/Portainer/app instances: docker (default) or podman."
      echo "  --no-containers      Don't install a container engine."
      echo "  --wine               Install Wine (for Windows-only game servers like Black Ops III) without asking."
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

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
heading "Outpost installer"

[[ "$(uname -s)" == "Linux" ]] || die "This script is for Linux (Debian/Ubuntu, Arch/Manjaro, Fedora/RHEL). Detected: $(uname -s)."

if [[ $EUID -eq 0 ]]; then
  SUDO=""
  warn "Running as root. Package installation is fine, but consider running Outpost itself as a"
  warn "normal user — the systemd service below will run as whichever user runs this script."
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages (or re-run this script as root)."
  SUDO="sudo"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]] && grep -qE '"name": *"(outpost|multicraft)"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  PROJECT_DIR="$SCRIPT_DIR"
else
  die "Run this from inside an Outpost checkout (e.g. 'git clone <repo-url> Outpost && cd Outpost && ./install.sh')."
fi
ok "Project directory: $PROJECT_DIR"

# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------
DISTRO_FAMILY="unknown"
DISTRO_NAME="Linux"
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_NAME="${PRETTY_NAME:-$ID}"
  case " ${ID:-} ${ID_LIKE:-} " in
    *debian*|*ubuntu*) DISTRO_FAMILY="debian" ;;
    *arch*|*manjaro*)  DISTRO_FAMILY="arch" ;;
    *fedora*|*rhel*|*centos*) DISTRO_FAMILY="fedora" ;;
    *suse*|*opensuse*) DISTRO_FAMILY="opensuse" ;;
  esac
fi
[[ "$DISTRO_FAMILY" == "unknown" ]] && warn "Couldn't auto-detect a supported distro (found: $DISTRO_NAME). I'll try, but you may need to install Node.js 22.5+, git, and Java yourself."
ok "Detected: $DISTRO_NAME ($DISTRO_FAMILY)"

if [[ "$DISTRO_FAMILY" == "debian" ]]; then
  info "Refreshing apt package lists…"
  $SUDO apt-get update -y
fi

# ---------------------------------------------------------------------------
# Prerequisite checks/installs
# ---------------------------------------------------------------------------
node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj > 22 || (maj === 22 && min >= 5) ? 0 : 1);
  ' 2>/dev/null
}

install_node() {
  case "$DISTRO_FAMILY" in
    debian)
      info "Installing Node.js 22.x via NodeSource…"
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
      $SUDO apt-get install -y nodejs
      ;;
    arch)
      info "Installing Node.js via pacman…"
      $SUDO pacman -Sy --needed --noconfirm nodejs npm
      ;;
    fedora)
      info "Installing Node.js via dnf…"
      $SUDO dnf install -y nodejs npm
      if ! node_version_ok; then
        warn "dnf's nodejs is older than 22.5 — falling back to NodeSource…"
        curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
        $SUDO dnf install -y nodejs
      fi
      ;;
    opensuse)
      info "Installing Node.js via zypper…"
      $SUDO zypper --non-interactive install nodejs22 npm22
      ;;
    *)
      die "Don't know how to install Node.js on this distro. Install Node.js 22.5+ yourself (see nodejs.org or nvm) and re-run."
      ;;
  esac
}

install_git() {
  case "$DISTRO_FAMILY" in
    debian)   $SUDO apt-get install -y git ;;
    arch)     $SUDO pacman -Sy --needed --noconfirm git ;;
    fedora)   $SUDO dnf install -y git ;;
    opensuse) $SUDO zypper --non-interactive install git ;;
    *) die "Don't know how to install git on this distro. Install it yourself and re-run." ;;
  esac
}

install_java() {
  case "$DISTRO_FAMILY" in
    debian)   $SUDO apt-get install -y openjdk-21-jdk ;;
    arch)     $SUDO pacman -Sy --needed --noconfirm jre25-openjdk-headless && archlinux-java set java-25-openjdk ;;
    fedora)   $SUDO dnf install -y java-21-openjdk-devel ;;
    opensuse) $SUDO zypper --non-interactive install java-21-openjdk-devel ;;
    *) die "Don't know how to install Java on this distro. Install a JDK 21+ yourself and re-run." ;;
  esac
}

# steamcmd is a 32-bit binary and needs matching 32-bit runtime libraries, which aren't installed
# on a typical 64-bit-only server by default. Best-effort per distro; non-fatal if it fails since
# it's only needed for Steam-platform (Palworld/Zomboid/Valheim/Terraria/etc) servers.
install_steamcmd_deps() {
  case "$DISTRO_FAMILY" in
    debian)
      $SUDO dpkg --add-architecture i386
      $SUDO apt-get update -y
      $SUDO apt-get install -y lib32gcc-s1 lib32stdc++6
      ;;
    fedora)
      $SUDO dnf install -y glibc.i686 libstdc++.i686
      ;;
    opensuse)
      $SUDO zypper --non-interactive install libstdc++6-32bit glibc-32bit
      ;;
    arch)
      if ! grep -q '^\[multilib\]' /etc/pacman.conf; then
        warn "steamcmd needs the [multilib] repo enabled in /etc/pacman.conf, which this installer won't edit automatically."
        warn "Uncomment [multilib] and its Include line in /etc/pacman.conf, run 'sudo pacman -Sy', then install lib32-gcc-libs yourself."
        return 1
      fi
      $SUDO pacman -Sy --needed --noconfirm lib32-gcc-libs
      ;;
    *)
      warn "Don't know how to install steamcmd's 32-bit runtime deps on this distro — install them manually if you plan to use Steam-platform servers."
      return 1
      ;;
  esac
}

# Wine runs Windows-only dedicated servers (Black Ops III and others) on Linux. Xvfb gives the few
# that open a window a virtual screen. Both 64- and 32-bit Wine are installed where the distro splits
# them, since some servers still ship 32-bit helpers.
install_wine() {
  case "$DISTRO_FAMILY" in
    debian)
      $SUDO dpkg --add-architecture i386
      $SUDO apt-get update -y
      $SUDO apt-get install -y wine wine64 xvfb xauth cabextract || return 1
      # 32-bit Wine is a separate package on Debian/Ubuntu; nice to have, not required.
      $SUDO apt-get install -y wine32:i386 || warn "32-bit Wine (wine32:i386) didn't install — only 64-bit Windows servers will run."
      ;;
    fedora)
      $SUDO dnf install -y wine xorg-x11-server-Xvfb xauth cabextract || {
        warn "On RHEL/Rocky/Alma, Wine comes from EPEL: sudo dnf install -y epel-release, then re-run."
        return 1
      }
      ;;
    opensuse)
      $SUDO zypper --non-interactive install wine xvfb-run cabextract
      ;;
    arch)
      if ! grep -q '^\[multilib\]' /etc/pacman.conf; then
        warn "Wine needs the [multilib] repo enabled in /etc/pacman.conf, which this installer won't edit automatically."
        warn "Uncomment [multilib] and its Include line, run 'sudo pacman -Sy', then: sudo pacman -S wine xorg-server-xvfb"
        return 1
      fi
      $SUDO pacman -Sy --needed --noconfirm wine xorg-server-xvfb xorg-xauth cabextract
      ;;
    *)
      warn "Don't know how to install Wine on this distro — install wine (and xvfb) yourself to run Windows-only servers."
      return 1
      ;;
  esac
  # winetricks installs runtimes (VC++, .NET, DirectX…) from each instance's Wine tab. It lives in
  # Debian's contrib / Ubuntu's universe, so it may be missing — Outpost downloads it itself then.
  case "$DISTRO_FAMILY" in
    debian)   $SUDO apt-get install -y winetricks unzip p7zip-full ;;
    fedora)   $SUDO dnf install -y winetricks unzip p7zip ;;
    opensuse) $SUDO zypper --non-interactive install winetricks unzip p7zip ;;
    arch)     $SUDO pacman -S --needed --noconfirm winetricks unzip p7zip ;;
  esac || warn "winetricks didn't install from the package manager — Outpost will download it the first time an instance needs it."
  return 0
}

# ---------------------------------------------------------------------------
# Sandbox + container engine (Docker / Podman) for app, container and Portainer instances
# ---------------------------------------------------------------------------
RUN_USER="$(id -un)"

install_pkgs() {
  case "$DISTRO_FAMILY" in
    debian)   $SUDO apt-get install -y "$@" ;;
    arch)     $SUDO pacman -Sy --needed --noconfirm "$@" ;;
    fedora)   $SUDO dnf install -y "$@" ;;
    opensuse) $SUDO zypper --non-interactive install "$@" ;;
    *) return 1 ;;
  esac
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    ok "Docker already installed ($(docker --version 2>/dev/null | head -1))"
  else
    info "Installing Docker…"
    case "$DISTRO_FAMILY" in
      debian)   install_pkgs docker.io ;;
      arch)     install_pkgs docker ;;
      # Fedora packages Docker as moby-engine (RHEL clones don't ship it — use --engine=podman there).
      fedora)   install_pkgs moby-engine || { err "moby-engine isn't available here (RHEL/Alma/Rocky?). Re-run with --engine=podman."; return 1; } ;;
      opensuse) install_pkgs docker ;;
      *) err "Don't know how to install Docker on this distro."; return 1 ;;
    esac
  fi
  info "Enabling and starting docker.service + docker.socket…"
  $SUDO systemctl enable --now docker.socket docker.service
  if [[ "$RUN_USER" != "root" ]]; then
    if id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
      ok "$RUN_USER is already in the docker group"
    else
      warn "Adding $RUN_USER to the docker group so Outpost can reach the Docker daemon."
      warn "Membership of the docker group is root-equivalent on this machine — rootless Podman (--engine=podman) avoids that."
      $SUDO usermod -aG docker "$RUN_USER"
      DOCKER_GROUP_ADDED=1
    fi
  fi
  ok "Docker is ready"
}

install_podman() {
  if command -v podman >/dev/null 2>&1; then
    ok "Podman already installed ($(podman --version 2>/dev/null | head -1))"
  else
    info "Installing Podman…"
    case "$DISTRO_FAMILY" in
      debian)   install_pkgs podman uidmap slirp4netns ;;
      *)        install_pkgs podman || { err "Couldn't install Podman on this distro."; return 1; } ;;
    esac
  fi
  if [[ "$RUN_USER" == "root" ]]; then
    info "Running as root — enabling the system-wide podman.socket…"
    $SUDO systemctl enable --now podman.socket
  else
    # Rootless Podman needs subordinate uid/gid ranges for the user (Arch doesn't add them by default).
    if ! grep -q "^$RUN_USER:" /etc/subuid 2>/dev/null || ! grep -q "^$RUN_USER:" /etc/subgid 2>/dev/null; then
      info "Adding subordinate uid/gid ranges for $RUN_USER (needed by rootless Podman)…"
      $SUDO usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$RUN_USER"
      podman system migrate >/dev/null 2>&1 || true
    fi
    info "Enabling $RUN_USER's podman.socket (the Docker-compatible API Portainer talks to)…"
    systemctl --user enable --now podman.socket || warn "Couldn't enable podman.socket for $RUN_USER — run 'systemctl --user enable --now podman.socket' from a login session."
    # Lingering keeps the user's services (podman.socket, and the containers) running without an open login session.
    $SUDO loginctl enable-linger "$RUN_USER" && ok "Enabled lingering for $RUN_USER (user services run without a login session)"
  fi
  ok "Podman is ready"
}

install_sandbox() {
  if command -v bwrap >/dev/null 2>&1; then
    ok "bubblewrap already installed ($(bwrap --version 2>/dev/null))"
  else
    info "Installing bubblewrap (keeps each instance inside its own folder)…"
    install_pkgs bubblewrap && ok "bubblewrap installed" || warn "Couldn't install bubblewrap — instances will run without the process sandbox."
  fi
}

PORTAINER_IMAGE="docker.io/portainer/portainer-ce:lts"
DOCKER_GROUP_ADDED=0

heading "Step 1/6 — Prerequisites"

if ! command -v curl >/dev/null 2>&1; then
  info "curl not found (needed for the Node.js installer and health checks), installing…"
  case "$DISTRO_FAMILY" in
    debian)   $SUDO apt-get install -y curl ;;
    arch)     $SUDO pacman -Sy --needed --noconfirm curl ;;
    fedora)   $SUDO dnf install -y curl ;;
    opensuse) $SUDO zypper --non-interactive install curl ;;
    *) die "curl is required. Install it yourself and re-run." ;;
  esac
  ok "curl installed"
fi

if node_version_ok; then
  ok "Node.js $(node -v) already installed"
else
  if command -v node >/dev/null 2>&1; then
    warn "Found Node.js $(node -v), but Outpost needs 22.5+ (for built-in node:sqlite)."
  else
    info "Node.js not found."
  fi
  install_node
  node_version_ok || die "Node.js is still older than 22.5 after installing. Install it manually (nodejs.org or nvm) and re-run."
  ok "Node.js $(node -v) installed"
fi

if command -v git >/dev/null 2>&1; then
  ok "git already installed"
else
  info "git not found, installing…"
  install_git
  ok "git installed"
fi

if command -v java >/dev/null 2>&1; then
  ok "Java already installed ($(java -version 2>&1 | head -1))"
else
  if confirm "Install Java 21 (needed to run Vanilla/Paper/Purpur/Spigot servers — skip if you only plan to run Bedrock)?" y; then
    install_java
    ok "Java installed"
  else
    warn "Skipping Java. You can install it later — see the README's per-distro commands."
  fi
fi

if confirm "Install 32-bit runtime libraries needed by steamcmd (for Palworld/Zomboid/Valheim/Terraria/other Steam-based servers — skip if you won't use those)?" n; then
  if install_steamcmd_deps; then
    ok "steamcmd dependencies installed"
  else
    warn "steamcmd dependency install failed or needs manual steps — see messages above. You can retry later, or install them yourself before creating a Steam-platform server (see the README)."
  fi
else
  info "Skipping steamcmd dependencies. Install them later if you want to run Steam-based game servers — see the README."
fi

if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then
  ok "Wine already installed ($( (wine64 --version 2>/dev/null || wine --version) | head -1))"
elif [[ "${WINE:-0}" == "1" ]] || confirm "Install Wine, to run Windows-only game servers (Call of Duty: Black Ops III and others) on Linux?" n; then
  if install_wine; then
    ok "Wine installed ($( (wine64 --version 2>/dev/null || wine --version) | head -1))"
  else
    warn "Wine didn't install completely — see the messages above. Windows-only servers will tell you what's missing when you start them."
  fi
else
  info "Skipping Wine. Install it later (re-run with --wine) if you want Windows-only game servers."
fi

# ---------------------------------------------------------------------------
# Sandbox + containers
# ---------------------------------------------------------------------------
heading "Step 2/6 — Sandbox & containers"

if confirm "Install bubblewrap, the sandbox that keeps every instance inside its own folder?" y; then
  install_sandbox
else
  warn "Skipping bubblewrap — instances will run without the process sandbox."
fi

# The Firewall page drives UFW or firewalld, which need root. Let the panel's user run just that
# tool through sudo without a password (nothing else).
FW_BIN="$(command -v ufw 2>/dev/null || command -v firewall-cmd 2>/dev/null || true)"
if [[ -z "$FW_BIN" ]]; then
  for candidate in /usr/sbin/ufw /sbin/ufw /usr/bin/firewall-cmd /usr/sbin/firewall-cmd; do
    [[ -x "$candidate" ]] && FW_BIN="$candidate" && break
  done
fi
if [[ -n "$FW_BIN" && "$RUN_USER" != "root" ]] \
  && confirm "Let Outpost manage the firewall ($(basename "$FW_BIN")) from its Firewall page? (adds a sudoers rule for that one command)" n; then
  SUDOERS_FILE="/etc/sudoers.d/outpost-firewall"
  SUDOERS_TMP="$(mktemp)"
  echo "$RUN_USER ALL=(root) NOPASSWD: $FW_BIN" >"$SUDOERS_TMP"
  if $SUDO visudo -cf "$SUDOERS_TMP" >/dev/null; then
    $SUDO install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_FILE"
    ok "Outpost can now run $FW_BIN (rule in $SUDOERS_FILE)"
  else
    warn "Couldn't validate the sudoers rule — skipping. Add it yourself: $RUN_USER ALL=(root) NOPASSWD: $FW_BIN"
  fi
  rm -f "$SUDOERS_TMP"
fi

if [[ "$CONTAINERS" == "1" ]] && confirm "Install a container engine for Docker, Portainer and app-catalog instances?" y; then
  if [[ -z "$ENGINE" ]]; then
    if command -v podman >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
      ENGINE=podman
    elif [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
      ENGINE=docker
    else
      read -r -p "Which engine — docker or podman (rootless, no root daemon)? [docker] " ENGINE || ENGINE=""
      ENGINE="${ENGINE:-docker}"
    fi
  fi
  case "$ENGINE" in
    docker) install_docker || warn "Docker setup didn't finish — see above." ;;
    podman) install_podman || warn "Podman setup didn't finish — see above." ;;
    *) warn "Unknown engine '$ENGINE' — skipping container setup." ; ENGINE="" ;;
  esac

  if [[ -n "$ENGINE" ]] && command -v "$ENGINE" >/dev/null 2>&1 && confirm "Pre-download the Portainer image so one-click Portainer instances start immediately?" y; then
    if [[ "$ENGINE" == "docker" ]]; then
      $SUDO docker pull "$PORTAINER_IMAGE" && ok "Portainer image ready" || warn "Couldn't pull $PORTAINER_IMAGE — it'll be pulled when you create a Portainer instance."
    else
      podman pull "$PORTAINER_IMAGE" && ok "Portainer image ready" || warn "Couldn't pull $PORTAINER_IMAGE — it'll be pulled when you create a Portainer instance."
    fi
  fi
else
  ENGINE=""
  info "Skipping container support. Re-run with --engine=docker or --engine=podman to add it later."
fi

# ---------------------------------------------------------------------------
# Install dependencies and build
# ---------------------------------------------------------------------------
heading "Step 3/6 — Installing dependencies and building"

cd "$PROJECT_DIR"
info "npm run setup (installs root, server, and web workspace dependencies)…"
npm run setup
info "npm run build (server/dist + web/dist)…"
npm run build

[[ -f "$PROJECT_DIR/server/dist/index.js" ]] || die "Build finished but server/dist/index.js is missing — check the build output above."
[[ -f "$PROJECT_DIR/web/dist/index.html" ]] || die "Build finished but web/dist/index.html is missing — check the build output above."
ok "Build complete"

# ---------------------------------------------------------------------------
# Run once, verify it actually serves the UI, then stop it
# ---------------------------------------------------------------------------
heading "Step 4/6 — Verifying"

VERIFY_PORT="${PORT:-8642}"
# Run the compiled server directly (what `npm start` does under the hood) rather than through
# the npm wrapper, so $! is the actual Node process and killing it doesn't leave an orphan.
( cd "$PROJECT_DIR/server" && exec env PORT="$VERIFY_PORT" node dist/index.js ) >/tmp/outpost-install-check.log 2>&1 &
VERIFY_PID=$!
trap 'kill "$VERIFY_PID" >/dev/null 2>&1 || true' EXIT

sleep 3
if curl -fsS "http://localhost:$VERIFY_PORT/api/health" >/dev/null 2>&1; then
  ok "Health check passed (http://localhost:$VERIFY_PORT/api/health)"
else
  kill "$VERIFY_PID" >/dev/null 2>&1 || true
  trap - EXIT
  err "Outpost didn't respond on port $VERIFY_PORT. Recent log output:"
  tail -n 30 /tmp/outpost-install-check.log || true
  die "Fix the error above and re-run this script."
fi

kill "$VERIFY_PID" >/dev/null 2>&1 || true
wait "$VERIFY_PID" 2>/dev/null || true
trap - EXIT

# ---------------------------------------------------------------------------
# Optional: systemd service
# ---------------------------------------------------------------------------
heading "Step 5/6 — Run on boot?"

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemd isn't available on this system — skipping the service setup."
  warn "Use pm2 instead (see the README's 'Running 24/7' section)."
else
  if confirm "Set up a systemd service so Outpost starts automatically and restarts on boot/crash?" n; then
    SERVICE_FILE="/etc/systemd/system/outpost.service"
    LEGACY_SERVICE_FILE="/etc/systemd/system/multicraft.service"
    # Before the rename this unit was multicraft.service — replace it rather than run two panels.
    if [[ -f "$LEGACY_SERVICE_FILE" ]] && confirm "Found the old multicraft.service — replace it with outpost.service?" y; then
      $SUDO systemctl disable --now multicraft.service >/dev/null 2>&1 || true
      $SUDO rm -f "$LEGACY_SERVICE_FILE"
      $SUDO systemctl daemon-reload
      ok "Removed multicraft.service"
    fi
    RUN_GROUP="$(id -gn)"
    NPM_PATH="$(command -v npm)"

    if [[ -f "$SERVICE_FILE" ]]; then
      confirm "$SERVICE_FILE already exists — overwrite it?" n || { warn "Leaving the existing service file untouched."; SERVICE_FILE=""; }
    fi

    if [[ -n "$SERVICE_FILE" ]]; then
      read -r -p "Port for Outpost to listen on [8642]: " SERVICE_PORT || true
      SERVICE_PORT="${SERVICE_PORT:-8642}"

      info "Writing $SERVICE_FILE (runs as $RUN_USER)…"
      $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Outpost panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NPM_PATH start
Restart=on-failure
User=$RUN_USER
Group=$RUN_GROUP
Environment=PORT=$SERVICE_PORT
$( [[ "$ENGINE" == "podman" && "$RUN_USER" != "root" ]] && echo "Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$RUN_USER")" )

[Install]
WantedBy=multi-user.target
EOF

      $SUDO systemctl daemon-reload
      $SUDO systemctl enable --now outpost

      sleep 2
      if systemctl is-active --quiet outpost; then
        ok "outpost.service is active"
        if curl -fsS "http://localhost:$SERVICE_PORT/api/health" >/dev/null 2>&1; then
          ok "Confirmed reachable at http://localhost:$SERVICE_PORT"
        else
          warn "Service is running but didn't answer on port $SERVICE_PORT yet — give it a moment, then check 'journalctl -u outpost -f'."
        fi
      else
        err "Service didn't start. Check: journalctl -u outpost -e"
      fi

      echo
      echo "Manage it with:"
      echo "  sudo systemctl status outpost"
      echo "  sudo systemctl restart outpost"
      echo "  sudo systemctl stop outpost"
      echo "  journalctl -u outpost -f"
    fi
  else
    ok "Skipping systemd. Start it manually whenever you want it running:"
    echo "  cd $PROJECT_DIR && npm start"
    echo "(See the README's 'Running 24/7' section for pm2 as a lighter-weight always-on option.)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
heading "Step 6/6 — Done"
echo "Outpost is installed at: $PROJECT_DIR"
echo "Panel URL (once running):  http://<this-machine's-ip>:${SERVICE_PORT:-${VERIFY_PORT:-8642}}"
echo
if [[ -n "$ENGINE" ]]; then
  echo "Containers:                $ENGINE ($( [[ "$ENGINE" == docker ]] && echo 'docker.service + docker.socket enabled' || echo "podman.socket enabled for $RUN_USER" ))"
fi
command -v bwrap >/dev/null 2>&1 && echo "Sandbox:                   bubblewrap $(bwrap --version 2>/dev/null | awk '{print $2}')"
echo
echo "Reminders:"
if [[ "$DOCKER_GROUP_ADDED" == "1" ]]; then
  echo "  - $RUN_USER was added to the docker group: log out and back in (and restart Outpost if it's"
  echo "    already running) before Docker/Portainer instances can start."
fi
echo "  - The panel's own port only needs to be reachable by admins — consider a reverse proxy/VPN for it."
echo "  - Each instance needs its own port opened to its users (e.g. 25565/tcp Minecraft, 9443/tcp Portainer)."
echo "  - See the README for firewall commands (ufw/firewalld) and moving data outside the checkout."
