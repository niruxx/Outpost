# Host storage

**Storage** appears in the left sidebar for administrators and users with an explicit host-storage permission. The first account created by setup is an administrator and has full storage access by default. There is no separate owner role; all current administrators have these defaults.

This is Linux host administration, separate from instance file access and instance backup permissions. Windows and macOS display an unavailable message and do not run disk-management commands.

## Grant access

Open **Users → Edit user → Host storage permissions**:

| Permission | Allows |
| --- | --- |
| View disks | Inventory, filesystems, mountpoints, relevant fstab entries and recent operation results. |
| Mount / unmount | Mount a filesystem now or unmount a non-protected filesystem. |
| Boot mounts | Create, update or remove Outpost-managed UUID entries in `/etc/fstab`. |
| Format filesystems | Create ext4, XFS, Btrfs, FAT32 or exFAT filesystems. |
| Wipe signatures | Remove filesystem/partition-table signatures from an unmounted disk or partition. |
| Initialize GPT | Initialize an empty disk with GPT and one whole-disk Linux partition. |
| LUKS encryption / passphrases | Create, unlock/lock and change LUKS passphrases. |
| LVM management | Manage physical volumes, volume groups, logical volumes, pools and snapshots. |
| Resize storage | Supported partition/filesystem resizing; also required alongside encryption/LVM for their resize operations. |

Any change permission also grants viewing. A combined “mount now and at boot” operation requires both Mount and Boot mounts, checked again when the operation starts. API keys cannot mutate host storage, even writable administrator keys. Permissions and administrator status come from the current database account, so revocation and demotion apply to existing sign-ins.

Grant change permissions only to trusted host operators: these are host-wide capabilities, not limited to assigned game instances. Users may need to refresh the page after being granted access for the sidebar to update.

## Linux host prerequisites

The host needs util-linux tools (`lsblk`, `findmnt`, `mount`, `umount`, `wipefs`, `sfdisk`, `flock`). Install the matching filesystem tools for the formats you intend to use: e2fsprogs, xfsprogs, btrfs-progs, dosfstools and/or exfatprogs. Availability of filesystem drivers is also a host requirement. `udevadm settle` is used when available after metadata changes. Hosts using systemd reload mount units after an fstab update.

If Outpost already runs as root, it uses its built helper directly. You do not need to change the whole panel to run as root. For an unprivileged service account, install the **standalone root-owned helper** after building:

```sh
npm run build
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 server/dist/services/storageHelper.js /usr/local/libexec/outpost-storage-helper.mjs
```

Use a root-owned system Node.js binary, normally `/usr/bin/node`. Add an exact rule through `sudo visudo -f /etc/sudoers.d/outpost-storage`, substituting your actual Outpost operating system account:

```sudoers
outpost ALL=(root) NOPASSWD: /usr/bin/node /usr/local/libexec/outpost-storage-helper.mjs
```

This rule authorizes the fixed helper command, without arbitrary Node arguments or shell commands. The helper uses only Node builtins; no dependency directory needs to be copied. Its file, Node executable and every canonical parent directory must be root-owned and not group/world writable. A user-owned NVM Node installation is not suitable for this sudo rule. If you use different root-owned paths, set `OUTPOST_STORAGE_HELPER` and `OUTPOST_STORAGE_NODE` and update the sudo rule to match those canonical paths.

Reinstall the helper from the newly built file when Outpost's storage implementation changes. The service passes only a validated operation and known panel/backup paths through JSON stdin. It strips service environment variables from the privileged process, and the helper runs a fixed list of commands with argument arrays rather than shell interpolation. The helper rechecks the disk inventory independently before writing anything.

Test with the Storage inventory first. Installing this helper does not grant panel users storage permissions automatically.

## Mounting and boot mounts

Select a filesystem and choose **Mount**. Use an empty dedicated folder under `/mnt`, `/media` or `/srv`, for example `/mnt/outpost/backups`. The helper creates missing folders as root. Existing folders and parents must be root-owned directories, without symlinks or group/world write access. Outpost refuses to cover an existing mount or nonempty folder. Mounted filesystems use `nodev,nosuid` and can be mounted read-only.

Select **Also mount at boot** or use **Boot mount** separately to save an fstab entry. Entries use `UUID=...`, escaped mount paths, `nofail,nodev,nosuid` and an Outpost ownership comment. Existing unrelated lines/comments are preserved. Before replacement, the helper verifies a temporary fstab using `findmnt`, creates an `/etc/fstab.outpost-*.bak` backup, checks that the original did not change concurrently, and atomically replaces it. Files are flushed before committing. A failed combined mount attempts to restore the original fstab.

Only Outpost-managed fstab entries are editable through this UI. Existing manually configured entries are shown but left intact; use the host console or OS tools to manage those. Boot-mount changes do not remount an already mounted filesystem immediately. Unmounting keeps its boot entry; turn that entry off explicitly before formatting/wiping. UUIDs must be unique. Advanced mount options, network filesystems and arbitrary raw fstab editing are not included.

To use a mounted drive for game backups, create a writable backup base folder on it and select that path under an instance's **Configuration → Backup storage**. See [backup storage](backup-storage.md). Mounted drives backing active Outpost/backup paths are protected from storage mutations; change those paths before attempting to detach or repurpose the drive.

## Formatting, wiping and partitioning

Every action starts with a short-lived review bound to the current user and device fingerprint. Formatting, wiping and GPT initialization require typing `ERASE /dev/<device>`. A review is single-use and expires after two minutes. The backend checks live permissions again, then the privileged helper rereads device identity, size, serial/WWN, kernel disk sequence, mounts and protection state. A changed device/state invalidates the action.

The helper blocks system/boot and Outpost data disks, read-only devices, mounted filesystems, active swap, and disks with device-mapper/LVM/RAID holders. System/Outpost protection applies to the entire reported disk tree, including sibling partitions. Filesystems with existing persistent mount references must have those entries removed first. Storage paths on Btrfs/subvolume mounts are also considered when protecting devices.

- **Format** acts on an unmounted partition, or an unpartitioned disk, using the selected installed filesystem tool and optional label.
- **Wipe signatures** clears filesystem signatures and partition tables, processing unmounted child partitions before their disk. This makes data inaccessible but **does not overwrite all sectors or provide secure erasure**.
- **Create GPT partition** initializes a disk without existing partitions/filesystem and creates one Linux partition using the disk. Refresh inventory, select the new partition, then format it.

There is no forced/lazy unmount or automatic swap disabling. Operations run as background jobs and serialize behind a kernel `flock`, including across Outpost restarts. A running action can finish after its browser closes or Outpost restarts; its lock continues to block other disk mutations. The page polls inventory and running-state checks every five seconds. Recent job results are held for the current panel process; start/completion/failure audit entries persist. Failed or interrupted destructive operations may have partially applied: inspect the device before retrying. Do not disconnect a disk during an operation.

The Storage page also supports [LUKS, LVM and supported resize workflows](advanced-storage.md). This is not full Cockpit parity: RAID/iSCSI, arbitrary layered shrinking, SMART tests and secure whole-disk erasure remain outside this UI. Reinstall the updated privileged helper and install the required crypto/LVM/filesystem tools before using the new controls.

## Verification

```sh
npm run build
node server/test/storage.mjs
```

The regression uses simulated Linux inventory, in-memory fstab text and captured command arguments. It exercises protected disks, swap/holders, device replacement, format/wipe/GPT command construction, fstab preservation/rollback, delegation, API-key rejection and revoked permissions. **It does not format, mount, wipe or repartition real devices, or write the real `/etc/fstab`.** Real-host verification should use disposable Linux VM disks after installing the helper.

References: [Cockpit storage internals](https://docs.cockpit-project.org/cockpit-guide/latest/guide/features.html), [lsblk](https://man7.org/linux/man-pages/man8/lsblk.8.html), [fstab](https://man7.org/linux/man-pages/man5/fstab.5.html), [wipefs](https://man7.org/linux/man-pages/man8/wipefs.8.html).
