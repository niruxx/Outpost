# Files, uploads and editing

The instance **Files** tab and the main **Files** page share these features. Host OS file browsing and SFTP retain their own transfer/delete behavior.

## Upload queue

Select files, select a folder, or drop folders onto the upload area. Relative file paths are preserved; empty folders are not transferred. Every file has its own percentage, state and result. Configure 1–4 concurrent uploads, an aggregate bandwidth target in KiB/s, and a collision policy before starting:

- **Skip existing** is the default.
- **Rename incoming** appends a numbered suffix.
- **Replace** moves the previous file into the recycle bin before publishing the replacement. Directories cannot be replaced by files.

Transfers use verified 1 MiB SHA-256 chunks, with durable offsets and private staging outside the instance. Pause stops at a verified chunk boundary. Network failures retry three times; use **Resume / retry** afterward. Cancel releases staging storage. Scanning/publication cannot be cancelled once it begins.

Pending transfers survive panel restarts and browser reloads for 48 hours. Reselect the original files/folder at the same destination to resume; file bytes are never kept in browser storage. A hash manifest prevents combining different files. A completed transfer can be queried/completed again without republishing. If the process crashes during final publication, the transfer is locked for inspection: check the destination and recycle bin before cancelling/re-uploading. The panel deliberately avoids blindly repeating an interrupted replacement.

Limits: 1 GiB/file, 32 pending transfers and 10 GiB reserved per user/instance, 30 GiB reserved across the panel. Expired metadata and staging are removed on access and by hourly housekeeping. Bandwidth pacing is shared across concurrent files in this browser queue; it is a target with chunk-sized bursts, not an OS-level network cap. Other tabs/users have independent targets. A secure browser context (HTTPS or localhost) is required for Web Crypto.

When antivirus protection is enabled, the assembled staging file must pass scanning before any content is published. Scanner failures block publication. Current account/access/configuration restrictions and disk policy are checked again after scanning. Publication uses a no-overwrite hard link, so the destination filesystem must support hard links. Existing multipart API clients remain supported.

## Recycle bin

Panel deletes and replaced upload destinations are retained for 30 days under the private `data/file-workspace/trash/<instance>` directory. Restore refuses to overwrite existing paths and scans the retained content when antivirus is enabled. Move/rename an existing destination first if necessary. Symbolic links and special files cannot be restored from the panel; leaf links may be recycled or permanently removed without following them. Directory restore is limited to 100,000 entries.

Retention is enforced hourly and when the bin is accessed. Permanent deletion requires confirmation. Recycle storage is separate from instance snapshots: keep normal backups. A recycle operation requires an atomic rename to the data volume; if an instance lives on a different filesystem, the operation fails while preserving the original file. SFTP and external OS deletes do not enter this bin.

## Search and editor

Search all files in an instance with literal, case-insensitive content matching, a filename substring and/or an extension filter. Results show the first matching line and open in the editor. Searches skip symlinks, binary files and content over 1 MiB; each request is capped at 10,000 entries, 32 MiB of content, 200 results and approximately 1.5 seconds. Narrow the filters when results are truncated. Search and content access require `files.read`; changes, transfer controls and restores require `files.write`. Transfer sessions also belong to the user who created them.

The editor validates JSON/MCMeta, YAML, TOML and XML. Properties/INI files receive basic assignment/duplicate-key diagnostics, with port-range checks. Other text files explicitly use plain-text mode. Schema hints show known settings/types/ranges/options for matching native game profiles and common Minecraft properties; these are guidance, not a complete game-version schema. Validation errors require explicit confirmation before saving.

**Format draft** formats JSON, YAML and TOML without saving. Review the draft before saving: TOML formatting removes comments and normalization can change layout. XML is validated but is not reformatted. The editor warns about unsaved changes and rejects saves if the file has changed since it was opened. Existing history and snapshot recovery remain available.

## Verification

```powershell
npm run build --workspace=server
npm run build --workspace=web
node server/test/file-workspace.mjs
node server/test/antivirus.mjs
```

Set `OUTPOST_TEST_BROWSER_UI=1` and `OUTPOST_TEST_BROWSER` to a Chromium executable to include mobile layout, folder upload, pause/resume and editor browser checks. Antivirus tests use a harmless fixture scanner, not installed ClamAV signatures.
