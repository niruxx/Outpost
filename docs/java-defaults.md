# Linux system Java defaults

Under **Configuration → Default Java environment**, Outpost detects the local distro family and lists Java runtimes already registered with its system selector:

| Family | Read installed environments | Set the selected default |
| --- | --- | --- |
| Debian / Ubuntu | `update-alternatives --list java` | `update-alternatives --set java <registered-path>` |
| Fedora / RHEL | `alternatives --display java` | `alternatives --set java <registered-path>` |
| Arch / derivatives | `archlinux-java status` | `archlinux-java set <environment>` |

Choose a registered environment, review the displayed command, and click **Set system default**. Confirmation explains that other applications using system Java will also see the change on their next launch. The API re-reads the registered choices before running the command; arbitrary user-provided executable paths are refused. Only a current administrator using an interactive panel session can change the selection; API keys and demoted sessions cannot.

The service needs root or existing noninteractive sudo permission for that command. If it lacks authority, the panel reports the error; it does not change sudoers or collect an OS password. Run the displayed command manually as root instead, then refresh. The selector does not install/register JDKs or register Outpost-managed downloads in the host's alternatives database. Install a distro Java package first if no choices are listed. Debian/Fedora change the `java` alternative group; they do not independently reconfigure `javac` or every JDK tool. Arch's environment selector manages its distro-provided Java links.

Outpost still chooses Minecraft's required Java version when available. Explicit per-instance runtime selections and the service's `JAVA_HOME` remain authoritative. Changing system alternatives affects fallback/system `java`, not already running servers or those explicit choices. Windows, macOS and unsupported Linux families show an explanatory unsupported message.

Run `node server/test/host-setup.mjs` after a server build for simulated distro/default-selection and authorization tests. They do not change this machine's Java links. Check a real distro by comparing the panel to its selector's status and `java -version` in a fresh shell (without a conflicting `JAVA_HOME`/PATH override).

References: [Debian alternatives](https://manpages.debian.org/trixie/dpkg/update-alternatives.1.en.html), [Arch Java environments](https://wiki.archlinux.org/title/Java).
