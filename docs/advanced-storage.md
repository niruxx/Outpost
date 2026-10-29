# LUKS, LVM and resizing

The **Storage** page now includes encryption controls on selected devices and an LVM inventory of physical volumes, volume groups and logical volumes. These operations use the same current-account permissions, two-minute previews, single-use confirmation tickets, background jobs and privileged helper lock as basic storage management.

## Upgrade the helper first

Install `cryptsetup`, `lvm2`, `e2fsprogs` and `cloud-guest-utils` (the package providing `growpart`; names vary by distribution). XFS and Btrfs growth also need their matching filesystem utilities. Build Outpost and **reinstall the root-owned helper** from the new build if the service runs unprivileged:

```sh
npm run build
sudo install -o root -g root -m 0755 server/dist/services/storageHelper.js /usr/local/libexec/outpost-storage-helper.mjs
```

The helper remains standalone and uses Node builtins only. The existing exact sudo rule remains valid. See [storage installation](storage.md) for initial setup. Missing LVM tools produce an unavailable LVM section without disabling basic disk inventory.

## Permissions

Administrators retain all permissions by default. Under **Users → Edit user → Host storage permissions**, grant these new capabilities explicitly to other users:

- **LUKS encryption / passphrases**: create encrypted containers, unlock, lock and change a passphrase.
- **LVM management**: manage PVs, groups, LVs, thin pools and snapshots.
- **Resize storage**: partition/filesystem resizing. Growing an encrypted mapping additionally needs encryption permission; resizing PVs/LVs additionally needs LVM permission.

Existing view/mount/format grants do not implicitly grant these new capabilities. Permissions are checked at preview and execution. API keys cannot perform these mutations. System/boot and active Outpost data/backup storage remain protected; this does not provide root-filesystem or root-VG surgery.

## LUKS encryption

Select a blank disk, partition or plain leaf LV and choose **Encrypt blank device**. After reviewing and typing the destructive confirmation, supply and repeat the new passphrase. This creates **LUKS2**. It erases existing content: it is not in-place encryption of a populated filesystem. Existing filesystem signatures must be removed separately before this action is available.

Select the resulting `crypto_LUKS` device and **Unlock**, entering a mapping name and passphrase. The unlocked dm-crypt device appears in inventory; select it to format a filesystem or create an LVM PV inside. Unmount filesystems and release child holders before using **Lock**.

**Change passphrase** calls `cryptsetup luksChangeKey` with the current and new passphrases. This changes the matching keyslot, not every keyslot. Other passphrases, recovery keys and tokens are not automatically revoked. Existing crypttab/key-file configurations are not rewritten and may need corresponding updates. Keyslot enumeration/addition/removal, recovery/header backup management and boot-unlock/crypttab configuration are not included yet.

Passphrases are requested only after preview and sent in the execution POST body. They are excluded from the saved operation, preview response, audit log and job history. The helper passes them through short-lived files in a private root-only directory under `/run`, never as command arguments, and removes those files in `finally`. They are not saved in Outpost's database. Use HTTPS for browser-to-panel traffic.

## LVM workflows

1. Select a blank disk, partition or unlocked mapping and choose **Create LVM PV**.
2. Select an unassigned PV and **Create volume group**. Enter a name and optionally additional unassigned PV paths. The selected PV must be included. Group creation and extension accept only unused, unassigned PVs.
3. In the LVM section, choose **Create LV / thin pool** for a group. Select a linear LV, thin pool, or thin-provisioned LV in an existing pool. Sizes are MiB; thin virtual sizes may exceed physical free space, so monitor pool capacity independently.
4. Activate an LV if necessary, select its block device, format and mount its filesystem using the normal controls.

Supported operations:

| Object | Operations |
| --- | --- |
| Physical volume | Create, grow to its enlarged underlying device, remove when unused/unassigned. |
| Volume group | Create, rename using its stable VG UUID, add unused PVs, detach an entirely unused PV, remove an empty group. |
| Logical volume | Create, activate/deactivate, rename, resize and remove. |
| Thin provisioning | Create thin pools and thin LVs, grow pools, rename pools, remove pools after dependent volumes are removed. |
| Snapshots | Create classic COW snapshots with a supplied COW size, or thin snapshots without a COW size. Dependent snapshots/volumes must be removed before deleting their origin/pool. |

Renaming requires affected filesystems to be unmounted. Device-path references in fstab or crypttab block a rename; convert those references to UUIDs first. UUID-based filesystem references survive renaming. External application paths, scripts and references outside these files are not rewritten. Activate inactive ordinary LVs before renaming a group so mount/reference checks can inspect them. Groups with missing, read-only, system or Outpost member devices are blocked. Duplicate VG names must be resolved outside Outpost first.

This is a broad set of core LVM workflows, not every LVM feature: VDO configurations, clustered VGs, snapshot merging and thin metadata repair remain outside this UI. Same-VG extent migration, PV boundary reduction and Linux software RAID are described in [advanced maintenance](expert-storage.md). Detaching a PV with allocated extents is refused rather than silently discarding or moving them.

## Resize in the correct order

Growth proceeds from outer to inner layers:

1. **Grow partition to available space** uses `growpart` and preserves its start. Adjacent free space must exist.
2. **Grow mapping** expands an unlocked LUKS mapping to its underlying device's available payload capacity. Unmount it and release child holders first. The helper checks the actual cryptsetup payload offset and refuses a shrink.
3. **Grow PV** updates the PV after its underlying device grows. It refuses an underlying device that has become smaller.
4. **Resize logical volume** adjusts the LV target size. Linear/thin ext filesystem LVs use LVM's filesystem-aware resizing. XFS/Btrfs/encrypted outer LVs can grow their block device, then need the relevant inner-layer/filesystem growth separately. Thin pools support growth only.
5. **Grow filesystem** grows offline ext2/3/4, or a singly mounted XFS/Btrfs filesystem. Multi-device filesystem growth is refused.

There are two supported shrinking paths:

- **Linear ext4 LV:** unmount the leaf LV, release child mappings, then supply a smaller MiB target. `lvresize --resizefs` delegates filesystem-first shrink ordering to LVM/fsadm. Raw reductions of encrypted, XFS, thin or unknown filesystem layouts are refused.
- **Plain ext4 partition:** unmount every partition on the parent disk, release holders and select **Shrink ext4 partition**. The helper checks filesystem health, shrinks ext4, verifies the resulting block count/size with `dumpe2fs`, then updates only that partition's size using `sfdisk -N`. The existing start and other fields remain unchanged. If filesystem resizing/verification fails, the partition table is not shortened. If the later table write fails, the smaller filesystem remains inside the original larger partition.

Offline ext4 inside one LUKS2 mapping on a partition or linear LV has a filesystem-first shrink workflow. A single-PV VG inside LUKS can also have its PV boundary shortened after its linear LVs already fit. LVM cache attachment, mode changes and flush/detachment are also supported. See [advanced maintenance](expert-storage.md) for its strict layout checks and recovery limits. Arbitrary layered shrinking remains unsupported; XFS cannot shrink. Keep independent backups before destructive operations. Long filesystem and migration commands have a 24-hour timeout; other native commands generally have a ten-minute timeout. A timed-out or failed operation requires inspection before retrying.

## Verification

```sh
npm run build
node server/test/advanced-storage.mjs
node server/test/storage.mjs
```

The tests use fake block devices, metadata and command runners. They cover LUKS command construction and secret isolation; root/holder checks; VG/LV creation, rename, thin provisioning and snapshots; capacity checks; encryption growth-only enforcement; LV shrink ordering; non-contiguous partition numbering; ext4 verification before partition shortening; rejected unsupported shrinking; and live permission checks. No real disk is encrypted, resized or changed. Validate the installed helper against disposable Linux VM disks before using these new workflows on valuable data.

References: [cryptsetup passphrase changes](https://man7.org/linux/man-pages/man8/cryptsetup-lukschangekey.8.html), [mapping resize](https://man7.org/linux/man-pages/man8/cryptsetup-resize.8.html), [LVM resizing](https://man7.org/linux/man-pages/man8/lvresize.8.html), [filesystem resize ordering](https://man7.org/linux/man-pages/man8/resize2fs.8.html), [single-partition updates](https://www.man7.org/linux/man-pages/man8/sfdisk.8.html).
