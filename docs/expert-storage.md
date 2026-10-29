# Advanced storage maintenance

Select a device under **Storage** for RAID, encryption recovery, disk health and maintenance controls. Administrators have access by default; delegated users need each explicit capability. Existing wipe/LVM grants do not grant secure erasure, RAID or migration. Preview and execution both check permissions and device identity. API keys cannot perform these operations.

Install `mdadm`, `smartmontools`, `lvm2`, `cryptsetup`, `e2fsprogs` and `util-linux` for the workflows you use. Rebuild Outpost and reinstall the root-owned standalone helper following [host storage setup](storage.md). The old helper does not implement these actions.

## Linux software RAID

Create RAID0/1/5/6/10 from blank, unmounted disks or partitions on distinct physical disks. RAID0 has no redundancy. Inspect array/member state, add a spare/replacement, mark an offline healthy redundant array's member faulty, detach faulty/spare members, or stop an offline array. Membership changes are blocked during synchronization. There is no forced assembly, reshape, superblock clearing or cache management.

Boot assembly writes a managed UUID entry to the distribution's mdadm configuration and preserves unrelated entries. It does not rebuild initramfs or configure the OS root array. Allow synchronization to complete and verify native health before trusting redundancy. RAID is not a backup.

## Extent migration and PV boundaries

Move allocated extents atomically to selected PVs in the same VG. Outpost verifies all VG devices, destination free space and protection state. Other LVM mutations are blocked while a pvmove LV exists. Migrations can take hours; inspect native LVM state after interruption or timeout before resuming.

The abort control handles an external/interrupted migration when Outpost's storage lock is free. It cannot interrupt an active Outpost job through the UI; inspect it through the host console and use native LVM recovery/abort tools if needed. A PV size reduction changes only its metadata boundary; LVM must verify that no allocated extents cross it. It never shortens the underlying partition or encryption layer.

## LUKS2 keys and boot unlock

Inspect occupied keyslots, add a passphrase to an unused slot, change a specific slot, or remove a slot after verifying a different surviving slot's passphrase. Last-slot removal is refused. Header backups stay under root-only `/var/lib/outpost-storage/headers`; copy them to independent protected storage. Old header backups can restore old keys. Header restore is intentionally a native recovery procedure.

crypttab controls support boot passphrase prompts or a new random key in an unused slot. Managed keys live in root-only `/etc/cryptsetup-keys.d`, with private directories and mode 0600 files. Access to the host root filesystem/backups can reveal these unlock keys. Unrelated config lines are preserved, writes are backed up and atomic, and initramfs is not rebuilt. Removing a crypttab entry retains its key and slot; revoke these separately after testing another unlock method. Partial failures retain keys for inspection rather than risking lockout.

## Supported layered shrinking

The supported recipe is **offline ext4 → one plain LUKS2 mapping → partition or linear LV**. Partition siblings must also be unmounted. LV targets must exactly align to VG extents. Outpost verifies LUKS metadata and backing-device identity, checks/shortens ext4, verifies filesystem size, shortens/verifies the mapping, closes it, reduces/verifies the outer device, then reopens it.

Keep an independent data and header backup. A partial failure can leave a smaller filesystem or closed mapping: inspect actual filesystem, mapping and outer sizes before retrying or reopening. No automatic rollback can safely reverse every intermediate write. LVM-inside-LUKS, thin/snapshot/RAID stacks, integrity/reencryption and XFS/Btrfs shrinking are rejected. XFS does not support shrinking; arbitrary layered shrinking remains on the roadmap.

## SMART and whole-disk erasure

SMART reports include health, capabilities and self-test history. Short, long and conveyance tests run asynchronously in the drive; read history later for completion. Unsupported tests/controllers fail explicitly. Diagnostic health failures remain visible in reports instead of being discarded as command errors.

Secure erasure requires a whole unmounted, unreferenced disk, stable disk sequence and serial/WWN confirmation. System/Outpost disks, active holders and VG/RAID members are blocked. Stop external consumers, including VMs using raw disks, before maintenance.

- **Secure discard** uses only the kernel secure-discard API. Unsupported hardware fails; no ordinary-discard or overwrite fallback occurs. This does not implement ATA/NVMe firmware sanitize commands.
- **Overwrite and verify** is limited to explicitly rotational, non-NVMe disks. Every addressable byte is zeroed, flushed and read back. This is a logical HDD clear, not proof that remapped sectors or flash cells were purged. An interrupted or failed operation is not a successful erasure.

Jobs serialize under the privileged storage lock. Closing the browser does not cancel them. Long filesystem/migration/erasure commands may run up to 24 hours; inspect partial results after errors or timeouts. Regression coverage uses simulated Linux tools and disposable regular files, never real block devices. Validate on disposable Linux VM disks before production use.
