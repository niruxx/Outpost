# Instances across panel updates

New instance launches run under a detached supervisor. Stopping, restarting or updating the Outpost panel disconnects its console connection without sending a game stop command. On startup the panel reconnects before enabling schedules or automatic starts. The game retains its PID and uptime, and console input, output and statistics resume.

There is no setting to enable this behavior. Use the instance's **Stop** or **Restart** action when you intend to stop or restart the game. Stop all instances explicitly before uninstalling Outpost, deleting data, or making an offline world copy. Host reboot, game updates and game crashes can still interrupt play. Auto-restart policies are evaluated by the panel; if a game exits while the panel is offline, its exit and restart policy are processed when the panel returns.

## First update

An already running game cannot hand its existing console pipes to a new supervisor. Instances launched by older Outpost versions need one normal stop/start during the transition. Subsequent launches use supervision automatically.

The Linux installer and updater configure systemd to run Node directly with `KillMode=process`. This lets systemd restart the panel without killing the instance supervisors in its service cgroup. The updater writes a drop-in for the detected `outpost.service` or legacy `multicraft.service`. Custom process managers must also stop only the panel process, rather than terminating the entire descendant tree or cgroup. Never run two panels against the same data directory simultaneously.

## Console and runtime state

Each supervisor keeps a bounded recent-output buffer of approximately 2 MiB while the panel is disconnected. Reconnection replays output after the last recorded console sequence. Older output can be evicted during long or noisy outages; game-owned logs remain in instance folders. The supervisor retains stdin and enforces a requested graceful-stop timeout even if the panel disconnects mid-stop.

Private runtime files live under `server/data/instance-supervisors` (or the configured Outpost data root). They contain local connection credentials, process identity, launch settings and versioned worker code. On POSIX systems the root and instance directories use mode 0700 and metadata files use 0600. Windows deployments should restrict the data directory's NTFS permissions to the Outpost account and administrators. Do not copy runtime metadata to another host or delete it while games are running. Workers are copied outside build output so rebuilding `server/dist` does not replace active supervisors.

Reconnection authenticates against the local worker, rather than controlling a process solely by PID. If a worker is unreachable and its game might still be alive, panel startup fails instead of starting a duplicate. Inspect the panel logs and the host processes before removing stale runtime metadata. Fully exited supervisors are reconciled automatically.

## Update backups

The Linux updater stops the panel before backing up its database and settings; supervised games remain online. Runtime metadata and antivirus scratch files are excluded from updater archives. A full archive of live instance files is a best-effort copy: world files may change while tar reads them. The updater warns about changed files rather than treating that full archive as a consistent world snapshot. Use instance snapshot tools or explicitly stop a game when you need a consistent world backup. Settings-only backup failures and tar errors still abort the update.

Rollback to a panel version without supervisor support is refused while supervisor records are present, to prevent duplicate launches. Stop instances explicitly before performing that older rollback.

## Verification

Run `npm run test:instances`. The test launches a disposable game and restarts separate panel processes, checking graceful panel shutdown, forced panel termination, unchanged game PID and uptime, console reconnection, offline output, rejected unauthenticated connections, duplicate prevention, explicit game stop/restart, offline game exits and graceful-stop timeout enforcement. Existing game-customization and reliability-workflow tests cover startup commands and maintenance restart ordering. Native Linux systemd deployment should also be checked with `systemctl restart outpost` while observing a test instance's PID and console.
