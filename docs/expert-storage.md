# Advanced storage maintenance

Select a device under **Storage** for RAID, encryption recovery, disk health and maintenance controls. Administrators have access by default; delegated users need each explicit capability. Existing wipe/LVM grants do not grant secure erasure, RAID or migration. Preview and execution both check permissions and device identity. API keys cannot perform these operations.

Install `mdadm`, `smartmontools`, `lvm2`, `cryptsetup`, `e2fsprogs`, `nvme-cli`, `hdparm` and `util-linux` for the workflows you use. Rebuild Outpost and reinstall the root-owned standalone helper following [host storage setup](storage.md). The old helper does not implement these actions.

## Linux software RAID

Create RAID0/1/5/6/10 from blank, unmounted disks or partitions on distinct physical disks. RAID0 has no redundancy. Inspect array/member state, add a spare/replacement, mark an offline healthy redundant array's member faulty, detach faulty/spare members, or stop an offline array. Membership changes are blocked during synchronization. Healthy offline RAID1/5/6 arrays with native 1.x metadata can grow their member count using existing spares. Outpost retains a recovery file in root-only `/var/lib/outpost-storage/reshape` on independent host storage. Keep that file until reshape is complete; interrupted assembly may require it. Filesystem growth is a separate operation. Level/layout conversions, RAID shrinking, forced assembly and superblock clearing are not implemented.

Boot assembly writes a managed UUID entry to the distribution's mdadm configuration and preserves unrelated entries. It does not rebuild initramfs or configure the OS root array. Allow synchronization to complete and verify native health before trusting redundancy. RAID is not a backup.

## Extent migration and PV boundaries

Move allocated extents atomically to selected PVs in the same VG. Outpost verifies all VG devices, destination free space and protection state. Other LVM mutations are blocked while a pvmove LV exists. Migrations can take hours; inspect native LVM state after interruption or timeout before resuming.

The abort control handles an external/interrupted migration when Outpost's storage lock is free. It cannot interrupt an active Outpost job through the UI; inspect it through the host console and use native LVM recovery/abort tools if needed. A PV size reduction changes only its metadata boundary; LVM must verify that no allocated extents cross it. It never shortens the underlying partition or encryption layer.

## LVM caching

Select a plain linear origin LV to attach a separate blank linear cache LV (at least 64 MiB) from the same non-system VG. Attachment consumes its contents. Writethrough is the default; writeback depends on the cache device for unflushed data. Unmount the origin and release child mappings before attachment, mode changes or detachment. Detachment uses LVM splitcache to flush dirty data and retain the cache LV; it can take hours. No forced dirty-cache removal is offered. Cache pools, writecache and VDO conversion are outside this workflow.

## LUKS2 keys and boot unlock

Inspect occupied keyslots, add a passphrase to an unused slot, change a specific slot, or remove a slot after verifying a different surviving slot's passphrase. Last-slot removal is refused. Header backups stay under root-only `/var/lib/outpost-storage/headers`; copy them to independent protected storage. Old header backups can restore old keys. Header restore is intentionally a native recovery procedure.

crypttab controls support boot passphrase prompts or a new random key in an unused slot. Managed keys live in root-only `/etc/cryptsetup-keys.d`, with private directories and mode 0600 files. Access to the host root filesystem/backups can reveal these unlock keys. Unrelated config lines are preserved, writes are backed up and atomic, and initramfs is not rebuilt. Removing a crypttab entry retains its key and slot; revoke these separately after testing another unlock method. Partial failures retain keys for inspection rather than risking lockout.

## Supported layered shrinking

The supported recipe is **offline ext4 → one plain LUKS2 mapping → partition or linear LV**. Partition siblings must also be unmounted. LV targets must exactly align to VG extents. Outpost verifies LUKS metadata and backing-device identity, checks/shortens ext4, verifies filesystem size, shortens/verifies the mapping, closes it, reduces/verifies the outer device, then reopens it.

Keep an independent data and header backup. A partial failure can leave a smaller filesystem or closed mapping: inspect actual filesystem, mapping and outer sizes before retrying or reopening. No automatic rollback can safely reverse every intermediate write. A second recipe supports **plain linear LVs -> one single-PV VG -> LUKS2 -> partition or linear outer LV**. Reduce individual LVs/filesystems beforehand if needed, and migrate high extents beforehand using native LVM tools. All affected filesystems must be offline. Outpost reduces the PV boundary with native allocated-extent checks, verifies its extent start/count against the payload size, deactivates the VG, then shortens the encryption and outer layer. Previously active LVs are reactivated after reopening. It does not automatically redistribute extents or select new sizes for multiple LVs. Failure may leave the VG inactive or its PV boundary smaller while the underlying device is still larger; inspect before recovery.

Multi-PV inner VGs, nested child mappings, thin/snapshot/RAID stacks, integrity/reencryption and XFS/Btrfs filesystem shrinking are rejected. XFS does not support shrinking; arbitrary layered shrinking remains on the roadmap.

## SMART and whole-disk erasure

SMART summaries appear beside physical disks in the storage list and selected-disk details for users with Disk health permission. Health, temperature, power-on hours, latest self-test and check time are shown where reported. Background reads are cached for 60 seconds, limited to two concurrent commands, and request that sleeping ATA disks be skipped. Unsupported/asleep/missing-tool responses display unknown or unavailable, never a healthy default. Disk replacement invalidates the cached identity. Full SMART reports include health, capabilities and self-test history. Short, long and conveyance tests run asynchronously in the drive; read history later for completion. Unsupported tests/controllers fail explicitly. Diagnostic health failures remain visible in reports instead of being discarded as command errors.

Secure erasure requires a whole unmounted, unreferenced disk, stable disk sequence and serial/WWN confirmation. System/Outpost disks, active holders and VG/RAID members are blocked. Stop external consumers, including VMs using raw disks, before maintenance.

- **Secure discard** uses only the kernel secure-discard API. Unsupported hardware fails; no ordinary-discard or overwrite fallback occurs. This method is separate from firmware sanitization below.
- **Overwrite and verify** is limited to explicitly rotational, non-NVMe disks. Every addressable byte is zeroed, flushed and read back. This is a logical HDD clear, not proof that remapped sectors or flash cells were purged. An interrupted or failed operation is not a successful erasure.

### Firmware sanitization

Inspect **Firmware sanitize status**, then choose a supported block or cryptographic method under **Sanitize disk firmware**. ATA uses native SANITIZE block erase or crypto scramble on directly attached SATA/ATA drives; it does not set security passwords or attempt frozen-state recovery. NVMe uses the controller sanitize command. Outpost only accepts direct PCIe, one controller per subsystem, one reported namespace (namespace 1), unambiguous serial/capabilities and no sharing capability. Fabrics, multipath, extra/inactive namespaces, USB bridges and ambiguous inventory are rejected. Supported nvme-cli status formats include raw numeric SSTAT and device-keyed decoded SSTAT. Unknown formats fail closed.

Firmware jobs retain the privileged lock while polling completion, for up to 23 hours. Before submission, a root-only maintenance record is flushed under `/var/lib/outpost-storage/sanitize`. Errors, timeouts, restarts and unknown status leave this disk and its partitions blocked from mutations. Inspect native status through **Firmware sanitize status**; only a successful device completion report clears the record. A failed/frozen device needs native recovery; there is no force/failure-mode exit or fallback operation. A successful result is the firmware's completion report, not independent proof about every physical cell. Do not delete maintenance records to bypass unresolved hardware state.

Jobs serialize under the privileged storage lock. Closing the browser does not cancel them. Long filesystem/migration/erasure commands may run up to 24 hours; inspect partial results after errors or timeouts. Regression coverage uses simulated Linux tools and disposable regular files, never real block devices. Validate on disposable Linux VM disks before production use.

Native references: [LVM PV reduction](https://man7.org/linux/man-pages/man8/pvresize.8.html), [mdadm reshape recovery](https://man7.org/linux/man-pages/man8/mdadm.8.html), [LVM caching](https://man7.org/linux/man-pages/man7/lvmcache.7.html), [nvme-cli sanitize](https://github.com/linux-nvme/nvme-cli/blob/master/Documentation/nvme-sanitize.1).
