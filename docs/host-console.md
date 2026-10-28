# Host console

Open **Administration → Host Console** as an administrator, select an OS account and click **New session**. Each session starts a fresh real pseudo-terminal on the Outpost host, outside instance directories and instance permissions. Interactive tools, shell history, tab completion, Ctrl+C, terminal resizing and full-screen programs work through the browser terminal.

## Accounts

- **Service account** runs with the account and privileges of the Outpost process. Unix uses that account's login shell, falling back to bash/sh if the account's shell is disabled. Windows opens Windows PowerShell with the existing service account token.
- **Root** on Unix uses `su - root` when Outpost already runs as root; otherwise it uses `sudo -i -u root`. The host's sudo policy decides whether access is allowed and may prompt for the OS password inside the terminal.
- **Named operating system user** uses `su - <user>` when Outpost is root, or `sudo -i -u <user>` otherwise. This is a host OS username, not an Outpost username.

Outpost does not grant sudo rights, store OS passwords, change sudoers, or elevate Windows through UAC. Root/named-user selectors are unavailable on Windows. The account's home directory is used rather than a game instance's directory. This console manages the machine or container where Outpost runs; it does not enter a remote libvirt hypervisor automatically.

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
