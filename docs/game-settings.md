# Game settings and maps

Built-in Steam game presets now have either their dedicated CS2, TF2 or Garry’s Mod controls, or a **Game settings** tab. The new tab covers the other 22 presets. Minecraft retains its existing configuration, maps and gamerules controls.

The common form reads the current native configuration, exposes game-specific fields, and saves them back to the format the game uses. Advanced native editors expose the rest of the configuration. Unknown options and comments are preserved by common-form saves; settings are refreshed before startup once the instance opts into managed settings. Unmanaged instances keep their existing launch behavior.

| Game | Settings and map/world controls |
| --- | --- |
| CS:GO legacy, CS:Source, CS 1.6, Condition Zero | Name, password, slots, map, time limit, LAN/friendly fire, BSP uploads and packaged assets, rotation, live map change |
| Left 4 Dead 2 | Name, password, game mode, stock/installed maps, BSP uploads, live map change; the game mode still enforces its slot limit |
| Half-Life 2 Deathmatch, Day of Defeat Source, Half-Life Deathmatch, Team Fortress Classic | Native server.cfg settings, BSP maps/uploads, rotation and live map change |
| Quake III | Native cvars, game type, map selection, PK3 uploads/discovery and map rotation |
| Quake Live | Native cvars, map/factory selection, PK3 uploads/discovery, native Workshop list |
| Palworld | Name, description, passwords, slots, multipliers, PvP and death penalty; full OptionSettings editor preserving nested arrays; fixed world map |
| Project Zomboid | Public identity, password, slots, PvP/listing/pause, native ports, ordered mod-map selection and SandboxVars/spawn-region editors; Workshop installation remains in Workshop |
| Valheim | Name, password, visibility, crossplay, save interval, world selection and paired DB/FWL ZIP import; external default saves are never moved |
| Terraria | Name, password, slots, MOTD, existing world selection, WLD import, and generation size/difficulty/seed |
| Rust | Name, description, slots, seed, world size, custom HTTPS map URL, website/header and save interval |
| ARK: Survival Evolved | Session identity, ports, slots, installed/DLC map selection, PvE and rates, full GameUserSettings.ini/Game.ini editors; Workshop and RCON integrations remain intact |
| 7 Days to Die | Native XML identity/port/slots, world/save/seed/size selection, world ZIP import, SandboxCode and advanced native properties |
| Unturned | Native Commands.dat identity/port/slots/map/difficulty/perspective/combat, map ZIP import, and native Config/Workshop editors |
| Arma 3 | Native identity/passwords/slots/security, PBO missions, mission rotation and difficulty; existing custom mission Params survive unrelated changes |
| Black Ops III | Name/description/password/slots, multiplayer map selection, game type and rotation; existing Workshop mod/map support remains intact |
| Satisfactory | Native HTTPS API connection, server rename/options, save/session listing, save/load/create session and SAV upload; one fixed game map |

## Saving and permissions

Stop the server and wait for installation/update jobs to finish before editing startup settings, native files or uploading/removing map packages. Where supported, live map changes need console permission and confirmation. World selection changes require confirmation and keep the previous save.

Configuration changes need **settings** permission. Map/world uploads and removals additionally need **files.write**. The port is the same port used in the existing Configuration tab; allocation-pool assignments are respected. Games can need additional ports, such as ARK’s separately configurable query port.

The settings form protects against concurrent edits. If configuration changed since opening it, reload before saving. Password fields stay blank in API responses; blank means keep the current password unless **Clear saved password** is selected. Valheim’s launch-only password and Satisfactory API tokens are kept outside the public server record.

Native file editors are limited to the profile’s declared files, check revisions, reject binary/oversized files, and record changes in activity history. Common fields synchronize back to the form when editing the primary file. Native port edits for Zomboid, Terraria, 7 Days to Die and Unturned also update Outpost’s instance port. Raw configuration remains an advanced editor: the game/version must support the options entered.

Managed fields override matching extra launch arguments. Explicit custom launch configurations can bypass preset behavior; check Configuration → Launch if a managed setting does not take effect. Advanced extra arguments remain available there. Custom native config paths supplied through the supported `-config`, `-configfile` or `+exec` flags are honored when inside the instance. Zomboid’s in-instance custom cache/profile paths are honored too.

## Uploads and removal

All uploads show transfer percentage and server-processing status. Uploads are capped at 256 MB per file and ZIPs at 1 GB unpacked. Files are validated before writing; directory traversal and archive symlinks are rejected. Existing files are never overwritten.

- Source/GoldSrc: `.bsp`, or ZIP assets under `maps/`, `materials/`, `models/`, `sound/`, `resource/` and `scripts/`.
- Quake III/Live: `.pk3` containing `maps/*.bsp`.
- Arma 3: `mission.terrain.pbo`.
- Terraria: `.wld`, or a ZIP containing WLD files.
- Valheim: ZIP containing a matching `.db` and `.fwl` pair. Selecting an imported world in the list also selects the instance save location. Default keeps the old save location.
- 7 Days to Die: ZIP with one named world folder containing `map_info.xml`.
- Unturned: ZIP with one named map folder containing `Level.dat`.
- Satisfactory: `.sav`, validated and installed by the running server’s API.

**Uploaded packages** lists files installed through this screen. Removal only deletes tracked uploads; it cannot delete shipped game content. Selected maps/worlds and saved rotation entries must be changed first. Removal needs confirmation and does not replace backups. Existing untracked files remain manageable in File Management.

Rust custom maps use a public HTTPS download URL because joining clients need to download the map. Palworld has no interchangeable map package. Zomboid and BO3 map mods continue to use their Workshop installation flows. Changing a seed or world/save name can create a new save rather than modify the old world.

## Satisfactory API setup

Claim the server in the game’s Server Manager once. Generate an application token with `server.GenerateAPIToken` in its admin console, then paste it into Outpost’s **Connect API** field. Outpost calls only the local server on its configured port; it does not expose the token to other instance viewers. Self-signed certificates are accepted for this fixed loopback connection.

The server must be running for API actions. Live API changes also require console permission. Some options remain pending until a session/server restart. Loading or creating sessions temporarily makes the native API unavailable; refresh after loading completes. Uploads do not automatically replace the active session.

## Verification and compatibility

Run `npm run build` and `node server/test/game-controls.mjs`. The suite checks coverage against every built-in preset, native round trips, preserved fields, launch adapters, map uploads/removal protections, permissions, and recorded Satisfactory API responses. `OUTPOST_TEST_BROWSER_UI=1` adds browser coverage for all 22 new profiles; `OUTPOST_TEST_BROWSER` selects a Chromium-compatible executable.

These checks use disposable fixtures rather than full game installations. A live compatibility pass is still needed for each installed game/version, particularly Workshop/DLC content and game-specific slot limits. Custom servers without a built-in game preset continue to use their launch and file controls.

References: [Palworld configuration](https://docs.palworldgame.com/settings-and-operation/configuration/), [Valheim server guide](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/), [Rust custom maps](https://wiki.facepunch.com/rust/Hosting_a_custom_map), [Unturned hosting](https://docs.smartlydressedgames.com/en/latest/servers/server-hosting.html), [Arma server configuration](https://community.bohemia.net/wiki/server.cfg?useskin=vector), [Satisfactory HTTPS API](https://satisfactory.wiki.gg/wiki/Dedicated_servers/HTTPS_API).
