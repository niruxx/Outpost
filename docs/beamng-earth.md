# BeamNG.Earth multiplayer servers

## Create a server

An administrator can choose **New instance → BeamNG.Earth server**, or **From a template → BeamNG.Earth Server**. Set the name, port, player limit and visibility. Private Direct Connect is the default and needs no Keymaster key; public listing requires your BeamMP Keymaster key.

Outpost downloads the official BeamMP executable for the host and the latest **BeamNG.Earth-BeamMP-Server** release ZIP. It verifies the download size and published SHA-256 digest when supplied, scans the package if antivirus protection is enabled, and installs:

- `Resources/Client/beamng_earth.zip`, kept intact for joining players.
- The server plugin under `Resources/Server/BeamNGEarth/`.
- The official package's README, licence and credits.

It selects `/levels/beamng_earth/info.json` and prepares `ServerConfig.toml`. The server starts after setup unless you uncheck that option. Native automatic installation supports Windows x64 and the Debian/Ubuntu x64 or ARM64 builds supplied by BeamMP for that host release; runtime dependencies use existing administrator/package permissions.

## Enable or disable an existing BeamMP server

Stop the server and open **Status → BeamNG.Earth** or the same card on **Mods**. **Enable BeamNG.Earth** installs the official package and selects its map. **Install latest Earth package** updates it. The card shows the installed release, which players must match. Plugin source files are replaced on update, so keep a copy of custom Lua edits. Other mods and Earth cache/store files are preserved.

**Disable BeamNG.Earth** restores the prior map, moves the plugin out of the active Server folder and renames its client ZIP with `.disabled`. The files and cached data are retained. Re-enabling restores them and installs the current official package. These controls require an administrator and a stopped instance; server start is blocked during the operation and when requested Earth files are missing.

Earth support uses the default instance working directory and `Resources` folder, as expected by the upstream server plugin. Existing BeamMP servers using other resource folders need to adopt that layout first.

## Players, listing and ports

Every player must install and run the **matching BeamNG.Earth app** from the [official releases](https://github.com/TecnaGamer/BeamNG.Earth/releases). The server package alone cannot install a player's companion application. Players build/stream their world on their own computers; the multiplayer host does not need a terrain-generation companion server.

Private servers use BeamMP **Direct Connect**. Public Earth servers appear in the **BeamNG.Earth** category for Earth players, rather than the regular BeamMP server list. Outpost synchronizes its launch overrides into `ServerConfig.toml` before starting because the Earth plugin reads that file for listing metadata. Public listing also needs `curl` on the host, as described by the upstream package.

Allow the chosen server port over **TCP and UDP** in the host firewall. Router forwarding can be enabled during creation or managed on the UPnP tab. Earth does not require an extra public world-generation port on this host. The optional upstream share-helper and data-hosting services are separate and are not installed by this setup.

See the [official Earth server guide](https://github.com/TecnaGamer/BeamNG.Earth/blob/main/beammp/README.md) for player requirements and plugin settings.

## Validation

`npm run test:beamng-earth` uses isolated server/package fixtures. `npm run test:beamng-earth:ui` checks creation and enable/disable controls in a headless Chromium browser. The optional `npm run test:beamng-earth:live` downloads the real packages and checks a temporary loopback-only server for the Earth plugin's startup message; it does not start BeamNG.drive or test gameplay.
