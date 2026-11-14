# Malware scanning, live mod monitoring and upload protection

Open **Configuration → Operations → Antivirus** as an administrator. Instance-specific reports are also under **Instance → Configuration → Malware protection**. Settings apply to the local Outpost host; configure each linked host separately.

## Installation and activation

Outpost uses the OS-installed **ClamAV `clamscan`** engine and **FreshClam** updater. No files are submitted to an external scanning service. ClamAV was chosen for local, cross-platform file and archive scanning; this integration does not install a kernel-level real-time antivirus driver.

Install current packages using the [ClamAV platform instructions](https://docs.clamav.net/manual/Installing/Packages.html). For example, Debian/Ubuntu use `sudo apt install clamav clamav-freshclam`; Fedora uses `sudo dnf install clamav clamav-update`; macOS uses `brew install clamav`. Windows installations need absolute paths to `clamscan.exe` and `freshclam.exe`, plus a configured signature database. Some packages need additional archive support, particularly RAR.

Configure FreshClam and initialize the signatures as described in [signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html). Prefer the distribution's automatic FreshClam service. The panel's **Update signatures** runs a single update using the saved executable and optional database directory; it may fail if another updater holds the database or the Outpost account lacks permission. Do not grant blanket sudo access to work around that: use the OS updater service and give Outpost read access to signatures instead.

Save executable/database paths with protection disabled, then choose **Check saved scanner**. Enabling protection also runs a real readiness scan and refuses to enable if the engine or signatures are unavailable. Signatures older than seven days cause scans to fail. Empty database directory means ClamAV's OS default. Executables accept the standard command name or an absolute path, without shell arguments. Outpost invokes them without a shell.

Protection starts disabled because Outpost cannot assume ClamAV is installed. Run a baseline full scan on existing instances after activation.

## Protected ingestion

With upload scanning enabled, the integration covers:

- Instance file uploads and file-manager text writes; multipart file batches must all pass before any file is published.
- Plugin/mod/addon uploads, TF2 content, game map/world/save uploads, Minecraft modpack uploads, and custom banner uploads.
- Host file-manager uploads and text writes.
- Environment archive uploads, backup restores, and incoming node transfers before they become ready.
- Built-in SFTP uploads, including overwrites: bytes remain in private staging until the close-time scan succeeds. Existing files survive rejected uploads. SFTP clients must wait for successful close; premature disconnects discard open staged uploads.
- Plugin files installed through the `installPluginFile` download path, staged before replacing the destination.
- Modrinth/CurseForge modpack archives and their separately downloaded mod files are checked before extraction/publication, including uploaded modpacks that reference remote JARs. CurseForge Bedrock catalog downloads also pass the buffer upload gate.

ClamAV scans supported archive contents. Encrypted archives and scan-limit alerts are blocked because their safety cannot be established. Uploads are restricted to 1 GiB each under protection; larger environment imports that were previously accepted require an alternative trusted administrative migration workflow. Scan limits are 1 GiB per file, 2 GiB expanded content per scan object, 30 archive recursion levels and 10,000 extracted members. The engine's own format and implementation limits still apply. Unknown file formats and malware without matching signatures may not be detected.

A detection returns HTTP 422. Missing/unusable scanners, old signatures, warnings/errors, queue exhaustion and timeouts fail closed with an error; Outpost never silently accepts those uploads as clean. Upload progress reaches 100% when transmission finishes, then remains in processing while scanning and installation finish. Some routes still buffer uploads in memory before staging; enforce reverse-proxy upload/body and connection limits on untrusted deployments.

Scans are serialized to limit resource usage, with at most eight active/queued scan tasks. Individual upload scans have a ten-minute timeout; full instance/import scans have a thirty-minute timeout. A large full scan can delay uploads. An installed ClamAV daemon is not used by this version.

## Reports, schedules and response

Choose an instance and **Scan instance now**, or save a five-field cron schedule. The panel displays the host's timezone; `0 3 * * *` means daily at 03:00 in that timezone. Schedules persist in SQLite and are reloaded on restart. Only one scan per instance can be queued/running at once. Scans can run while upload protection is disabled, provided the scanner is configured. Cancellation and failures are recorded distinctly from clean results. Jobs also appear in Job center, with indeterminate progress rather than an invented percentage. Unfinished scans are marked interrupted after a panel restart.

Full scans are non-destructive: findings list paths and signatures without moving/deleting active game files. They skip symlinks and are a live filesystem scan, not a consistent snapshot. Stop an instance first when a stable scan is needed. Detections set a security hold that blocks all new starts, including automatic starts/restarts, until a complete clean instance scan succeeds. Updating signatures and resolving the affected files is the recovery path; disabling upload protection does not clear a hold. The optional **Stop running instances** policy requests a normal stop when findings occur. A normal stop does not guarantee immediate termination of a hostile process.

Alerts appear in the panel notification log for blocked uploads, findings and incomplete scans. The scan history shows the latest 200 scans host-wide and 100 per instance. Administrators control settings, scans, schedules and quarantine deletion; assigned users can view their accessible instance's reports and protection state.

## Live mod and plugin monitoring

Enable **Monitor mod and plugin folders continuously** alongside upload protection, then save. The monitor checks existing mods when enabled and after restart, watches native directory events, and reconciles the inventory every five seconds so missed events and newly created folders are picked up. Files must remain stable for at least 1.5 seconds before being copied into private scan staging. Changes made while a scan is running are picked up on the next pass. Scanner queueing can increase detection latency.

Coverage includes the instance's game-specific add-on profile and known `mods`, `plugins`, `addons`, `BepInEx`, Bedrock behavior/resource packs, datapacks, Source game add-ons, Palworld Paks, Conan/ARK/Squad mod folders and Steam Workshop content under the instance. This is deliberately focused on mod content rather than continuously rescanning world/chunk and log writes. Symlink paths and external mounts are excluded. Uploaded JARs, ZIPs and supported nested archive content still pass the publication gate even when monitoring is disabled.

Reports identify the source as `realtime`, show scanned mod filenames and findings, and appear in Job center. Detection sets a security hold and uses the existing optional stop-on-detection policy. Live monitoring does not delete or move the original external file: review the report, resolve the mod, then run a full clean instance scan to clear the hold. A clean scan of one changed mod cannot clear a whole-instance hold. The Mods/Plugins page displays whether upload scanning and live monitoring are enabled.

The host Antivirus page shows tracked files, native watchers, scan activity, last scan time and errors. At most 256 native directory watchers are used; other directories continue through polling. Inventory is bounded to 30,000 entries and 30 directory levels across the host. Batches contain at most 16 files and normally up to 128 MiB (one larger file may use the existing 1 GiB file allowance). Unchanged fingerprints are not repeatedly rescanned. Scanner/inventory errors are visible and retried after 30 seconds rather than being recorded as clean. Disabling monitoring closes its watchers and cancels its active scan.

This is detection **after a filesystem write**, not an OS file-access barrier. A game or external tool may load a file before the user-space monitor detects it. The upload gate is the stronger guarantee for panel/SFTP uploads because it scans before publication. For Linux kernel-level on-access prevention, use ClamAV's separately installed [clamonacc integration](https://docs.clamav.net/manual/OnAccess.html) with a properly configured `clamd`, exclusions and narrowly scoped instance paths. Outpost does not silently reconfigure system fanotify services or Windows Defender policies.

## Quarantine and storage

Blocked upload bytes are kept as randomly named, non-executable `.bin` files in `OUTPOST_DATA_DIR/antivirus`, outside instance folders. Metadata records the original name, signature, SHA-256, size and time. A two-GiB retained-byte cap prevents unlimited payload retention; further detections keep metadata only and discard their bytes. The panel offers permanent deletion, with no restore or download endpoint. False positives should be resolved with updated signatures and a fresh upload.

On POSIX systems the private directory/staging folders use mode 0700 and payloads 0600. On Windows, configure NTFS permissions so only the Outpost service account and administrators can access the data directory; POSIX mode bits do not establish Windows ACLs. Use Outpost's sandboxing and separate service accounts: a process sharing the Outpost account without isolation can access that account's files. Abandoned upload staging directories are cleaned on startup.

## Coverage limits

This is upload-time protection, live monitoring of mod folders, and manual/scheduled antivirus scanning. It does not block arbitrary OS writes, inspect process memory/network activity, inspect container image layers or external mounts, or guarantee a plugin/script is trustworthy. Files outside monitored folders and modifications after a clean scan need subsequent scans and OS controls. Keep game servers, mods, ClamAV and signatures updated; run untrusted instances with least privilege and isolation. Use the OS antivirus/on-access scanner for system-wide real-time coverage.

## Validation

`npm run build --workspace=server` and `node server/test/antivirus.mjs` exercise scanner failures, detection parsing, real Mods/JAR upload gating, HTTP editor gating, whole-batch protection, rejected overwrite preservation, quarantine, permissions, holds, cancellation, scheduling and real SFTP protocol transfers. Native filesystem events/reconciliation are exercised for initial mod inventory, out-of-band changes, unchanged-file caching, visible scanner errors, disabling monitoring and sticky holds. The subprocess scanner is a deterministic fixture using harmless markers; it does not prove detection effectiveness of a real ClamAV installation. Set `OUTPOST_TEST_BROWSER_UI=1` and `OUTPOST_TEST_BROWSER` for a Chromium-based panel/mobile check. Perform a real vendor-approved harmless test scan on the deployment after installing ClamAV.
