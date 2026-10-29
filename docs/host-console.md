# Host console

Open **Administration → Host Console** as an administrator, select an OS account and click **New session**. Each session starts a fresh real pseudo-terminal on the Outpost host, outside instance directories and instance permissions. Interactive tools, shell history, tab completion, Ctrl+C, terminal resizing and full-screen programs work through the browser terminal.

## Accounts

- **Service account** runs with the account and privileges of the Outpost process. Unix uses that account's login shell, falling back to bash/sh if the account's shell is disabled. Windows opens Windows PowerShell with the existing service account token.
- **Root** on Unix uses `su - root` when Outpost already runs as root; otherwise it uses `sudo -i -u root`. The host's sudo policy decides whether access is allowed and may prompt for the OS password inside the terminal.
- **Named operating system user** uses `su - <user>` when Outpost is root, or `sudo -i -u <user>` otherwise. This is a host OS username, not an Outpost username.

Outpost does not grant sudo rights, store OS passwords, change sudoers, or elevate Windows through UAC. Root/named-user selectors are unavailable on Windows. The account's home directory is used rather than a game instance's directory. This console manages the machine or container where Outpost runs; it does not enter a remote libvirt hypervisor automatically.

## Missing dependencies and automatic repair

If the native backend is unavailable, **Host console dependencies** opens once and remains accessible through **Dependencies & automatic repair**. It explains the platform prerequisites, displays the exact repair commands and shows the installation directory. Status checks load node-pty in a fresh child process so an earlier missing-module result cannot remain cached after a successful repair.

**Install / repair automatically** restores optional dependencies with install scripts disabled, then explicitly rebuilds only node-pty with scripts enabled. The project's `allowScripts` policy approves node-pty specifically for npm versions that enforce script approval. It does not run a general dependency upgrade or grant sudo rights. The background job displays its stage, bounded output and failures, and verifies that the new native backend can load. Reopening the popup shows the latest job. Network access to the configured npm registry and service-account write access to the Outpost installation are required.

On supported Linux families, an optional checkbox first installs the fixed build prerequisites:

- Debian/Ubuntu: `apt-get install -y python3 make g++ build-essential`.
- Fedora/RHEL: `dnf install -y python3 make gcc gcc-c++`.
- Arch: `pacman -S --needed --noconfirm python base-devel`.

OS package installation requires root or existing passwordless sudo for the displayed command. Repository configuration and package databases must already work; Outpost does not perform an unattended full-system upgrade. Without that authority, install the shown packages using the host's normal administrator workflow, leave the checkbox off and retry the npm repair.

On Windows, repair restores/rebuilds the packaged ConPTY backend. A matching prebuilt backend may work without a compiler. If compilation is required, the popup lists Python 3, Visual Studio 2022 Build Tools/Desktop C++, Windows SDK and matching Spectre libraries. Those OS developer tools require their normal Windows installer; this button does not elevate through UAC or silently install Visual Studio. Restart Outpost after changing the service's compiler/Python environment and retry. macOS similarly requires Xcode command-line tools installed through the native host workflow. Compiler installations are not automated on unsupported platforms.

These repairs require a current interactive administrator session and are audited. API keys cannot start them. They do not open a shell, install an SSH service, change the host's sudo policy or restart unrelated terminal sessions. A build affecting a module already loaded by an active PTY may be refused by the OS; close those sessions and retry if necessary.

## Session lifetime

Use **End session**, exit the shell, close the tab or navigate away to close its PTY. Connections are not automatically reattached or restarted: **New session** always opens a fresh shell. Up to two sessions per administrator and eight total are allowed. A session ends after 30 minutes without keyboard/paste input or eight hours total. Disconnected browser connections are detected by a heartbeat. Outpost shutdown closes active terminals.

Closing a terminal ends the shell and its ordinary attached jobs. Programs deliberately detached with tools such as `nohup`, `tmux`, or a service manager can continue running under the operating system.

The audit log records session opens/closes and the selected account, not terminal input or output. Passwords entered into sudo are passed to the PTY without being saved by Outpost; the host's own sudo/audit policies still apply. Standard shell history behavior belongs to the selected OS account.

## Access and transport

Only currently active Outpost administrators with a normal panel sign-in may open terminals. API keys, including writable admin keys, are rejected. Administrator status is rechecked on input and every 15 seconds. Demotion/deletion or token expiry ends the connection. Each WebSocket connection consumes a random, single-use ticket valid for 30 seconds, obtained through an authenticated POST; the long-lived panel session token is not placed in its URL.

WebSocket requests must have the same origin host as the HTTP request. Configure reverse proxies to preserve the browser's original `Host` header and forward WebSocket upgrades on `/ws/host-terminal`. If your proxy intentionally rewrites Host, set `OUTPOST_TERMINAL_ORIGIN` to the exact browser-facing origin (for example `https://panel.example.com`) and restart Outpost. Do not use a wildcard. Existing `/ws/console/*` instance consoles remain separate.

Output uses bounded flow control between the PTY and browser to prevent a fast program from filling unbounded output buffers. The display keeps 5,000 scrollback lines. **Clear display** clears the display only; it does not stop a command or end the shell.

## Installation and verification

Run `npm install` with optional dependencies enabled. `node-pty` is optional so its native build failure does not prevent game management or the rest of the panel from starting. If **Host Console** reports that its backend is unavailable, install your platform's native build prerequisites and run `npm rebuild node-pty`. Package managers that restrict native lifecycle scripts must allow node-pty's build scripts. Do not install with `--omit=optional` if you need terminals.

Linux/macOS source builds generally need Python, make and a C/C++ compiler; Windows source builds need Python and Visual Studio's C++ build tools. See [node-pty's platform prerequisites](https://github.com/microsoft/node-pty#dependencies). Browser terminal dependencies are bundled locally and do not use a CDN.

```sh
npm run build
node server/test/host-terminal.mjs
```

The terminal regression test uses an isolated temporary database. It opens a real service-account shell, prints a harmless marker, exercises resize/output, and checks one-use tickets, origin checks, API-key rejection and demoted-account rejection. It never requests root or changes host configuration. Root and named-user switching should be checked separately on a disposable Unix host with the intended sudo policy.
