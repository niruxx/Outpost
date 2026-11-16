# BeamMP servers and BeamNG mods

On Windows or Linux, an administrator can choose **New instance → From a template → BeamMP Server**. Enter a server auth key from [BeamMP Keymaster](https://keymaster.beammp.com/), a name and a port (default **30814**). The server starts private; change `BEAMMP_PRIVATE` to `false` in the launch environment to list it publicly.

Download a binary matching your operating system and CPU from the [official BeamMP releases](https://github.com/BeamMP/BeamMP-Server/releases). Upload it using File Management to the instance root. Name it `BeamMP-Server.exe` on Windows or `BeamMP-Server` on Linux. Linux uploads are made executable when launched; install any runtime dependencies required by the selected release. Outpost prepares the launch settings; it does not download or update the binary automatically. Use a current release supporting BeamMP environment settings (3.2.0+).

Allow and forward **both TCP and UDP** on the chosen port. The endpoint displays TCP; add the UDP firewall/router rule as well. Start the instance from its console. Use Configuration's launch environment to change `BEAMMP_MAX_PLAYERS`, `BEAMMP_MAP`, `BEAMMP_PRIVATE` or the auth key. These environment settings override `ServerConfig.toml`. Changing the instance port updates `BEAMMP_PORT` on the next start.

## Vehicle and map mods, including BeamNG Earth

1. Stop the server.
2. Open **Mods** and upload the original vehicle or map `.zip`. Outpost keeps it intact in `Resources/Client`; enable, disable and remove use the existing installed add-on controls.
3. For a custom map such as BeamNG Earth, inspect the ZIP to find its actual `levels/<map-folder>/info.json` path. Set `BEAMMP_MAP` to `/levels/<map-folder>/info.json` in the launch environment. The archive filename is not necessarily the map folder name.
4. Start the server. Joining players download its enabled ZIPs.

Outpost accepts ZIPs containing `levels/` or `vehicles/` at the archive root. It does not bundle or fetch BeamNG Earth; obtain a compatible release from its author. Compatibility with a particular map release depends on that map, BeamNG.drive and BeamMP. The default map is `/levels/gridmap_v2/info.json`.

Server Lua plugins are separate: upload each plugin folder to `Resources/Server/<plugin>/` using File Management. The Mods tab manages vehicle and map ZIPs. Keep the resource folder relative to the instance; Outpost confines mod operations to that instance. Retain the BeamMP executable name so existing custom instances are recognized.

See the [BeamMP server setup guide](https://docs.beammp.com/server/create-a-server/) and [server manual](https://docs.beammp.com/server/manual/) for official resource formats and environment settings.
