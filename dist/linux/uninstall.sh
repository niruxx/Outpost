#!/usr/bin/env bash
#
# Outpost uninstaller for Linux. Reverses what install.sh (and the README's systemd/pm2
# setup) may have changed on this machine:
#
#   - stops Outpost and any game servers it launched
#   - removes the outpost (or pre-rename multicraft) systemd service, or its pm2 entry
#   - removes Outpost's containers and, optionally, the container engine and sandbox it installed
#   - removes the firewall rule for the panel port, if one was added
#   - deletes Outpost's data (database, every server's files, backups, steamcmd)
#     and update.sh's pre-update archives                                           [asks first]
#   - deletes build output and node_modules from the checkout
#   - removes packages install.sh may have installed: Node.js (+ NodeSource repo), Java,
#     steamcmd's 32-bit libraries, and optionally git/curl                          [asks first]
#   - removes the dedicated 'outpost' (or 'multicraft') system user from the README setup, if present
#   - optionally deletes the checkout itself
#
# install.sh doesn't record which packages were already on the machine before it ran, so every
# package removal is opt-in and your package manager shows exactly what it will remove.
#
# Usage: run from inside the Outpost checkout:
#   ./uninstall.sh            interactive; asks before every step
#   ./uninstall.sh -y         non-interactive; removes the service/processes/build output, keeps data + packages
#   ./uninstall.sh -y --purge non-interactive; removes everything above, data, packages and the checkout
#                             (git and curl are never removed non-interactively)
#
set -euo pipefail

# Everything lives in main() so bash parses the whole script up front — the last step can delete
# the checkout this file lives in, and bash otherwise reads scripts lazily while running them.
main() {

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
PURGE=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) NONINTERACTIVE=1 ;;
    --purge)  PURGE=1 ;;
    -h|--help)
      echo "Usage: $0 [-y|--yes] [--purge]"
      echo "  -y, --yes   Non-interactive: accept every default."
      echo "              Removes the service, running processes and build output; keeps data and packages."
      echo "  --purge     Make 'remove' the default for everything: data, Node.js, Java, steamcmd libraries,"
      echo "              the container engine, the outpost system user and the checkout. git and curl are still only"
      echo "              removed if you say so interactively."
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

# Default answer for destructive steps: yes under --purge, otherwise no.
PURGE_DEFAULT=n; [[ "$PURGE" == "1" ]] && PURGE_DEFAULT=y

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

# Like confirm, but interactively requires typing the word exactly — for irreversible data loss.
confirm_typed() {
  local prompt="$1" word="$2" default="$3" reply
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    confirm "$prompt" "$default"
    return
  fi
  read -r -p "$prompt Type '$word' to confirm, anything else skips: " reply || reply=""
  [[ "$reply" == "$word" ]]
}

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
heading "Outpost uninstaller"

[[ "$(uname -s)" == "Linux" ]] || die "This script is for Linux. Detected: $(uname -s)."

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required to remove the service and system packages (or re-run this script as root)."
  SUDO="sudo"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]] && grep -qE '"name": *"(outpost|multicraft)"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  PROJECT_DIR="$SCRIPT_DIR"
else
  die "Run this from inside the Outpost checkout it should uninstall."
fi
ok "Project directory: $PROJECT_DIR"

# Removes a path, falling back to sudo when it's owned by another user (e.g. the service user).
# Refuses anything that isn't an absolute path or that is a top-level/system directory.
safe_rm() {
  local p="${1%/}"
  [[ -n "$p" && "$p" == /* ]] || { err "Refusing to remove non-absolute path '$1'"; return 1; }
  case "$p" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/*bin|/usr/lib*|/var|/var/lib)
      err "Refusing to remove system directory '$p'"; return 1 ;;
  esac
  [[ "$p" == "${HOME%/}" ]] && { err "Refusing to remove your home directory '$p'"; return 1; }
  [[ -e "$p" || -L "$p" ]] || return 0
  rm -rf -- "$p" 2>/dev/null || $SUDO rm -rf -- "$p"
}

# ---------------------------------------------------------------------------
# Detect how Outpost was set up
# ---------------------------------------------------------------------------
DISTRO_FAMILY="unknown"
DISTRO_NAME="Linux"
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  DISTRO_NAME="$(. /etc/os-release; echo "${PRETTY_NAME:-$ID}")"
  case " $(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}") " in
    *debian*|*ubuntu*) DISTRO_FAMILY="debian" ;;
    *arch*|*manjaro*)  DISTRO_FAMILY="arch" ;;
    *fedora*|*rhel*|*centos*) DISTRO_FAMILY="fedora" ;;
    *suse*|*opensuse*) DISTRO_FAMILY="opensuse" ;;
  esac
fi
ok "Detected: $DISTRO_NAME ($DISTRO_FAMILY)"

HAS_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && HAS_SYSTEMD=1

# outpost.service — or multicraft.service on installs from before the rename.
SERVICE_NAME=outpost
SERVICE_PRESENT=0
for name in outpost multicraft; do
  if [[ "$HAS_SYSTEMD" == "1" ]] && { [[ -f "/etc/systemd/system/$name.service" ]] || systemctl list-unit-files "$name.service" 2>/dev/null | grep -q "^$name\.service"; }; then
    SERVICE_NAME="$name"
    SERVICE_PRESENT=1
    break
  fi
done
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
SERVICE_DROPIN_DIR="/etc/systemd/system/$SERVICE_NAME.service.d"

# Reads `Environment=NAME=value` (optionally quoted) out of the service file.
service_env() {
  [[ -f "$SERVICE_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*Environment=\"\{0,1\}$1=\([^\"]*\)\"\{0,1\}[[:space:]]*\$/\1/p" "$SERVICE_FILE" | tail -n1
}
service_key() {
  [[ -f "$SERVICE_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*$1=\(.*\)\$/\1/p" "$SERVICE_FILE" | tail -n1
}

PANEL_PORT="$(service_env PORT)"; PANEL_PORT="${PANEL_PORT:-${PORT:-8642}}"
SERVICE_USER="$(service_key User)"
SERVICE_WORKDIR="$(service_key WorkingDirectory)"

DATA_DIR="$(service_env OUTPOST_DATA_DIR)"
[[ -n "$DATA_DIR" ]] || DATA_DIR="$(service_env MULTICRAFT_DATA_DIR)"
DATA_DIR="${DATA_DIR:-${OUTPOST_DATA_DIR:-${MULTICRAFT_DATA_DIR:-$PROJECT_DIR/server/data}}}"
# Mirror the server's path.resolve() for relative values.
[[ "$DATA_DIR" == /* ]] || DATA_DIR="$PROJECT_DIR/server/$DATA_DIR"
DATA_DIR="${DATA_DIR%/}"

if [[ "$SERVICE_PRESENT" == "1" ]]; then
  ok "systemd service: $SERVICE_FILE (user: ${SERVICE_USER:-?}, port: $PANEL_PORT)"
  if [[ -n "$SERVICE_WORKDIR" && "${SERVICE_WORKDIR%/}" != "$PROJECT_DIR" ]]; then
    warn "The service runs from $SERVICE_WORKDIR, not this checkout. It'll still be removed — it's the only"
    warn "$SERVICE_NAME.service on this machine — but build output/checkout cleanup below only covers $PROJECT_DIR."
  fi
else
  info "No outpost (or multicraft) systemd service found."
fi
ok "Data directory: $DATA_DIR$([[ -d "$DATA_DIR" ]] || echo ' (not present)')"

# ---------------------------------------------------------------------------
# Step 1 — stop everything and remove the service
# ---------------------------------------------------------------------------
heading "Step 1/6 — Stopping Outpost and removing the service"

if [[ "$SERVICE_PRESENT" == "1" ]]; then
  if confirm "Stop, disable and remove $SERVICE_NAME.service?" y; then
    # Stopping the unit also stops every game server the panel spawned (same cgroup).
    $SUDO systemctl disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || $SUDO systemctl stop "$SERVICE_NAME.service" 2>/dev/null || true
    safe_rm "$SERVICE_FILE"
    safe_rm "$SERVICE_DROPIN_DIR"
    # A leftover enablement symlink if the unit was enabled under another target.
    for link in /etc/systemd/system/*.wants/"$SERVICE_NAME".service; do
      [[ -L "$link" ]] && safe_rm "$link"
    done
    $SUDO systemctl daemon-reload
    $SUDO systemctl reset-failed "$SERVICE_NAME.service" >/dev/null 2>&1 || true
    ok "$SERVICE_NAME.service removed"
  else
    warn "Leaving $SERVICE_NAME.service in place."
  fi
fi

for pm2name in outpost multicraft; do
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$pm2name" >/dev/null 2>&1; then
    if confirm "Found a pm2 process named '$pm2name' — delete it from pm2?" y; then
      pm2 delete "$pm2name" >/dev/null && pm2 save --force >/dev/null 2>&1 || true
      ok "Removed $pm2name from pm2 (pm2 itself is left installed — 'npm uninstall -g pm2' removes it)."
    fi
  fi
done

# Anything still running that the service didn't cover: game servers / steamcmd working inside
# the data dir, or a manually started panel (npm start, node dist/index.js, npm run dev) in the
# checkout. Shells, editors and this script's own ancestors are always skipped.
ancestors=" $$ "
pid=$$
while [[ "$pid" -gt 1 ]]; do
  # Field 4 of /proc/PID/stat is the parent PID; strip "(comm)" first since it may contain spaces.
  pid="$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f2)"
  [[ -n "$pid" ]] || break
  ancestors+="$pid "
done

STRAY_PIDS=()
# One privileged pass over every process's cwd (other users' cwds aren't readable unprivileged).
while IFS=' ' read -r proc cwd; do
  pid="${proc#/proc/}"
  [[ "$ancestors" == *" $pid "* ]] && continue
  case "$(cat "$proc/comm" 2>/dev/null)" in
    bash|sh|dash|zsh|fish|ksh|tcsh|csh|code|code-oss|vim|nvim|nano|less|git|claude) continue ;;
  esac
  if [[ "$cwd" == "$DATA_DIR" || "$cwd" == "$DATA_DIR/"* ]]; then
    STRAY_PIDS+=("$pid")
  elif [[ "$cwd" == "$PROJECT_DIR" || "$cwd" == "$PROJECT_DIR/"* ]]; then
    cmdline="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null)" || continue
    [[ "$cmdline" =~ dist/index\.js|npm(-cli\.js)?\ (run\ )?(start|dev)|concurrently|tsx\ watch|vite ]] && STRAY_PIDS+=("$pid")
  fi
done < <($SUDO find /proc -mindepth 2 -maxdepth 2 -name cwd -printf '%h %l\n' 2>/dev/null)

if [[ ${#STRAY_PIDS[@]} -gt 0 ]]; then
  warn "These processes are still running from the Outpost checkout or data directory:"
  ps -o pid=,user=,args= -p "$(IFS=,; echo "${STRAY_PIDS[*]}")" | sed 's/^/    /' | cut -c1-160
  if confirm "Stop them?" y; then
    $SUDO kill -TERM "${STRAY_PIDS[@]}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      alive=()
      for p in "${STRAY_PIDS[@]}"; do kill -0 "$p" 2>/dev/null || $SUDO kill -0 "$p" 2>/dev/null && alive+=("$p"); done
      [[ ${#alive[@]} -eq 0 ]] && break
      sleep 1
    done
    if [[ ${#alive[@]} -gt 0 ]]; then
      warn "Force-killing processes that didn't exit: ${alive[*]}"
      $SUDO kill -KILL "${alive[@]}" 2>/dev/null || true
    fi
    ok "Stopped"
  else
    warn "Leaving them running — deleting files out from under them may fail or corrupt worlds."
  fi
else
  ok "No Outpost processes running"
fi

# ---------------------------------------------------------------------------
# Step 2 — firewall rule for the panel port
# ---------------------------------------------------------------------------
heading "Step 2/6 — Firewall"

FIREWALL_TOUCHED=0
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qE "^${PANEL_PORT}/tcp[[:space:]]"; then
  FIREWALL_TOUCHED=1
  if confirm "Remove the ufw rule allowing the panel port ${PANEL_PORT}/tcp?" y; then
    $SUDO ufw delete allow "${PANEL_PORT}/tcp" >/dev/null && ok "ufw rule removed" || warn "Couldn't remove the ufw rule — remove it with 'sudo ufw status numbered' / 'sudo ufw delete <n>'."
  fi
fi
if command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1 \
   && $SUDO firewall-cmd --permanent --query-port="${PANEL_PORT}/tcp" >/dev/null 2>&1; then
  FIREWALL_TOUCHED=1
  if confirm "Remove the firewalld rule opening the panel port ${PANEL_PORT}/tcp?" y; then
    $SUDO firewall-cmd --permanent --remove-port="${PANEL_PORT}/tcp" >/dev/null && $SUDO firewall-cmd --reload >/dev/null \
      && ok "firewalld rule removed" || warn "Couldn't remove the firewalld rule."
  fi
fi
[[ "$FIREWALL_TOUCHED" == "0" ]] && ok "No firewall rule found for the panel port ${PANEL_PORT}/tcp"
warn "Ports you opened for individual game servers (e.g. 25565/tcp, 19132/udp) aren't tracked — remove those rules yourself."

# ---------------------------------------------------------------------------
# Step 3 — data
# ---------------------------------------------------------------------------
heading "Step 3/6 — Data (database, servers, worlds, backups)"

# Leftovers from the panel's environment import/reset feature: <data>-<action>-<timestamp>.
DATA_SIBLINGS=()
for d in "$DATA_DIR"-*; do [[ -d "$d" ]] && DATA_SIBLINGS+=("$d"); done

if [[ -d "$DATA_DIR" || ${#DATA_SIBLINGS[@]} -gt 0 ]]; then
  [[ -d "$DATA_DIR" ]] && info "$DATA_DIR — $($SUDO du -sh "$DATA_DIR" 2>/dev/null | cut -f1)"
  for d in "${DATA_SIBLINGS[@]}"; do info "$d — $($SUDO du -sh "$d" 2>/dev/null | cut -f1) (previous environment snapshot)"; done
  warn "This holds every server's worlds and backups, user accounts and the database. Deleting it can't be undone."
  warn "Want a copy first? Export one from the panel's environment backup page before continuing."
  if confirm_typed "Permanently delete Outpost's data?" "delete" "$PURGE_DEFAULT"; then
    safe_rm "$DATA_DIR"
    for d in "${DATA_SIBLINGS[@]}"; do safe_rm "$d"; done
    ok "Data deleted"
  else
    ok "Keeping data at $DATA_DIR"
  fi
else
  ok "No data directory found"
fi

# update.sh archives the data dir here (next to the checkout) before every update.
UPDATE_BACKUPS="$(dirname "$PROJECT_DIR")/outpost-update-backups"
# Installs from before the rename keep their update backups here.
[[ -d "$(dirname "$PROJECT_DIR")/multicraft-update-backups" && ! -d "$UPDATE_BACKUPS" ]] && UPDATE_BACKUPS="$(dirname "$PROJECT_DIR")/multicraft-update-backups"
if [[ -d "$UPDATE_BACKUPS" ]]; then
  info "$UPDATE_BACKUPS — $(du -sh "$UPDATE_BACKUPS" 2>/dev/null | cut -f1) (update.sh's pre-update data archives)"
  if confirm_typed "Permanently delete update.sh's data backups too?" "delete" "$PURGE_DEFAULT"; then
    safe_rm "$UPDATE_BACKUPS"
    ok "Update backups deleted"
  else
    ok "Keeping update backups at $UPDATE_BACKUPS"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 — build output, dependencies and temp files
# ---------------------------------------------------------------------------
heading "Step 4/6 — Build output and dependencies"

if confirm "Delete node_modules and build output (server/dist, web/dist) from the checkout?" y; then
  for p in node_modules server/node_modules web/node_modules server/dist web/dist; do
    safe_rm "$PROJECT_DIR/$p"
  done
  find "$PROJECT_DIR" -name '*.tsbuildinfo' -not -path '*/.git/*' -delete 2>/dev/null || true
  ok "Build output and dependencies removed"
fi

for log in outpost-install-check outpost-update-check multicraft-install-check multicraft-update-check; do
  safe_rm "/tmp/$log.log"
done
ok "Removed installer/updater temp logs"

# ---------------------------------------------------------------------------
# Step 5 — system packages
# ---------------------------------------------------------------------------
heading "Step 5/6 — System packages"

pkg_installed() {
  case "$DISTRO_FAMILY" in
    debian)          dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    arch)            pacman -Q "$1" >/dev/null 2>&1 ;;
    fedora|opensuse) rpm -q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Prints the subset of the given packages that are installed.
installed_of() {
  local p out=()
  for p in "$@"; do pkg_installed "$p" && out+=("$p"); done
  echo "${out[*]:-}"
}

# Interactive runs let the package manager show its transaction and ask again, so you can see
# (and veto) anything else that would be removed along with these packages.
pkg_remove() {
  local yes=()
  case "$DISTRO_FAMILY" in
    debian)   [[ "$NONINTERACTIVE" == "1" ]] && yes=(-y); $SUDO apt-get purge "${yes[@]}" "$@" ;;
    arch)     [[ "$NONINTERACTIVE" == "1" ]] && yes=(--noconfirm); $SUDO pacman -Rns "${yes[@]}" "$@" ;;
    fedora)   [[ "$NONINTERACTIVE" == "1" ]] && yes=(-y); $SUDO dnf remove "${yes[@]}" "$@" ;;
    opensuse) [[ "$NONINTERACTIVE" == "1" ]] && yes=(--non-interactive); $SUDO zypper "${yes[@]}" remove --clean-deps "$@" ;;
  esac
}

# remove_group "label" default pkg...
remove_group() {
  local label="$1" default="$2"; shift 2
  local pkgs; pkgs="$(installed_of "$@")"
  [[ -n "$pkgs" ]] || { ok "$label: not installed"; return 1; }
  if confirm "Remove $label ($pkgs)?" "$default"; then
    # shellcheck disable=SC2086
    if pkg_remove $pkgs; then ok "$label removed"; return 0; fi
    warn "$label wasn't removed (declined, or other packages still depend on it)."
  fi
  return 1
}

if [[ "$DISTRO_FAMILY" == "unknown" ]]; then
  warn "Unrecognized distro — remove Node.js, Java and steamcmd's 32-bit libraries yourself if you no longer need them."
else
  warn "install.sh only installed these if they were missing, but it can't tell which ones it added."
  warn "Keep anything other software on this machine uses."
  PKG_CHANGED=0

  # --- Node.js (+ NodeSource repo on Debian/Fedora) ---
  case "$DISTRO_FAMILY" in
    debian)   NODE_PKGS=(nodejs) ;;
    arch)     NODE_PKGS=(nodejs npm) ;;
    fedora)   NODE_PKGS=(nodejs nodejs-npm npm) ;;
    opensuse) NODE_PKGS=(nodejs22 npm22) ;;
  esac
  if remove_group "Node.js" "$PURGE_DEFAULT" "${NODE_PKGS[@]}"; then
    PKG_CHANGED=1
    NODESOURCE_FILES=(
      /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources
      /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg
      /etc/apt/preferences.d/nodejs /etc/apt/preferences.d/nsolid
    )
    for f in /etc/yum.repos.d/nodesource*.repo; do [[ -e "$f" ]] && NODESOURCE_FILES+=("$f"); done
    removed_repo=0
    for f in "${NODESOURCE_FILES[@]}"; do
      [[ -e "$f" ]] && { safe_rm "$f"; removed_repo=1; }
    done
    if [[ "$removed_repo" == "1" ]]; then
      ok "Removed the NodeSource package repository"
      [[ "$DISTRO_FAMILY" == "debian" ]] && $SUDO apt-get update -y >/dev/null 2>&1 || true
    fi
    if [[ -d "$HOME/.npm" ]] && confirm "Delete your npm cache (~/.npm) too?" y; then
      safe_rm "$HOME/.npm"
    fi
  fi

  # --- Java ---
  case "$DISTRO_FAMILY" in
    debian)   JAVA_PKGS=(openjdk-21-jdk openjdk-21-jdk-headless openjdk-21-jre openjdk-21-jre-headless) ;;
    arch)     JAVA_PKGS=(jre25-openjdk-headless) ;;
    fedora)   JAVA_PKGS=(java-21-openjdk-devel) ;;
    opensuse) JAVA_PKGS=(java-21-openjdk-devel) ;;
  esac
  if remove_group "Java" "$PURGE_DEFAULT" "${JAVA_PKGS[@]}"; then
    PKG_CHANGED=1
    # Point archlinux-java at whatever JVM is left (or unset it if none).
    [[ "$DISTRO_FAMILY" == "arch" ]] && command -v archlinux-java >/dev/null 2>&1 && { $SUDO archlinux-java fix >/dev/null 2>&1 || true; }
  fi
  [[ "$DISTRO_FAMILY" == "arch" ]] && pkg_installed jdk21-openjdk \
    && info "jdk21-openjdk (from the README's manual setup) is also installed — remove it with 'sudo pacman -Rns jdk21-openjdk' if unused."

  # --- steamcmd 32-bit runtime libraries ---
  case "$DISTRO_FAMILY" in
    debian)   STEAM_PKGS=(lib32gcc-s1 lib32stdc++6) ;;
    arch)     STEAM_PKGS=(lib32-gcc-libs) ;;
    fedora)   STEAM_PKGS=(glibc.i686 libstdc++.i686) ;;
    opensuse) STEAM_PKGS=(libstdc++6-32bit glibc-32bit) ;;
  esac
  remove_group "steamcmd's 32-bit libraries (also used by Steam, Wine, etc.)" "$PURGE_DEFAULT" "${STEAM_PKGS[@]}" && PKG_CHANGED=1 || true
  # install.sh enabled the i386 architecture on Debian; drop it again if nothing uses it anymore.
  if [[ "$DISTRO_FAMILY" == "debian" ]] && dpkg --print-foreign-architectures 2>/dev/null | grep -qx i386; then
    if dpkg-query -W -f='${Architecture}\n' 2>/dev/null | grep -qx i386; then
      info "Leaving the i386 dpkg architecture enabled — other i386 packages are still installed."
    elif confirm "Disable the i386 dpkg architecture (enabled for steamcmd; no i386 packages remain)?" "$PURGE_DEFAULT"; then
      $SUDO dpkg --remove-architecture i386 && $SUDO apt-get update -y >/dev/null 2>&1 && ok "i386 architecture disabled" || warn "Couldn't disable the i386 architecture."
    fi
  fi

  # --- Containers: Outpost's leftovers first, then (opt-in) the engine install.sh set up ---
  for engine in docker podman; do
    command -v "$engine" >/dev/null 2>&1 || continue
    # Containers are --rm and stop with their instance; anything left was orphaned by a panel restart.
    leftovers="$( { $engine ps -aq --filter label=outpost.instance; $engine ps -aq --filter label=multicraft.instance; } 2>/dev/null | sort -u | tr '\n' ' ')"
    if [[ -n "${leftovers// /}" ]] && confirm "Remove containers Outpost started with $engine ($leftovers)?" y; then
      # shellcheck disable=SC2086
      $engine rm -f $leftovers >/dev/null 2>&1 && ok "Removed Outpost's containers"
    fi
    if $engine image inspect docker.io/portainer/portainer-ce:lts >/dev/null 2>&1 && confirm "Remove the Portainer image install.sh pre-downloaded?" "$PURGE_DEFAULT"; then
      $engine rmi docker.io/portainer/portainer-ce:lts >/dev/null 2>&1 && ok "Removed the Portainer image" || warn "Couldn't remove the Portainer image (still in use?)"
    fi
  done

  case "$DISTRO_FAMILY" in
    debian)   DOCKER_PKGS=(docker.io) ;;
    fedora)   DOCKER_PKGS=(moby-engine) ;;
    *)        DOCKER_PKGS=(docker) ;;
  esac
  if [[ -n "$(installed_of "${DOCKER_PKGS[@]}")" ]] && confirm "Remove Docker (and stop docker.service/docker.socket)? Other containers on this machine stop working." "$PURGE_DEFAULT"; then
    $SUDO systemctl disable --now docker.socket docker.service >/dev/null 2>&1 || true
    if pkg_remove "${DOCKER_PKGS[@]}"; then
      ok "Docker removed"
      PKG_CHANGED=1
      if [[ "$EUID" -ne 0 ]] && id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
        $SUDO gpasswd -d "$(id -un)" docker >/dev/null 2>&1 && ok "Removed $(id -un) from the docker group"
      fi
    else
      warn "Docker wasn't removed."
    fi
  fi
  if [[ -n "$(installed_of podman)" ]] && confirm "Remove Podman (and its user API socket)? Other containers on this machine stop working." "$PURGE_DEFAULT"; then
    systemctl --user disable --now podman.socket >/dev/null 2>&1 || true
    $SUDO systemctl disable --now podman.socket >/dev/null 2>&1 || true
    pkg_remove podman && { ok "Podman removed"; PKG_CHANGED=1; } || warn "Podman wasn't removed."
    if [[ "$EUID" -ne 0 ]] && loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes \
       && confirm "Turn off lingering for $(id -un)? (install.sh enabled it for podman.socket; other user services may rely on it)" n; then
      $SUDO loginctl disable-linger "$(id -un)" && ok "Lingering disabled"
    fi
  fi

  # --- bubblewrap: the instance sandbox. Flatpak depends on it, so never by default. ---
  if [[ -n "$(installed_of bubblewrap)" ]]; then
    if command -v flatpak >/dev/null 2>&1; then
      info "Keeping bubblewrap — Flatpak on this machine depends on it."
    else
      remove_group "bubblewrap (the instance sandbox)" n bubblewrap && PKG_CHANGED=1 || true
    fi
  fi

  # --- git / curl: general-purpose tools, never removed by default ---
  remove_group "git (widely used — only if nothing else needs it)" n git && PKG_CHANGED=1 || true
  remove_group "curl (widely used — only if nothing else needs it)" n curl && PKG_CHANGED=1 || true

  if [[ "$PKG_CHANGED" == "1" && "$DISTRO_FAMILY" == "debian" ]] && confirm "Run 'apt-get autoremove' to drop dependencies nothing needs anymore?" y; then
    yes=(); [[ "$NONINTERACTIVE" == "1" ]] && yes=(-y)
    $SUDO apt-get autoremove "${yes[@]}" || true
  fi
fi

# ---------------------------------------------------------------------------
# Step 6 — dedicated user and the checkout itself
# ---------------------------------------------------------------------------
heading "Step 6/6 — Leftovers"

# The README's systemd guide creates a dedicated system user ('outpost', or 'multicraft' before the rename).
for SYS_USER in outpost multicraft; do
  if id $SYS_USER >/dev/null 2>&1; then
    MC_HOME="$(getent passwd $SYS_USER | cut -d: -f6)"
    MC_UID="$(id -u $SYS_USER)"
    if [[ "$MC_UID" -lt 1000 ]]; then
      [[ "$PROJECT_DIR" == "$MC_HOME"/* || "$DATA_DIR" == "$MC_HOME"/* ]] \
        && warn "Its home $MC_HOME contains the checkout and/or data — removing the user deletes them too."
      if confirm "Remove the '$SYS_USER' system user and its home directory ($MC_HOME)?" "$PURGE_DEFAULT"; then
        $SUDO userdel $SYS_USER && ok "User '$SYS_USER' removed" || warn "Couldn't remove user '$SYS_USER'."
        [[ -n "$MC_HOME" && -d "$MC_HOME" ]] && safe_rm "$MC_HOME"
      fi
    else
      info "A regular (uid $MC_UID) user named '$SYS_USER' exists — not touching it."
    fi
  fi

done

if [[ -d "$PROJECT_DIR" ]]; then
  if [[ -d "$PROJECT_DIR/.git" ]] && command -v git >/dev/null 2>&1 \
     && [[ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ]]; then
    warn "The checkout has uncommitted changes."
  fi
  if confirm "Delete the Outpost checkout itself ($PROJECT_DIR)?" "$PURGE_DEFAULT"; then
    cd /
    safe_rm "$PROJECT_DIR"
    ok "Checkout deleted"
  else
    ok "Keeping the checkout at $PROJECT_DIR (re-run ./install.sh to set it up again)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
heading "Done"
echo "Outpost has been uninstalled per your answers above."
[[ -d "$DATA_DIR" ]] && echo "  - Data kept at: $DATA_DIR"
[[ -d "$UPDATE_BACKUPS" ]] && echo "  - Update backups kept at: $UPDATE_BACKUPS"
[[ -d "$PROJECT_DIR" ]] && echo "  - Checkout kept at: $PROJECT_DIR"
[[ "$SERVICE_PRESENT" == "1" ]] && echo "  - Old service logs remain in the journal until it rotates ('journalctl -u $SERVICE_NAME')."
exit 0
}

main "$@"
