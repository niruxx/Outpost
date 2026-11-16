# One-click server firewall rules

Open an instance's **Status** page and click **Allow server ports** in **Server firewall**. Outpost detects the Linux host's installed firewall, preferring a running firewalld daemon and otherwise using UFW. The card shows the backend, firewalld zone, ports, protocols and where each port was read from. **Refresh ports** rereads saved settings; the allow action always resolves the configuration again when clicked.

- Minecraft Java: TCP `server-port` from `server.properties`, plus UDP `query.port` only when `enable-query=true`. A `--port`/`-p` launch override takes precedence.
- Bedrock: UDP `server-port` and `server-portv6`.
- Velocity/Bungee/Waterfall: configured proxy listener ports, with the instance port as fallback before the config exists.
- CS2 and other Steam presets: the configured instance port and game protocol, respecting supported explicit launch port overrides such as `-port 27025` or `+hostport 27025`.
- BeamMP: both TCP and UDP, using `BEAMMP_PORT` from the launch environment or the `ServerConfig.toml` general section.
- Containers: published host ports, with their configured TCP/UDP protocols.
- Other custom processes: the instance's configured port and launch protocol.

For example, a Minecraft server configured with `server-port=25580` gets a `25580/tcp` allow rule. CS2 configured to launch on `27025` gets a `27025/udp` rule. Extra game-specific ports not represented by these settings can be managed on **Firewall**. RCON/admin ports are not added automatically.

UFW rules are persistent and inserted before conflicting deny rules for the requested ports. If UFW is off, the action saves rules without switching it on. firewalld rules are added to the displayed default zone in both runtime and permanent configuration, without a reload that could discard unrelated runtime rules. An explicit firewalld deny/reject needs review on the Firewall page; the action reports the conflict rather than claiming access is open. A stopped firewalld service must be started before rules can be applied.

The action requires an administrator account or **instances/manage** firewall access. Instance-scoped access only applies to assigned, unsuspended instances. Read-only firewall users can inspect the card. Outpost uses argument arrays and existing root or passwordless `sudo -n` permissions. If permission is missing, the Firewall page shows the sudoers setup hint. This action does not install or enable a firewall, change SSH/panel rules, remove old port rules, or modify router/cloud firewalls. Changing a server port and clicking again adds rules for the new port; old rules can be removed from Firewall.

The main **Firewall → Your instances** list uses these same saved port settings. Its **Allow server ports** button applies all resolved ports for that instance. Repeated clicks reuse existing rules. Partial failures list the affected ports and can be retried without duplicating successful additions.

Run `npm run test:firewall-instances` for isolated configuration, command and permission checks. `npm run test:firewall-instances:ui` checks the button in a headless Chromium browser; set `OUTPOST_TEST_BROWSER` if needed. Neither test changes a real host firewall.
