# BeamMP servers and BeamNG mods

An administrator can choose **New instance → From a template → BeamMP Server**, enter a name and port (default **30814**) and create it. Outpost downloads the latest official matching server, verifies its size, executable signature and published SHA-256 digest when supplied, sets executable permissions, creates `ServerConfig.toml`, `Resources/Client` and `Resources/Server`, and starts it when setup completes. Uncheck **Start the server when setup finishes** to leave it stopped.

Automatic downloads support Windows x64 and the Debian/Ubuntu x64 or ARM64 versions for which the [official release](https://github.com/BeamMP/BeamMP-Server/releases) supplies an exact build. Unsupported hosts fail with a clear explanation instead of receiving a guessed binary. Missing Windows Visual C++ runtime dependencies are installed using Microsoft's official redistributable; missing Linux Lua 5.3 is installed using apt with existing root or noninteractive sudo permissions. If the host cannot grant those permissions, install the named runtime on the host and click **Retry install**. Downloads and runtime setup appear in Console and Jobs. Failed downloads leave existing files intact, and retries preserve existing configuration and mods.

## Private servers for friends

**Friends / private** is the default visibility. It sets `BEAMMP_PRIVATE=true`, keeping the server out of the public list. The auth-key field is optional: Outpost generates a nonempty private value when it is blank. It is not an invite password or access-control mechanism; anyone who knows the address can attempt to join. **Public** visibility requires a real server key from [BeamMP Keymaster](https://keymaster.beammp.com/).

Friends join using **BeamMP → Direct Connect**, your host address and the chosen port. Use `127.0.0.1` on the hosting PC, its LAN address on the same network, or the host's public address from outside. Outside your LAN, allow and forward **both TCP and UDP** on the chosen port. Optionally enable **Try automatic router port forwarding** during creation: Outpost requests both protocols through UPnP while the instance runs. The router must support UPnP; host firewall rules and ISP/CGNAT limitations still apply. Leave forwarding off for LAN-only play. Status shows connection instructions, and the UPnP tab shows mapping results.

Use Configuration's launch environment to change `BEAMMP_MAX_PLAYERS`, `BEAMMP_MAP`, `BEAMMP_PRIVATE` or the auth key. These environment settings override `ServerConfig.toml`; restart to apply changes. Changing the instance port updates `BEAMMP_PORT` on the next start. The built-in template manages downloads automatically; existing manually configured custom BeamMP instances keep their manual lifecycle unless explicitly configured with the BeamMP installer. Automatic ongoing updates are not scheduled.

Validation: `npm run test:beammp` uses isolated fixtures. `npm run test:beammp:ui` checks setup in a headless Chromium browser (set `OUTPOST_TEST_BROWSER` if needed). The optional `npm run test:beammp:live` downloads the official binary and starts a temporary private server bound to loopback, then removes its data; it does not install host dependencies. A Windows smoke check of the current official v3.9.3 binary reached startup successfully but returned access-violation exit code `3221225477` after its `exit` command. Startup is verified; clean shutdown of that binary is not.

## Vehicle and map mods

1. Stop the server.
2. Open **Mods** and upload the original vehicle or map `.zip`. Outpost keeps it intact in `Resources/Client`; enable, disable and remove use the existing installed add-on controls.
3. For a custom map, inspect the ZIP to find its actual `levels/<map-folder>/info.json` path. Set `BEAMMP_MAP` to `/levels/<map-folder>/info.json` in the launch environment. The archive filename is not necessarily the map folder name.
4. Start the server. Joining players download its enabled ZIPs.

Outpost accepts ZIPs containing `levels/` or `vehicles/` at the archive root. Compatibility with a particular map release depends on that map, BeamNG.drive and BeamMP. The default map is `/levels/gridmap_v2/info.json`.

**BeamNG.Earth has a dedicated setup**, since it needs both a client mod and a server plugin. Choose **New instance → BeamNG.Earth server**, or enable it on an existing stopped BeamMP instance using its **BeamNG.Earth** card on Status or Mods. Outpost downloads the official server package and selects its map. Each player also needs the matching Earth application. See the [BeamNG.Earth guide](beamng-earth.md).

Server Lua plugins are separate: upload each plugin folder to `Resources/Server/<plugin>/` using File Management. The Mods tab manages vehicle and map ZIPs. Keep the resource folder relative to the instance; Outpost confines mod operations to that instance. Retain the BeamMP executable name so existing custom instances are recognized.

See the [BeamMP server setup guide](https://docs.beammp.com/server/create-a-server/) and [server manual](https://docs.beammp.com/server/manual/) for official resource formats and environment settings.
