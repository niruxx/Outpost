# Game customization

## Team Fortress 2

TF2 instances have a **TF2** tab alongside the existing instance controls.

- Choose an installed start map or paste a TF2 Workshop map link / ID.
- Set a map rotation with one map per line. Upload `.bsp` maps directly; upload progress appears while transferring.
- Choose Casual, Competitive or Training to fill in server cvars and player slots, then save. Competitive is a basic preset, not a league configuration.
- Set the server name, password, Steam login token (app 440), and extra `tf_`, `mp_` or `sv_` cvars.
- Apply saved cvars or change the map while running. Start map, player slots and login token changes need a restart. Custom launch arguments can override these startup values.
- With TF2 stopped, install/update the official Metamod:Source and SourceMod frameworks. Console shows installation progress. Outpost preserves existing SourceMod configuration and disabled plugins during framework updates.
- Upload `.smx` plugins, `.vpk` mods or a ZIP with paths relative to `tf/`. Supported package roots are `addons`, `cfg`, `custom`, `materials`, `models`, `sound`, `scripts` and `resource`. ZIP packages can replace existing files.
- Enable, disable or remove SourceMod plugins, VPKs and custom mod folders. Stop TF2 first. Configuration remains when a plugin is removed. Packages that distribute files across multiple directories can be managed further in File Management.

Settings changes need the **settings** permission; live commands need **console**. Mods and framework changes need **plugins**. Map uploads need **settings**. Uploads are limited to one 256 MB file at a time.

Outpost writes `tf/cfg/outpost.cfg` and `tf/cfg/outpost_mapcycle.txt`, and appends `exec outpost.cfg` to `tf/cfg/server.cfg` while preserving other lines. It refreshes these files before startup once TF2 settings have been saved. With no custom rotation, the normal `mapcycle.txt` is used. Workshop cosmetic submissions are not installable server mods. Client content can require FastDL or matching client downloads.

[SourceMod installation documentation](https://wiki.alliedmods.net/Installing_SourceMod) describes the framework layout and console verification commands. [Valve’s Workshop announcement](https://www.teamfortress.com/post.php?id=17092) explains automatic Workshop map downloads for joining players.

## Minecraft gamerules

Java world servers and Bedrock instances have a **Gamerules** tab. Minecraft proxies do not.

Choose **Survival**, **Friendly survival**, **Building** or **Survival challenge**, or customize individual rules. Selecting a preset enables automatic application; click **Save gamerules** to persist it. Rules marked **Leave unchanged** are not sent. Presets only change the listed gamerules: they do not change game mode, difficulty, current time or current weather.

When automatic application is enabled, Outpost waits for the server’s ready message and sends saved rules once per process startup. **Save & apply now** also sends them to a currently running server. Console contains each command and the game’s response; sending a command does not guarantee that an old version or custom server accepts it.

The settings permission is required to save. Applying immediately requires both settings and console permissions. Rules persist in the world, so disabling automatic application does not undo previously applied values. Choose and apply Survival to restore the listed standard survival settings.

Outpost uses lowercase Bedrock names, older Java camelCase names, or modern Java names based on the instance version. Java 1.21.11 / snapshot 25w44a and later use the modern names. A manual naming selector is available for custom version strings. Fire spreading maps to the newer Java radius rule, using 0 for off and 128 for on.

References: [Mojang’s gamerule migration notes](https://www.minecraft.net/en-us/article/minecraft-snapshot-25w44a), [Bedrock gamerule command reference](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/gamerule?view=minecraft-bedrock-stable).

## Verification

Run `npm run build`, then `node server/test/game-customization.mjs`. Tests use disposable data and a fake game process; no game is installed or downloaded. On Windows, framework extraction is tested with recorded ZIP responses.

Set `OUTPOST_TEST_BROWSER_UI=1` to include browser flows. Set `OUTPOST_TEST_BROWSER` to a Chromium-compatible browser executable if Edge is unavailable. The browser checks exercise TF2 preset saving and Java/Bedrock gamerule forms.
