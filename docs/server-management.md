# File structure and server management

Print this guide without installing anything:

- Linux/macOS or Git Bash: `./install.sh --guide`
- Windows PowerShell: `.\install.ps1 --guide`
- Command Prompt: `install.cmd --guide`

The same `--guide` option works on the root update/uninstall launchers.

## What lives where

| Path | Purpose |
| --- | --- |
| `install.sh`, `update.sh`, `uninstall.sh` | OS-detecting Bash launchers |
| Root `.ps1` / `.cmd` launchers | Windows PowerShell / Command Prompt entry points |
| `dist/linux/` | Linux installation, update and uninstall scripts |
| `dist/macos/` | macOS installation, update and uninstall scripts |
| `dist/windows/` | Windows PowerShell installation, update and uninstall scripts |
| `scripts/` | Shared installer helpers and checks |
| `server/src/`, `web/src/` | Backend and frontend source |
| `server/dist/`, `web/dist/` | Generated app build output; separate from the root platform scripts |
| `server/data/outpost.db` | Accounts, instance settings and panel database |
| `server/data/servers/<instance-id>/` | Minecraft/server files and worlds |
| `server/data/backups/` | Default instance backups |
| `server/data/runtimes/<major>/` | Managed Java versions |
| `../outpost-update-backups/` | Host updater data archives and rollback information |

The data root defaults to `server/data`; `DATA_DIR`, `OUTPOST_DATA_DIR` or the legacy `MULTICRAFT_DATA_DIR` can override it. Relative data paths resolve from `server/`. Check your configured instance backup paths too. Stop Outpost before making a manual filesystem copy of its live database/worlds. Keep the data directory when rebuilding or reinstalling.

## Panel service versus game instances

The OS service runs the Outpost panel. Use the browser at `http://localhost:8642` to create individual instances and use their Start, Stop, Restart, Console, Files and Backups controls. Stopping/restarting the panel can also interrupt running game servers; save and stop instances first. Never run a foreground panel and a background panel against the same data directory at once.

On macOS the current supported installation target is Minecraft Java. Containers, SteamCMD/Wine and broader host features remain planned; visible menu entries are not a compatibility guarantee. Choose a Minecraft version and let Outpost select the matching managed Java runtime, or select one in the instance's Java settings. Java 16 is legacy and may not be available for every architecture.

## macOS (launchd, per login user)

```bash
./install.sh                  # install/build and offer a login agent
./update.sh                   # data backup, fast-forward pull, rebuild
./uninstall.sh                # remove agent/build output; retain data by default
launchctl print "gui/$(id -u)/com.outpost.panel"  # inspect service
launchctl bootout "gui/$(id -u)/com.outpost.panel" # stop and unload
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.outpost.panel.plist" # start after bootout
launchctl kickstart -k "gui/$(id -u)/com.outpost.panel" # restart a loaded agent
tail -f "$HOME/Library/Logs/Outpost/outpost.log"
curl --noproxy '*' -fsS http://127.0.0.1:8642/api/health
```

Use the configured port if it differs from 8642. The agent starts after this user logs in, not before login. `caffeinate -i` is optional during installation: it prevents idle system sleep while Outpost runs, but does not guarantee operation with a MacBook lid closed. The SQLite experimental warning from Node 22 is informational; it does not by itself indicate a startup failure. A listening log line shows the server started; use the HTTP check above to confirm it answers now. If it fails, inspect the launchd status and current log rather than assuming a folder-permission problem.

### Node.js commands on macOS

The installer reuses compatible Node.js or puts its official prebuilt runtime in `~/.local/share/outpost/node/node-v22.<version>-darwin-<architecture>/bin`. It can add that path to `~/.zprofile`. Open a new Terminal window or run `source ~/.zprofile` after accepting that option. The launchd agent uses the absolute Node path, so it does not rely on loading your shell profile.

```bash
command -v node
node --version
npm --version
node -p 'process.platform + " " + process.arch'
node -e 'console.log("Node.js is working")'
```

If you declined the profile change, enable the installed runtime in the current Terminal:

```bash
for node_bin_dir in "$HOME"/.local/share/outpost/node/node-v22.*-darwin-*/bin; do
  if [[ -x "$node_bin_dir/node" ]]; then export PATH="$node_bin_dir:$PATH"; fi
done
hash -r
node --version
```

From your Outpost checkout:

```bash
npm run setup                 # install project dependencies
npm run build                 # compile server and web app
npm start                     # foreground panel; Ctrl+C stops it
npm run dev                   # developer API/UI watch processes
```

Stop the launchd agent and game instances before running another panel or rebuilding. After a manual build, start the existing agent again with `launchctl bootstrap` (if unloaded), or use `./install.sh --no-java` to regenerate its configuration. Node.js does not replace Java: Node runs Outpost, and Java runs Minecraft instances. For Java discovery and selection, use Outpost's Java runtimes screen; a managed JDK can be checked directly with `server/data/runtimes/21/Contents/Home/bin/java -version`.

### macOS temperature sensors

Outpost reads CPU/GPU Celsius values through the optional [smctemp](https://github.com/narugit/smctemp) helper, whose upstream supports Intel and Apple Silicon. No Homebrew or privileged daemon is required by Outpost. Sensors depend on your model/macOS version; missing, zero, malformed or timed-out readings are omitted. This provider does not expose RAM, drive, fan-speed or thermal-limit readings, and does not change fan settings.

To build the small helper with the Xcode command-line tools already used by the installer:

```bash
mkdir -p "$HOME/.local/share/outpost" "$HOME/.local/bin"
git clone https://github.com/narugit/smctemp.git "$HOME/.local/share/outpost/smctemp-src"
make -C "$HOME/.local/share/outpost/smctemp-src"
install -m 755 "$HOME/.local/share/outpost/smctemp-src/smctemp" "$HOME/.local/bin/smctemp"
"$HOME/.local/bin/smctemp" -c
"$HOME/.local/bin/smctemp" -g
```

If the source folder already exists, use it instead of cloning again. These commands build a third-party helper from its upstream repository; review the source/release you choose. Outpost discovers `~/.local/bin/smctemp`, `/usr/local/bin/smctemp`, `/opt/homebrew/bin/smctemp` and executables on its service PATH. Open **Host overview → Temperatures** to see readings; its cache refreshes on the next dashboard poll. GPU availability may differ from CPU availability.

For another location, set `OUTPOST_SMCTEMP_PATH` to the absolute executable path in the panel's environment. For launchd, add it under `EnvironmentVariables` in `~/Library/LaunchAgents/com.outpost.panel.plist`, then bootout/bootstrap the agent. Rerunning the installer regenerates the plist; using a standard helper location avoids needing a custom environment entry. Run helper checks as the same user as the login agent. Outpost never invokes `sudo` for sensors.

## Linux (systemd, if enabled during installation)

```bash
./install.sh
./update.sh
./uninstall.sh
sudo systemctl status outpost
sudo systemctl stop outpost
sudo systemctl start outpost
sudo systemctl restart outpost
journalctl -u outpost -f
```

For manual/pm2 deployments use the process manager you selected, such as `pm2 restart outpost`, or `npm start` from the checkout. Linux retains distro-specific dependencies, container/Wine options and richer backup/rollback/uninstall options; see each command's `--help`. Temperature collection uses Linux hwmon/thermal sysfs.

## Windows (per-user scheduled task)

```powershell
.\install.ps1
.\update.ps1
.\uninstall.ps1
Get-ScheduledTask -TaskName 'Outpost Panel'
Stop-ScheduledTask -TaskName 'Outpost Panel'
Start-ScheduledTask -TaskName 'Outpost Panel'
```

Restart by stopping then starting the task. The generated `state/windows-launch.ps1` records the panel's runtime, working directory, port and data path. Task Scheduler shows task status and last-run results. Stop the task before running `npm start` in a Terminal for console troubleshooting. Root `.cmd` wrappers work from Command Prompt and invoke PowerShell with a process-scoped execution policy. Windows setup uses WinGet for missing Node.js/Java packages; see `--help` for current options. Native Windows temperature sensors are not implemented.

## Removal and backups

macOS/Windows uninstallers keep data, shared Node.js/Java installations and update backups by default. Their `--purge` option requires typing `delete`; data outside the checkout is retained for manual cleanup. Linux's `--purge` has broader package/checkout removal semantics. Read the platform's `--help` before using destructive options. Never delete the root `dist/` directory as build cleanup: it contains the platform management scripts, unlike `server/dist/` and `web/dist/`.
