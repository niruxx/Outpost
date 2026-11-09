# Host administration

The **Host** section of the admin sidebar administers the machine Outpost runs on, in the style of Cockpit. It has these tabs: **Overview**, **Metrics**, **Services**, **Software**, **Accounts**, **Networking**, **Security** and **Diagnostics**. Services and Software have their own guide: [Services and Software](services-and-software.md).

## Access model

- **Who can use it:** active administrators with a normal panel sign-in. API keys are rejected.
- **Limited access:** reading runs as the Outpost service account.
- **Admin Mode:** every change needs Admin Mode for this browser session. Use the lock button at the top of the Host pages; for this host it's the same session as the top-bar button. Admin Mode starts a small privileged helper through sudo. The helper only runs a fixed list of operations and re-checks every argument, because it runs as root. See [Admin Mode](host-files.md#limited-access-and-admin-mode).
- **Auditing:** every change is recorded in the audit log under `host.*` or `panel.tls.*`.
- **Platform:** most features need Linux with systemd. Other hosts show what is unavailable and why.

## Overview

- Host name and pretty name, OS, kernel, hardware, CPU, memory, uptime and machine ID.
- **Time:**
  - Time zone.
  - NTP on/off and sync state.
  - NTP servers. With chrony, Outpost writes `outpost.sources` into the configured `sourcedir`. With systemd-timesyncd, it writes `/etc/systemd/timesyncd.conf.d/50-outpost.conf`. Empty restores the distribution default.
  - Setting the clock by hand when NTP is off.
- **Power:** restart or shut down now or after a delay, with a message for logged-in users. A scheduled action shows a banner with **Cancel it**. Restarting stops every instance, VM and container on the host.
- **Performance profile:** `tuned` profiles, with the recommended one marked.
- **Administration from linked panels:** see [Linked hosts](#linked-hosts).

## Metrics

Outpost records one row per minute for a week:

- **Host:** CPU, memory, load, network in/out and disk read/write.
- **Per service:** CPU, memory and disk I/O for the busiest services, read from the systemd cgroup tree (cgroup v2, with basic v1 support).

The page shows the last hour, 6 hours, 24 hours or 7 days. Red dots mark minutes more than three standard deviations above the average for the range shown; each series needs at least 30 points. Network traffic can't be attributed to services without eBPF, so it is host-wide only. Outpost samples these figures itself and doesn't use PCP.

## Accounts

- **Users:**
  - Accounts come from NSS (`getent`), with the last login from wtmp and whether the user is logged in now.
  - In Admin Mode you also see password state from `/etc/shadow`: locked, password set, expiry and must-change. Password hashes never leave the helper.
- **Create:** user name, full name, shell (from `/etc/shells`), optional password with "change at first login", and administrator rights (membership of `sudo` or `wheel`).
- **Edit:**
  - Full name, shell and groups.
  - Make or remove administrator.
  - Lock or unlock. Locking also expires the account, so SSH keys stop working too.
  - Set the password (passed to `chpasswd` on stdin).
  - Force a password change; password lifetime; account expiry date.
  - `~/.ssh/authorized_keys`: every line is checked, and the file is written with the user's ownership and `600` permissions. Symlinked home or `.ssh` folders are refused.
  - Delete, optionally with the home folder.
- **Groups:** create, delete and change membership.
- **Sessions:** list logind sessions and end them.
- **Protected accounts:** root, system accounts (uid below `UID_MIN`) and the account Outpost runs as can't be deleted, locked or have their passwords changed here.

## Networking

The page lists interfaces with their addresses, MAC, MTU and traffic. Changes go through NetworkManager (`nmcli`). On hosts using systemd-networkd, netplan or ifupdown without NetworkManager, the page is read-only.

You can:

- Edit a connection's IPv4 and IPv6 settings: automatic, manual addresses with gateway, DNS, or disabled. You can also set the MTU.
- Connect or disconnect a connection, choose whether it connects automatically, or delete the profile.
- Create a **bond** (active-backup, LACP and the other modes), a **bridge** (optionally with STP) or a **VLAN**.

**Rollback:** every change runs inside a NetworkManager checkpoint, as in Cockpit:

1. Outpost creates a checkpoint with a 60-second rollback timer.
2. It applies the change.
3. The browser then confirms it can still reach the panel, which keeps the change.
4. If the browser can't reach the panel, nobody confirms, and NetworkManager restores the previous configuration on its own. If applying a change fails partway, it is rolled back at once.

## Security

- **SELinux:**
  - Current and boot-time mode.
  - Switch between enforcing and permissive, now and optionally after reboot.
  - Access denials from `ausearch`. **Explain** runs `audit2why` and shows what `audit2allow` would generate; changing a file label or a boolean is usually a better fix.
  - Enabling SELinux from disabled needs a relabel and reboot, so do that in the Host Console.
- **AppArmor:** profiles with enforce/complain switching (`aa-enforce` / `aa-complain` on the file that defines the profile), and kernel denials from the last 7 days.
- **Crypto policy:** on Fedora and RHEL, `update-crypto-policies` with optional sub-policies such as `DEFAULT:SHA1`.
- **Panel HTTPS:** Outpost can serve itself over HTTPS on a second port, 8643 by default, while HTTP keeps working.
  - **Certificate sources:**
    - **Let's Encrypt:** runs `certbot certonly --standalone` in Admin Mode. The domain must point at the host, and port 80 must be reachable and free. certbot's deploy hook copies the certificate into `<data>/tls`, owned by the Outpost account, and does the same on every renewal.
    - **Upload:** a PEM chain and an unencrypted key. Outpost checks that they match.
    - **Self-signed:** created with `openssl`.
  - **Reloads:** certificate changes are picked up within a minute, without a restart.
  - **Redirect:** **Send browsers on HTTP to HTTPS** redirects browsers. Node-link traffic, ACME challenges and requests from the host itself stay on HTTP.

## Diagnostics

- **sos reports:** run `sos report` (or `sosreport`) as root with live output. Reports are stored in `<data>/diagnostics`, owned by the Outpost account, and can be downloaded or deleted. Reports can contain sensitive information.
- **kdump:**
  - Shows whether crash-kernel memory is reserved, whether the crash kernel is loaded, the service state, the dump folder and captured dumps.
  - You can turn the service on or off, change the dump folder (`/etc/kdump.conf` or `/etc/default/kdump-tools`), and on Fedora/RHEL reserve memory with `kdumpctl reset-crashkernel` (then restart).
  - **Test by crashing the host** triggers a kernel panic through sysrq after you type the host name. It only runs when a crash kernel is loaded.

## Linked hosts

If other Outpost panels are linked under **Configuration → Operations**, a host switcher appears on the Host pages.

- **Allowing it:** the linked host must turn on **Administration from linked panels** in its own Overview. It is off by default and can only be changed on that host.
- **How it works:** requests go to `/api/remote-host/<node>/…` on this panel. This panel forwards them to the node's `/api/node-link/host/…` with the node key, the acting administrator's name and a session id derived from your browser session.
- **Admin Mode on the linked host:** the lock button then controls Admin Mode on that host, using that host's sudo password. The session belongs to your browser session only.
- **Auditing:** changes are audited on both panels: as `host.remote` here, and under `<you>@<this host>` there.
- **If Outpost runs as root on the linked host:** linked administrators get root there without a password, so only allow it between panels you trust equally.
- **Local only:** Host Files and Host Console only work on the local host.

## Verification

```sh
npm run build
node server/test/host-admin.mjs
node server/test/host-system.mjs
```

The tests run on any OS with an isolated database. They cover:

- Parsing of passwd, shadow (no hashes leave the helper), groups, wtmp, nmcli, tuned, shutdown schedules, AVC and AppArmor records, cgroups and kdump config.
- Validation of names, keys, addresses, host names, NTP servers, certbot hooks and folders.
- nmcli command construction and checkpoint handling.
- TLS certificate checks (self-signed generation when `openssl` is installed).
- Metrics downsampling and anomaly detection.
- The helper refusing invalid arguments for every new operation.
- The local routes, the node-link routes (off by default, local-only switch unreachable), and the proxy to a linked host, including that a rejected node key doesn't sign the browser out.
