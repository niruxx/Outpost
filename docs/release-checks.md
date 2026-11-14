# Release resilience checks

Run the required browser/API gate from the repository root:

```sh
npm ci
npm run test:release
```

This builds the production server and web app, then runs the actual UI against a disposable, loopback-only Express/WebSocket fixture. The fixture uses Outpost's real authentication, file-transfer, backup and job APIs. Host data and faults are simulated; no installed game, host service, real instance or production database is modified.

Chrome/Chromium is required. The runner discovers common Chrome/Edge paths on Windows, Linux and macOS. Set `OUTPOST_TEST_BROWSER` to an executable when necessary. Missing browsers and runtime JavaScript exceptions **fail** the gate; browser checks are never silently skipped.

For example, in PowerShell:

```powershell
$env:OUTPOST_TEST_BROWSER = 'C:\path\to\chrome.exe'
npm run test:release
```

## Coverage

| Check | Required assertions |
| --- | --- |
| Host tab navigation | 32 normal desktop transitions, 24 rapid transitions and all eight host tabs on a 390px viewport. Headings and loaded/error content must have dimensions and visible, opaque ancestors. Checks do not rely only on text existing in the DOM. Mobile content must not overflow horizontally. |
| Instance navigation | Six cycles through console, backups, scheduled tasks and files. The page remains usable and leaving the console closes its socket rather than accumulating subscriptions. |
| Reconnects | Three forced WebSocket disconnects followed by an offline/online cycle. The console must reconnect, display fresh history and avoid duplicate history/subscriptions. |
| Slow/failing networks | Browser latency and bandwidth throttling plus a delayed file read. The global activity indicator appears and settles; controls stay visible. A forced HTTP 503 is displayed, and returning to the page reloads successfully. |
| Large uploads | A deterministic **64 MiB + 17 byte** file goes through the browser upload queue under network throttling. The fixture commits a chunk but drops its acknowledgement, then returns 503s until automatic retries fail. Partial data stays outside the instance. Reload/reselection resumes at the durable offset, completes at 100%, and the published file's full SHA-256 matches. Repeating completion is idempotent. |
| Upload limits | A 1 GiB manifest is accepted, a 1 GiB + 1 byte manifest is refused, and an oversized 1 MiB + 1 byte chunk returns 413 without advancing its offset or publishing a file. The 1 GiB boundary check uses metadata; it does not pretend to transfer a full 1 GiB file. |
| Background job failures | Failed and interrupted jobs remain reviewable after navigation/reload. Credential redaction is checked. A failed explicit backup retry reports its error; a subsequent retry runs the real backup API and records one completed job without erasing the original failure. Startup recovery uses the real persisted-job recovery function. |

The lost-acknowledgement test also returns valid 503 responses because Chromium may transparently retry an idempotent PUT after a connection break. This makes the intended outage and exhausted retries deterministic across browser versions.

## Results and diagnostics

Outputs are written to `artifacts/release-checks/` (ignored by Git):

- `report.json`: pass/fail results, case durations, Node/browser/OS versions, Git revision and dirty-tree flag, transferred byte counts and recovery details.
- `host-tabs-mobile.png` and `job-recovery.png`: successful UI checkpoints.
- `browser-failure.json` and `browser-failure.png`: page text, runtime exceptions and screenshot when a browser check fails.

Each run replaces its own known artifact filenames so stale failure files are not mixed with a successful run. Failed cases return a nonzero exit code. Setup failures are failures too; a report cannot say the suite passed just because earlier cases passed.

`npm run test:release:checks` runs the same gate without rebuilding. Use it only after building the current source. `OUTPOST_RELEASE_UPLOAD_MIB` permits 8–256 MiB for local debugging or larger runs; the default and CI use 64 MiB. `OUTPOST_RELEASE_ARTIFACTS` selects another artifact directory. `OUTPOST_TEST_BROWSER_NO_SANDBOX=1` is available for an isolated CI runner that cannot start Chrome's sandbox; do not use it for normal browsing.

## Continuous integration

The [release-checks workflow](../.github/workflows/release-checks.yml) runs on pull requests, main/master pushes, version tags and manual dispatch. It builds and tests on Ubuntu 24.04 and Windows Server 2022 using Node 22, and preserves reports/screenshots for 14 days even when checks fail. Browser versions are recorded because runner images update over time.

To require these checks before merging, add both `Browser resilience` matrix jobs to the repository's branch rules. Adding the workflow does not change branch protection or publish a release automatically.

This gate tests panel resilience. It does not certify live game installations or every browser/host OS. Live-installation verification and the game/version/OS capability matrix remain separate roadmap items.

CI references: [Ubuntu runner software](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md), [Windows runner software](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md), [setup-node](https://github.com/actions/setup-node), [artifact retention](https://github.com/actions/upload-artifact).
