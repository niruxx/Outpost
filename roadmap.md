# Roadmap

Planned features inspired by AMP and other game panels. These are development goals, not commitments or implemented functionality.

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
- [ ] Additional complex-stack shrink recipes, automatic multi-LV shrink/extent compaction, RAID level/layout conversion and shrink, and shared/multiple-namespace NVMe sanitization. See [supported limits](docs/expert-storage.md).

## Comparison and sources

Reviewed October 28, 2026. This assumes “xmp” refers to CubeCoders AMP. These are gaps found in this repository compared with documented features; they are not a claim that every competing panel includes everything below.

| Gap in Outpost | Comparable capability | Why add it |
| --- | --- | --- |
| OIDC single sign-on | AMP supports OIDC identity providers such as Authentik. | Central identity, account lifecycle and access across services. |
| Passkeys / WebAuthn security keys | AMP documents WebAuthn alongside TOTP. Outpost currently has TOTP and recovery codes. | Hardware-backed and passwordless sign-in options. |
| Automation triggered by in-game events | AMP can schedule actions in response to player/application events. Outpost has timed tasks, updates and notifications. | Trigger workflows when players join/leave or particular game events occur. |
| Unattended bare-host provisioning and auxiliary-port allocation bundles | Pterodactyl manages Wings nodes and their allocations. Outpost now inventories registered hosts and provisions instances with primary-port pools; bare-host installation and auxiliary-port bundles remain open. | Operate a fleet and assign server capacity from one panel. |
| Hosting-provider billing integration | AMP's Enterprise features include billing integration. Outpost lists WHMCS/Paymenter integration as unfinished. | Automate paid provisioning, quotas, renewals and suspension. |

Additional repository gaps include email-based password reset, unattended installation of new Outpost hosts, auxiliary-port allocation bundles and tournament/veto orchestration. Core Steam accounts, CurseForge packs, event/webhook rules, fleet placement and CS2 match/demo/player controls are now available; see [operations setup and supported limits](docs/operations.md). These are useful development candidates, not assertions that every other panel implements them.

Remaining priorities include OIDC/passkeys, unattended fleet expansion and billing lifecycle integration. Outpost already covers many core panel tasks: games and containers, console/files/SFTP, snapshots/off-site backups, schedules, plugins/mods, API keys, TOTP, audit logs and per-user instance permissions.

The new [libvirt integration](docs/libvirt.md) adds VM lifecycle management, next-boot configuration, domain XML import/editing and read-only display previews. It also provides interactive browser VNC/SPICE, offline internal snapshots, directory-pool and virtual-network provisioning, disk creation/attachment, migration jobs and delegated per-user VM access. See the guide for transport, storage and migration requirements.

Sources:

- [AMP product features](https://cubecoders.com/AMP) — WebAuthn and event-based scheduling.
- [CubeCoders on OIDC replacing LDAP](https://discourse.cubecoders.com/t/feature-deprecation-notice-ldap-authentication/26349) — OIDC identity-provider support; LDAP should not be treated as a current AMP advantage.
- [AMP 3 licensing changes](https://discourse.cubecoders.com/t/licencing-changes-in-amp-3/43143) — billing integration and announced licensing changes. Announced AMP 3 tier changes are not assumed to be released capabilities.
- [Pterodactyl: creating a node](https://docs.pterodactyl.io/v2/guides/configuration/add-node) — node registration and allocations.

Feature availability can vary with edition/version. This comparison focuses on capabilities, not prices or licensing tiers.
