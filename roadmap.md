# Roadmap

Planned features inspired by AMP and other game panels. These are development goals, not commitments or implemented functionality.

## Identity and account access

- [ ] OIDC single sign-on with providers such as Authentik or Keycloak.
- [ ] Passkeys and WebAuthn security keys alongside existing TOTP.
- [ ] Email-based password reset and account recovery.

## Automation

- [ ] Rules triggered by in-game events: player joins/leaves, first-time joins and application state.
- [ ] Incoming webhook triggers for authenticated commands, backups and settings changes.

## Multi-host operations and commercial hosting

- [ ] Central node inventory, provisioning and placement across hosts.
- [ ] IP/port allocation pools and automatic assignment.
- [ ] Billing integration and provisioning/suspension lifecycle with WHMCS or Paymenter.

## Game management

- [ ] Per-user Steam accounts and Steam Guard support.
- [ ] CurseForge server modpack installation.
- [ ] CS2 match setup, map rotation, demos and deeper player administration.

## Virtual machines

- [x] Libvirt VM inventory, power controls, next-boot configuration and domain XML import/editing.
- [x] Read-only display preview with automatic refresh and fullscreen.
- [x] Interactive browser VNC/SPICE consoles with authenticated local/SSH transport.
- [x] Offline internal VM snapshots, directory storage pools, virtual networks, disk creation/attachment and live/offline migration jobs.
- [x] Delegated per-user VM permissions scoped to connection and domain UUID.

## Host administration

- [x] Admin-only interactive host console with service-account, root and named-user sessions on Unix; service-account PowerShell on Windows.
- [x] Per-instance backup directories for external drives/partitions, covering snapshots, scheduled backups, World Rewind and file undo copies.
- [x] Permission-controlled Linux disk inventory, mounting/fstab boot entries, filesystem formatting, signature wiping and basic GPT initialization.
- [x] Engine-wide external Docker/Podman container discovery and native controls; automatic libvirt discovery for Cockpit/virsh guests, including transient VM persistence.
- [x] LUKS2 initialization, unlock/lock, passphrase changes and mapping growth.
- [x] Core LVM PV/VG/LV management, renaming, thin provisioning, snapshots and supported LV resizing.
- [x] Partition growth and filesystem-first offline ext4 partition/LV shrinking.
- [ ] Remaining advanced storage: RAID, extent migration, advanced keyslot/crypttab management, arbitrary layered shrinking, SMART tests and secure whole-disk erasure.

## Comparison and sources

Reviewed October 28, 2026. This assumes “xmp” refers to CubeCoders AMP. These are gaps found in this repository compared with documented features; they are not a claim that every competing panel includes everything below.

| Gap in Outpost | Comparable capability | Why add it |
| --- | --- | --- |
| OIDC single sign-on | AMP supports OIDC identity providers such as Authentik. | Central identity, account lifecycle and access across services. |
| Passkeys / WebAuthn security keys | AMP documents WebAuthn alongside TOTP. Outpost currently has TOTP and recovery codes. | Hardware-backed and passwordless sign-in options. |
| Automation triggered by in-game events | AMP can schedule actions in response to player/application events. Outpost has timed tasks, updates and notifications. | Trigger workflows when players join/leave or particular game events occur. |
| Central node provisioning and IP/port allocation pools | Pterodactyl manages Wings nodes and their allocations. Outpost links hosts and transfers instances, but has no comparable central allocation/provisioning interface. | Operate a fleet and assign server capacity from one panel. |
| Hosting-provider billing integration | AMP's Enterprise features include billing integration. Outpost lists WHMCS/Paymenter integration as unfinished. | Automate paid provisioning, quotas, renewals and suspension. |

Additional repository gaps include email-based password reset, per-user Steam accounts, CurseForge server modpack installation, and deeper title-specific tools such as CS2 match setup/demo management. These are useful development candidates, not assertions that every other panel implements them.

For a self-hosted community, prioritize OIDC/passkeys and event-driven automation. For commercial hosting, prioritize central node/allocation management and billing lifecycle integration. Outpost already covers many core panel tasks: games and containers, console/files/SFTP, snapshots/off-site backups, schedules, plugins/mods, API keys, TOTP, audit logs and per-user instance permissions.

The new [libvirt integration](docs/libvirt.md) adds VM lifecycle management, next-boot configuration, domain XML import/editing and read-only display previews. It also provides interactive browser VNC/SPICE, offline internal snapshots, directory-pool and virtual-network provisioning, disk creation/attachment, migration jobs and delegated per-user VM access. See the guide for transport, storage and migration requirements.

Sources:

- [AMP product features](https://cubecoders.com/AMP) — WebAuthn and event-based scheduling.
- [CubeCoders on OIDC replacing LDAP](https://discourse.cubecoders.com/t/feature-deprecation-notice-ldap-authentication/26349) — OIDC identity-provider support; LDAP should not be treated as a current AMP advantage.
- [AMP 3 licensing changes](https://discourse.cubecoders.com/t/licencing-changes-in-amp-3/43143) — billing integration and announced licensing changes. Announced AMP 3 tier changes are not assumed to be released capabilities.
- [Pterodactyl: creating a node](https://docs.pterodactyl.io/v2/guides/configuration/add-node) — node registration and allocations.

Feature availability can vary with edition/version. This comparison focuses on capabilities, not prices or licensing tiers.
