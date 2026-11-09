# Host File Manager and Admin Mode

Administrators can open **System → Host Files** (or the **Host** entry at the top of **File Management**) to browse, edit, upload, download, rename and delete files anywhere on the machine Outpost runs on. It works on absolute host paths, outside instance directories and instance permissions.

## Limited access and Admin Mode

Like Cockpit, the file manager starts with **limited access**: operations run as the Outpost service account, so files that account cannot read or change fail with "Permission denied".

The **Limited access / Admin Mode** button in the top bar switches to **administrative access**:

- On Linux/macOS, enter the service account's **operating-system password** (the one sudo asks for, not your Outpost password). Outpost runs `sudo -S -k` once to start a small privileged helper, and passes the password to sudo's stdin without storing it. If the account has passwordless sudo, no password is needed. The host's sudo policy decides whether this is allowed. Policies with `requiretty` are not supported.
- While it is on, file operations in **that browser session** run as **root** through the helper. Other sessions of the same Outpost user stay limited.
- Click the button again and choose **Limit access** to turn it off. It also ends after 15 minutes without activity, after eight hours, on sign-out and when Outpost stops. A package transaction that is still running is allowed to finish first, so dpkg/rpm are never interrupted halfway.
- If Outpost already runs as root (or elevated on Windows), there is nothing to switch, so Admin Mode always shows as on.
- On Windows, a running service cannot be elevated without a UAC prompt, so Admin Mode is unavailable unless Outpost itself runs as an administrator.

The helper only performs a fixed set of operations: the file manager's own (list, read, write, create folder, rename, delete) and the validated operations used by the [Host administration](host-administration.md) pages (services, packages, accounts, networking, settings, security and diagnostics). It does not open a shell and does not load Outpost's database or secrets. Use the [Host Console](host-console.md) for anything else.

## Access and auditing

Only active administrators with a normal panel sign-in can use it. API keys are rejected. Turning Admin Mode on, off and failed attempts are audited (`host.admin.*`), and so is every change and download (`host.file.*`), with whether it ran as `user` or `admin`. Five failed password attempts in five minutes block further attempts for a while.

Edits are written in place, which keeps the file's owner, permissions and hard links. The browser editor opens text files up to 5 MB, and uploads are limited to 1 GB per file.

## Verification

```sh
npm run build
node server/test/host-files.mjs
```

The test uses an isolated database and temporary directory. It checks access control, path validation, limited-access CRUD, chunked upload and download, and the helper's protocol without sudo. To exercise real sudo elevation, run it on a disposable Unix host with `OUTPOST_TEST_SUDO_PASSWORD=<password>`, or with `OUTPOST_TEST_SUDO=1` if sudo is passwordless.
