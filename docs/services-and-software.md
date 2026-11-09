# Services and Software

Administrators can manage the host's systemd units under **Host → Services** and its packages under **Host → Software**. They are part of [Host administration](host-administration.md). Both pages are Linux-only and follow Cockpit's model: anyone with access can browse with **limited access**, and every change needs [Admin Mode](host-files.md#limited-access-and-admin-mode) (the lock button at the top of the Host pages). Changes run as root through the Admin Mode helper and are recorded in the audit log.

Only active administrators with a normal panel sign-in can use these pages. API keys are rejected.

## Services

- **Unit types:** services, timers, sockets, targets, paths and mounts. Each list can be filtered by name or state (active, failed, inactive, enabled, disabled). Units that are installed but not loaded, such as disabled services, are listed too.
- **Details:** clicking a unit shows its state, main PID, memory, CPU time, timestamps, unit file, drop-ins, dependencies and its journal, which can be filtered by priority.
- **Actions:** start, stop, restart, reload, enable, enable and start, disable, mask, unmask and clear failed state. Only the actions that make sense for the unit's state are shown.
- **Lockout protection:** stopping, masking, or disabling and stopping SSH, D-Bus, NetworkManager or core systemd daemons asks for confirmation. Stopping or restarting the unit Outpost itself runs in asks for confirmation too. Outpost finds its own unit from `/proc/self/cgroup`.

### Timers

On the **Timers** tab, **New timer** creates a pair of files in `/etc/systemd/system`:

- `<name>.service`: `Type=oneshot` runs the command, optionally as a given user and in a given working directory.
- `<name>.timer`: runs on a calendar schedule (`OnCalendar`, checked live with `systemd-analyze calendar`) or at an interval (`OnUnitActiveSec` plus a first run after boot), with optional catch-up (`Persistent`) and a random delay.

Both files start with a `# Managed by Outpost` marker. Only timers with that marker can be edited or deleted here. Outpost never overwrites unit files it didn't create. `%` in the command is escaped, so the command runs exactly as typed. Output goes to the unit's journal, which is shown on its Logs tab.

## Software

Outpost detects the package manager: **apt** (Debian, Ubuntu), **dnf** (Fedora, RHEL and derivatives) or **pacman** (Arch).

### Updates

- **Check for updates** refreshes the package lists (`apt-get update`, `dnf makecache --refresh`, `pacman -Sy`) and lists pending updates. On Arch the list comes from `checkupdates` when pacman-contrib is installed.
- **Security updates are flagged:** on apt, updates from a `-security` suite; on dnf, packages named in `dnf updateinfo --security`. Arch publishes no such metadata.
- **Install selected** or **Install all.** On apt, "all" is `apt-get upgrade --with-new-pkgs`, which never removes packages. On Arch, only full upgrades (`pacman -Syu`) are offered, because partial upgrades are unsupported there.
- **Restart required:** shown from `/run/reboot-required` on apt and `dnf needs-restarting -r` on dnf, or when the running kernel's modules were removed by an upgrade.
- **Automatic updates:** on apt, the switch writes `/etc/apt/apt.conf.d/20auto-upgrades` for unattended-upgrades. On dnf, it enables `dnf-automatic-install.timer`. If the tool isn't installed, the page offers to install it. On dnf5 systems the timer may have a different name; set it up from the Host Console there.

### Browse & install

- **Without a search:** the page shows a curated list of common server software (web servers, databases, languages, containers, monitoring, networking, security, media, game-server tools, utilities), mapped to each distro's package names.
- **With a search:** the page searches all of the configured repositories (`apt-cache search`, `dnf search`, `pacman -Ss`) and shows the closest 150 matches.
- **Groups:** every package is placed in a group from the curated list, the distro's section (apt) or package group (pacman), or name patterns. You can filter by group and sort by group, relevance or name.
- **Review before changing:** **Install** and **Remove** first show the package manager's own simulation (`apt-get -s`, `dnf --assumeno`, `pacman --print`), so you can see the dependencies that come with a change before confirming it.

On Arch, installing runs `pacman -Syu --needed <package>`, which also upgrades the rest of the system. That is Arch's supported way to install packages.

### Installed

This tab lists everything installed, with version, size and group. By default it shows only software installed on request: `apt-mark showmanual`, `dnf repoquery --userinstalled` or pacman's install reason. Packages pulled in as dependencies are hidden.

### Jobs

Package transactions run one at a time in the background, and their output streams to the page. You can leave the page and come back. While a transaction is running, Admin Mode doesn't time out, and turning Admin Mode off or signing out lets the transaction finish before the helper stops, so dpkg/rpm are never interrupted halfway. Each transaction is audited as `host.package.<verb>`, with `.failed` added when it fails.

## Audit actions

`host.service.<action>`, `host.timer.create|update|delete`, `host.package.refresh|install|remove|upgrade|upgrade-all[.failed]`, `host.updates.auto.enable|disable`.

## Verification

```sh
npm run build
node server/test/host-system.mjs
```

The test runs on any OS. It covers systemctl and package-manager output parsing, command construction and argument validation, timer file rendering and round trips (in a scratch folder), lockout protection, the job runner, the helper's validation of system operations, and the routes' access rules.
