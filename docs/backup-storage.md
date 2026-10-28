# Per-instance backup storage

Open an instance's **Configuration → Backup storage** or **Backups → Backup storage**. An administrator can set an existing absolute directory on the Outpost host, such as `/mnt/backup-drive/outpost` or `D:\OutpostBackups`. Leave it blank to use the original Outpost data-directory layout.

The same setting covers:

- Manual snapshots, cron-scheduled snapshots and backups requested before an update.
- Off-site snapshots downloaded back to local storage, and the local source for uploads to S3/SFTP destinations.
- Manual, automatic and pre-restore World Rewind points.
- Safety copies of `level.dat` replaced through World Rewind and new CS2 plugin configuration undo copies.

The configured directory is a base. Outpost separates instances automatically:

```text
<selected directory>/<instance UUID>/
  .outpost-backup-store
  snapshots/
    backup-<timestamp>.zip
    file-undo/
      world-rewind/...
      cs2/...
  rewind/
    <restore-point ID>/...
```

With no override, snapshots remain in `<data>/backups/<instance UUID>` and World Rewind remains in `<data>/rewind/<instance UUID>`. File undo copies are under the snapshots directory's `file-undo` subfolder. Game-generated `level.dat_old` and other backups produced directly by a game/plugin still follow that program's own settings; Outpost does not redirect writes inside third-party programs. Older inline CS2 `.outpost.bak` copies remain readable as a compatibility fallback until a new undo copy is saved.

## External drives and permissions

Mount the drive and create its base directory first. Grant the operating system account running Outpost read, write and directory traversal access. Paths are resolved on that host, not the machine running your browser. In containers, bind-mount the drive and use the path visible inside the Outpost container. A shared base directory is supported: instance UUID subfolders keep archives separate.

Selecting arbitrary host paths is admin-only; ordinary users continue to create, view and restore backups according to their existing instance permissions. Demoted administrator sessions cannot change storage paths. Live instance directories and overlapping default backup/rewind directories cannot be selected, preventing backup recursion and conflicting layouts.

Outpost checks a marker in the configured per-instance folder before using it. If the drive disappears or the marker is missing, backup operations fail instead of recreating a backup tree on the system disk. Reconnect the drive and retry. The setting does not mount drives or keep an external disk powered on. Instance monitoring continues to work when backup storage is unavailable.

## Change locations without losing history

**Copy existing snapshots and World Rewind points before switching** is enabled by default. This copies the active snapshot tree (including file undo copies) and all restore points, and changes the saved setting only after copying succeeds. It uses file copies across partitions rather than directory renames. Modification times are preserved so retention order remains correct. World Rewind hard links are preserved where supported, with ordinary copies on filesystems such as FAT/exFAT that do not support them.

Originals are kept. Once you have checked the new location, you can remove the old copies yourself. Retention only prunes the currently selected location; originals left elsewhere are not automatically removed. Identical destination files may be reused after SHA-256 comparison. Conflicting files fail the change without overwriting them or switching the active directory. A failed copy may leave partial destination contents; retrying can reuse already completed identical files.

Changing storage is blocked while a backup, restore, off-site upload/download or environment export is using it. While a location change is copying, new backup operations receive a temporary error and can be retried. A scheduled job that fires during the change fails that run and resumes on its next scheduled run; it is not queued automatically.

Uncheck copying to switch without transferring history. Old files remain in the previous location and stop appearing in the active backup lists. This also allows returning to the default location when an external drive is disconnected. Returning to a previously used location displays the archives already there. To reinitialize a custom path whose marker was intentionally removed, switch to the default first, then select that custom path again.

## Environment exports and instance deletion

Whole-environment exports include the active custom snapshots and restore points in the archive's portable default layout. Import clears machine-specific backup-directory overrides and restores those archives under the destination Outpost data directory. Select an external path again after importing if desired. Export fails if an active custom drive is unavailable, rather than silently omitting its archives.

Deleting an instance removes that instance's active snapshots and rewind tree, not the whole selected base directory or other instances' backups. Copies retained at previous locations remain separate. Factory reset replaces Outpost's data directory; external backup folders are retained on their drives. Keep your external archives and a panel environment export when you need to recover the full setup.

## Verification

```sh
npm run build
node server/test/backup-storage.mjs
```

The regression uses isolated temporary directories and a local simulated S3 download. It checks copying, snapshot/World Rewind restore, file undo copies, retention chronology, hard links, missing-drive behavior, active-operation locks, conflicting archives, portable exports/imported paths, instance deletion and administrator authorization. It does not require or modify an actual external disk.
