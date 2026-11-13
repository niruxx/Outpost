# Roadmap

Planned features inspired by AMP, Cockpit and other panels. These are development goals, not commitments or implemented functionality.

## macOS: Minecraft Java first

The current macOS installer focuses on Minecraft Java on Intel and Apple Silicon. It installs prebuilt Node.js and verified Temurin JDKs 8, 11, 17, 21 and 25; legacy Java 16 is attempted where available. Managed runtimes are reused and selected per instance. No Homebrew, container engine, SteamCMD or Wine is installed by this setup. This is an installation scope, not a claim that every Minecraft/modpack version has been tested on both architectures.

- [ ] Validate Minecraft Java creation, downloads, start/stop, console, saves, backups and updates on Intel and Apple Silicon.
- [ ] Validate Fabric, Forge, NeoForge and server modpacks individually, including native-library requirements.
- [ ] Add platform-aware feature availability so deferred macOS features are clearly marked in the UI.
- [ ] Add and validate macOS container-engine support, networking and Portainer.
- [ ] Add and validate macOS SteamCMD downloads and per-game executable/platform selection.
- [ ] Add and validate native Wine runtimes and Windows-server compatibility per game.
- [ ] Evaluate Linux VM/linked-host workflows for unsupported game servers.
- [ ] Validate Bedrock and broader host-administration features separately before advertising macOS support.

## Identity and account access

- [ ] OIDC single sign-on with providers such as Authentik or Keycloak.
- [ ] Passkeys and WebAuthn security keys alongside existing TOTP.
- [ ] Email-based password reset and account recovery.

## Automation

- [x] Permission-checked rules for supported player join/leave/first-observed-join logs and application state.
- [x] Authenticated, deduplicated incoming webhook triggers for fixed commands, backups and settings changes.

## Multi-host operations and commercial hosting

- [x] Central inventory, instance provisioning and memory/tag-based placement across registered Outpost hosts.
- [x] Host IPv4/primary-port allocation pools, transactional reservations and automatic assignment.
- [ ] Billing integration and provisioning/suspension lifecycle with WHMCS or Paymenter.

## Game management

- [x] Encrypted per-user Steam accounts, isolated SteamCMD sessions and one-use Steam Guard codes.
- [x] Pinned CurseForge modpack installation with author server-pack support and manifest fallback.
- [x] CS2 match plans/live controls, managed map rotation, SourceTV demos and native kick/ban administration.
- [x] Game-specific settings and applicable map/world controls for the remaining built-in Steam presets, with native configuration editors, uploads, protected removal and Satisfactory API save management. See [game settings and compatibility](docs/game-settings.md).

## Virtual machines

- [x] Libvirt VM inventory, power controls, next-boot configuration and domain XML import/editing.
- [x] Read-only display preview with automatic refresh and fullscreen.
- [x] Interactive browser VNC/SPICE consoles with authenticated local/SSH transport.
- [x] Offline internal VM snapshots, directory storage pools, virtual networks, disk creation/attachment and live/offline migration jobs.
- [x] Delegated per-user VM permissions scoped to connection and domain UUID.
- [x] Admin VM entry deletion with typed confirmation and retained disks/NVRAM/TPM state.

## Host administration

- [x] Distro-aware default Java selection for Debian, Fedora and Arch environments.
- [x] Host-console dependency explanation and automatic native-backend repair with optional Linux build-tool installation.

- [x] Admin-only interactive host console with service-account, root and named-user sessions on Unix; service-account PowerShell on Windows.
- [x] Per-instance backup directories for external drives/partitions, covering snapshots, scheduled backups, World Rewind and file undo copies.
- [x] Permission-controlled Linux disk inventory, mounting/fstab boot entries, filesystem formatting, signature wiping and basic GPT initialization.
- [x] Engine-wide external Docker/Podman container discovery and native controls; automatic libvirt discovery for Cockpit/virsh guests, including transient VM persistence.
- [x] LUKS2 initialization, unlock/lock, passphrase changes and mapping growth.
- [x] Core LVM PV/VG/LV management, renaming, thin provisioning, snapshots and supported LV resizing.
- [x] Partition growth and filesystem-first offline ext4 partition/LV shrinking.
- [x] Advanced storage: Linux software RAID creation/member management and boot assembly entries; same-VG extent migration; LUKS2 keyslots, header backups and crypttab; SMART tests; supported secure discard and verified HDD overwrite.
- [x] Verified offline ext4 -> LUKS2 -> partition or linear-LV shrinking.
- [x] Single-PV LVM-inside-LUKS boundary shrinking with existing linear LVs, verified before outer layers are reduced.
- [x] Healthy RAID1/5/6 member-count growth with persistent reshape recovery files; LVM writethrough/writeback cache attachment, mode changes and flush/detachment.
- [x] Capability-checked ATA/NVMe block/crypto firmware sanitization, persistent interruption guards and SMART summaries in disk lists.
- [x] Additional complex-stack shrink recipes, automatic multi-LV shrink/extent compaction, RAID level/layout conversion and shrink, and shared/multiple-namespace NVMe sanitization. See [supported limits](docs/expert-storage.md).

## Cockpit parity

Host-administration gaps compared with Cockpit. Outpost already covers storage, libvirt VMs, Docker/Podman containers, the host terminal, firewall rules, journal/`/var/log` viewing, host files and live metrics.

- [x] Systemd service management: start/stop/restart/reload, enable/disable, mask/unmask, per-unit journal and properties, and creating/editing/deleting timers. See [Services and Software](docs/services-and-software.md).
- [x] Software updates through apt/dnf/pacman: available updates with security flags, selective or full upgrades, a reboot-required notice and an automatic-updates switch (unattended-upgrades / dnf-automatic). Also an app browser that searches the repositories, groups packages by purpose and installs/removes them after a preview.
- [x] Host user and group management: create, lock, unlock and delete accounts; groups and administrator (sudo/wheel) membership; passwords, forced changes and expiry; `authorized_keys` editing; and ending login sessions. See [Host administration](docs/host-administration.md).
- [x] Network configuration through NetworkManager: IPv4/IPv6 addresses, gateways and DNS, MTU, connect/disconnect, and bonds, bridges and VLANs. Every change runs in a NetworkManager checkpoint and rolls back automatically if the browser can't reach the panel afterwards. Team devices aren't offered, because NetworkManager has deprecated them.
- [x] System settings: hostname, time zone, NTP on/off and servers (chrony or timesyncd), the clock, immediate or scheduled reboot and shutdown with cancel, and `tuned` performance profiles.
- [x] Historical host metrics: a week of per-minute host CPU, memory, load, network and disk history, plus per-service CPU, memory and disk I/O from systemd cgroups, with anomaly highlighting. Outpost samples these itself instead of using PCP, and network traffic is host-wide only.
- [x] Security posture: SELinux mode and denials with `audit2why`/`audit2allow` explanations, AppArmor profile modes and denials, the system crypto policy, and the panel's own HTTPS (Let's Encrypt via certbot, upload or self-signed; served on a second port with optional redirect).
- [x] Diagnostics: `sos` reports with live output, download and delete; kdump status, enable, dump folder, crash-memory reservation (Fedora/RHEL) and a typed-confirmation crash test.
- [x] Multi-host host administration: a host switcher on the Host pages administers any linked Outpost node that allows it, with Admin Mode for that host and auditing on both panels. Host Files and Host Console remain local-only.

## Comparison and sources

Reviewed October 28, 2026. This assumes “xmp” refers to CubeCoders AMP. These are gaps found in this repository compared with documented features; they are not a claim that every competing panel includes everything below.

| Gap in Outpost | Comparable capability | Why add it |
| --- | --- | --- |
| OIDC single sign-on | AMP supports OIDC identity providers such as Authentik. | Central identity, account lifecycle and access across services. |
| Passkeys / WebAuthn security keys | AMP documents WebAuthn alongside TOTP. Outpost currently has TOTP and recovery codes. | Hardware-backed and passwordless sign-in options. |
| Automation triggered by in-game events | AMP can schedule actions in response to player/application events. Outpost has timed tasks, updates and notifications. | Trigger workflows when players join/leave or particular game events occur. |
| Unattended bare-host provisioning and auxiliary-port allocation bundles | Pterodactyl manages Wings nodes and their allocations. Outpost now inventories registered hosts and provisions instances with primary-port pools; bare-host installation and auxiliary-port bundles remain open. | Operate a fleet and assign server capacity from one panel. |
| Hosting-provider billing integration | AMP's Enterprise features include billing integration. Outpost lists WHMCS/Paymenter integration as unfinished. | Automate paid provisioning, quotas, renewals and suspension. |
| Remaining Cockpit differences | Cockpit edits networks on systemd-networkd hosts through other plugins, offers team devices, uses PCP for metrics, and can open its terminal and file browser on other hosts. Outpost's Host pages cover NetworkManager hosts only, and its Host Files and Host Console are local-only. | Smaller gaps; the Cockpit-parity items above are done. |

Additional repository gaps include email-based password reset, unattended installation of new Outpost hosts, auxiliary-port allocation bundles and tournament/veto orchestration. Core Steam accounts, CurseForge packs, event/webhook rules, fleet placement and CS2 match/demo/player controls are now available; see [operations setup and supported limits](docs/operations.md). These are useful development candidates, not assertions that every other panel implements them.

Remaining priorities include OIDC/passkeys, unattended fleet expansion and billing lifecycle integration. Outpost already covers many core panel tasks: games and containers, console/files/SFTP, snapshots/off-site backups, schedules, plugins/mods, API keys, TOTP, audit logs and per-user instance permissions.

The new [libvirt integration](docs/libvirt.md) adds VM lifecycle management, next-boot configuration, domain XML import/editing and read-only display previews. It also provides interactive browser VNC/SPICE, offline internal snapshots, directory-pool and virtual-network provisioning, disk creation/attachment, migration jobs and delegated per-user VM access. See the guide for transport, storage and migration requirements.

Sources:

- [AMP product features](https://cubecoders.com/AMP) — WebAuthn and event-based scheduling.
- [CubeCoders on OIDC replacing LDAP](https://discourse.cubecoders.com/t/feature-deprecation-notice-ldap-authentication/26349) — OIDC identity-provider support; LDAP should not be treated as a current AMP advantage.
- [AMP 3 licensing changes](https://discourse.cubecoders.com/t/licencing-changes-in-amp-3/43143) — billing integration and announced licensing changes. Announced AMP 3 tier changes are not assumed to be released capabilities.
- [Cockpit project](https://cockpit-project.org/) and [Cockpit guide](https://cockpit-project.org/guide/latest/): Services, Software Updates, Accounts, Networking, SELinux, diagnostic reports, kdump and metrics.
- [Pterodactyl: creating a node](https://docs.pterodactyl.io/v2/guides/configuration/add-node) — node registration and allocations.

Feature availability can vary with edition/version. This comparison focuses on capabilities, not prices or licensing tiers.
