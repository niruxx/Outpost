# UI workspace

## Dashboard

Open **Dashboard** in the workspace sidebar. **Customize dashboard** lets you show or hide six widgets: instances, host health, players, instance storage, recent backup jobs and recent failures. Drag cards to reorder them, or use their labeled earlier/later buttons with a keyboard or touchscreen. Layout saves to the signed-in account. Player totals exclude unavailable game queries. Storage uses the existing cached instance-directory measurements; it does not represent remote host disks. Backup and failure widgets show recorded job history.

## Saved views

On **Instances**, expand **Saved views, sorting, groups and columns**. Filter by name, status, category, game, owner and personal tag; sort by name, port or status; group by game, host, owner or first tag. Choose status, CPU, memory, player and uptime columns in list mode. Save named views to your account or copy a view link, including its layout and filters. A shared URL grants no access: the recipient sees their own authorized instances. Tags belong to each account, so tag filters use the recipient's own tags.

The instance list is local to the host in the URL; host grouping labels that host. Fleet operations across linked hosts are in **Configuration → Operations → Fleet bulk actions**.

## Persistent job center

**Job center** records new installs (including container image pulls), updates, full backups, inbound instance imports and outbound transfers. It stores stage history, percentages when the operation supplies them, timestamps and outcomes in SQLite. Indeterminate operations display an indeterminate progress indicator. Records survive reloads and panel restarts; unconfirmed operations are marked interrupted, never automatically replayed. The API returns the newest 300 records before applying instance visibility, and startup retains the newest 2,000 completed/interrupted records. Old activity is not backfilled.

Users see jobs only for accessible, unsuspended instances; administrators see all jobs, including deleted instances. Failed installs and backups offer a retry through existing permission and state checks. Failed updates link to the version page so the user can review the intended version. Transfers/imports require checking source and destination before starting another transfer. Stage logs are bounded to 100 entries and redact common credential patterns; full process output remains in the instance console.

## Fleet batches and configuration import

Administrators can select up to 100 instances across local and linked hosts for start, stop, restart, backup or configuration changes. Review the per-instance preview before applying. Configuration accepts a JSON settings object with `name`, `minMemoryMb`, `maxMemoryMb`, `autoStart`, `restartPolicy`, `restartDelaySec` and `restartMaxAttempts`. Unsupported fields and invalid values are rejected. Ports, credentials, executable arguments and game-specific settings remain in their existing instance editors.

Configuration preview checks memory ranges and restart policy and shows before/after values. Memory changes apply on next start. A configuration revision is checked again on apply; changed instances fail independently. Previews expire after 15 minutes. Stop/restart actions warn about disconnections. Successful power actions mean the operation was accepted; monitor the instance for final game readiness.

Batches run on the panel after navigation away, with a persistent per-instance result. Cancel stops remaining items after the current operation completes; individual filesystem operations are allowed to finish. **Preview failed items only** builds a new review without replaying completed items. A network failure to a remote host is marked uncertain and excluded from automatic retry, because its action may have completed. Inspect the destination before creating a new batch. Interrupted batches are also never replayed. Linked hosts must run a version with the workspace endpoints; node keys authenticate requests, and current administrator access is checked before each item. Batch history shows the latest 50 runs.

## Configuration review

Minecraft gamerules, TF2 settings, CS2 settings/presets and the other supported game settings validate through their server-side sanitizers without writes, then show a before/after diff before saving. Passwords and tokens are masked in the review. General instance settings and Minecraft properties also show a diff and restart guidance. Existing server validation and permissions still apply on the final save. The fleet JSON workflow provides settings import with validation and revision protection. Canceling a review makes no configuration write.

## Permissions and keyboard access

Administrators can use **Operations → Permissions inspector** to select a user and instance. The report explains account disablement, assignment, suspension, role defaults, explicit permission grants and individual configuration restrictions. It lists configuration overrides separately. Runtime state, resource limits and API key restrictions can impose additional request checks.

The command palette includes Dashboard, Job center, fleet bulk actions, permissions inspection and keyboard help. Search **Keyboard shortcuts** in the palette, or press `?` outside an editor. The reference is searchable. `Ctrl/⌘ K` opens the palette, `/` focuses page search, `Alt Shift D` opens Dashboard, and `Alt Shift J` opens Job center. `Ctrl/⌘ S` uses a marked visible configuration save control when exactly one is available. Single-key shortcuts pause in fields and terminals. Navigation shortcuts respect unsaved-change confirmation.

Shared dialogs now have accessible titles, initial focus, Tab/Shift-Tab focus loops, Escape handling and focus return. The shell has a skip-to-content link. Touch controls and table rows have larger targets, focus outlines cover summaries and custom controls, and reduced-motion settings stop progress sweeps. These changes improve shared components; they do not claim a full accessibility certification of every third-party editor.

## Verification

Run `npm run build`, `node server/test/ui-workspace.mjs` and the existing game control/customization tests. Set `OUTPOST_TEST_BROWSER_UI=1` and `OUTPOST_TEST_BROWSER` to a Chromium executable to exercise dashboard persistence, URL views, keyboard focus, dialogs, permissions inspection and mobile layout. Tests use disposable data and a fixture linked host, without launching games.
