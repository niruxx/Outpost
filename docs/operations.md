# Fleet, allocations, automation and game operations

The **Operations** sidebar entry contains **Host fleet** and **IP / port pools** for current administrators, plus **My Steam accounts** and **CurseForge modpacks** for signed-in users. Instance-specific event rules and incoming webhooks are under **Tasks & Automation**. CS2 match, demo and player controls are at the top of the instance's **Counter-Strike 2** tab.

## Registered host inventory and provisioning

Register other Outpost panels using their URL and node key in Configuration. Upgrade both panels before using fleet provisioning; old transfer-only nodes do not supply the new inventory/admission APIs. Each node reports hostname, OS, CPUs, total/free RAM, configured instance memory commitments, instances and allocation pools. Instance links open that panel; remote panel sign-in is still required. This is inventory and instance provisioning across existing Outpost installations, not an operating-system installer or a shared multi-host login authority.

Placement policies set whether a node accepts provisioning, host RAM to reserve, an instance-count limit (zero means unlimited), and tags. A central node's policy for a remote host controls its placement choices. The destination's own **This host** policy independently controls admission there.

To provision, enter a game definition, memory, version, target host or **Automatic placement**, and optional required tags. Automatic placement filters reachable/enabled hosts by free RAM, uncommitted RAM after reserves, instance count, curated platform compatibility, compatible free primary-port allocations when requested, and tags, then picks the host with most uncommitted RAM. Failed/offline or old nodes are excluded. Resource information is a snapshot and configured memory is a reservation estimate, not a guarantee about CPU, storage, game compatibility or actual RAM consumption. Existing per-instance kernel/container limits still apply separately. Curated Steam games must be supported by the destination host. The form defaults to requiring a compatible destination allocation pool; disable that option to enter a primary port manually.

Provisioning uses the normal instance-creation validation and background installer. A successful creation response does not mean its download has finished: inspect its installation state on the destination. Remote ownership belongs to the receiving panel's local administrator. Central Steam account credentials and local templates are not sent; configure licensed Steam accounts on the destination. Node keys carry host administration authority and should only be shared with trusted panels over a protected connection.

Provisioning IDs are persisted. Retrying the same ID and unchanged definition uses its original destination and original instance; it never silently selects a second host after a timeout. Recent placements show success, errors and uncertain outcomes. The form retains its request ID on failure. Inspect both placement and destination inventory before starting a different request. A destination interrupted before recording an instance requires operator inspection before using a new ID. Deleting a previously provisioned instance does not make its old ID reusable. Requests remain tied to the same definition, including field values and their serialized ordering.

The node-link APIs are `GET /api/node-link/inventory` and `POST /api/node-link/provision`, authenticated with the existing node key. Provisioning additionally requires a UUID `X-Outpost-Provision-Id`. The owner API is `GET /api/operations/fleet` and `POST /api/operations/provision`, whose body has `requestId`, `nodeId` (`local`, a registered ID, or `auto`), `tags`, and `definition`.

## Primary IP and port allocation pools

Create a local pool with a name, a host IPv4 address (or `0.0.0.0`), protocol and inclusive port range. Ranges are limited to ports 1024–65535 and at most 10001 entries. Ranges cannot overlap on this host, even across addresses/protocols: many supported games bind wildcard sockets, so the first implementation conservatively keeps primary ports unique across pools.

Choose **Primary port assignment** when creating an instance, choose automatic pools during fleet provisioning, or assign a stopped existing instance from the pool page. Assignments apply to Java, Bedrock and Steam primary game ports. Reservations are transactional and expire after two minutes if never attached to an instance. Assignment skips all existing instance primary ports and current reservations. Compatible automatic selection tries another pool when an earlier pool is full. Instance deletion releases its allocation through a database foreign key.

Java's `server-ip` is set to the assigned address (blank for wildcard). Java/Bedrock primary port properties are reapplied after installation so downloaded defaults cannot overwrite them. Steam presets use their existing primary-port launch settings; other game bind-IP settings need native game configuration. This does not create network interfaces, configure NAT/firewall/router rules, probe unrelated host processes, or reserve auxiliary/query/RCON/IPv6 ports. Do not include other host services' ports in a pool. A pool address must already exist on the host.

An assigned port cannot be changed through the normal settings/property API until the owner releases that assignment. Release leaves the current port and files in place as a manual configuration; it does not stop the server or move traffic. Existing unassigned instance ports are still skipped by automatic assignment. Stop an instance before assigning/releasing. Pools with assignments or live leases cannot be removed. Update clients, DNS/forwarding and firewall rules when changing ports. If a multi-step configuration write fails, inspect the instance's port and assignment before retrying.

## Event rules

Each rule belongs to its creator and one instance. Choose an event, action, enabled state and cooldown (5 seconds to one day). There are at most 100 rules per instance and 16 simultaneous rule executions per panel; a rule cannot execute concurrently with itself. Events occurring during cooldown/concurrency limits are skipped, not queued for later replay.

Supported events:

- `player.join`, `player.leave`, `player.firstJoin`: derived from Java, Bedrock and recognized Source-style connection logs. Plugins/games that change those log formats may need native integration. First join means the first observed, case-insensitive player name since Outpost began recording that instance's history; it is not a Steam/Mojang identity lookup or an import of older world history. First-seen history persists across panel restarts. Duplicate join log lines while already online are ignored.
- `state.starting`, `state.running`, `state.stopped`, `state.crashed`: use Outpost's process status events. A guest or process that Outpost does not supervise does not generate these instance events.
- `webhook`: an explicit authenticated incoming trigger, described below.

Actions are a single console command, an instance backup, or a validated settings patch. Commands may include `{{player}}` on player events. Player names must pass a conservative character check before substitution; payloads cannot introduce extra commands. Backups use the instance's configured backup directory. Instance settings support `name`, `autoStart`, `minMemoryMb`, and `maxMemoryMb`. Minecraft properties follow each item's permission; network address/port changes are excluded from rule patches. Properties cannot contain control characters or backslash continuations that could affect adjacent protected settings.

Permissions are checked when saving and again before every execution using the creator's **current** account, instance access, suspension state, action permission and per-item restrictions. Removing access or deleting that account disables its stored authority. An administrator editing somebody else's rule does not replace its owner with administrator authority. Snapshot/backup rules need backup-create permission; console rules need console permission; settings rules need each setting's edit permission. Last execution time/result is shown, and attempted executions are audited. A backup failure or invalid command cannot make a rule bypass current permissions.

## Incoming webhooks

Creating a webhook rule shows a random bearer secret once. Only its SHA-256 digest is stored. Copy it into the caller; rotate it in the rule list if necessary. Each rule has one fixed, permission-checked action. Request bodies cannot override its command, backup target or settings.

```http
POST /api/hooks/<rule-id>
Authorization: Bearer <secret>
X-Outpost-Delivery: <unique-id-with-8-to-100-letters-digits-underscores-or-hyphens>
X-Outpost-Timestamp: <current-Unix-time-in-milliseconds>
Content-Type: application/json

{}
```

Use HTTPS for network callers. Timestamps must be within five minutes of the panel clock; delivery IDs are deduplicated for seven days. A repeated authenticated delivery returns `duplicate: true` without executing again. Send a current timestamp when retrying. Cooldown/concurrency rejection returns HTTP 429 before consuming a new delivery ID. Once execution starts, the ID is consumed even if the action fails: inspect the last result and use a new delivery only if you intend another attempt. There is no promise of exactly-once effects across crashes or failures in a multi-step action. Disabled rules, deleted accounts, revoked grants and stale secrets are rejected. Bodies/credentials are not written to the audit log.

## Personal Steam accounts and Steam Guard

Under **My Steam accounts**, save a username/password, then select it in New instance's Steam form, a Steam instance's settings, or the Workshop account selector. The account list is private to its owner. An instance assignment stores an account ID reference, not a password. Other operators authorized to update that assigned instance may use its assigned account without retrieving its password. Choosing a different saved account requires ownership of that account. Deleting it prevents future use by assigned instances; choose another account or anonymous login before updating again.

New saved passwords are encrypted with AES-256-GCM under a key derived from the panel session secret. Preserve the original session secret with database backups; changing it makes existing encrypted passwords unreadable. Legacy manual per-instance Steam logins are still supported and are not automatically migrated: move those to a saved account to use the new storage/session handling. Accounts do not propagate to other nodes; transfers clear a saved-account reference to anonymous.

Each saved account has a private SteamCMD runtime/session directory outside instance folders. Bootstrap copies runtime files without copying global cached login/session/config data; HOME/USERPROFILE are set to the account directory. Login passwords and codes go through short-lived mode-0600 script files in a private OS temporary directory outside the backed-up data tree, not process arguments, and are redacted from captured output. Scripts are deleted on completion/error. The cache remains until account deletion so Steam can remember authorized sessions. Deleting an Outpost user also removes their saved Steam accounts/cache, and is refused while one of their downloads is active. Full environment backups include cached Steam sessions and must be protected as sensitive panel-owner archives. Avoid abruptly killing the panel while logging in; private scripts left by a host crash may need cleanup by its administrator. Host administrators/service-account access can read the panel's own private data; this is panel-level account separation, not isolation against the host owner.

Supply a fresh Steam Guard code immediately before starting/retrying an install/update. It is kept in memory for two minutes and consumed once; it is neither saved nor audited. Steam app approval may also be needed. Expired/incorrect Guard codes produce an install error; submit a new code and retry. One download at a time may use a saved account. Passwords containing quotes/backslashes/line breaks or starting with `+` are refused to keep SteamCMD script parsing unambiguous. SteamCMD must explicitly report app-installation success; an exit code of zero by itself is insufficient.

## CurseForge server modpacks

Configure the existing CurseForge API key under Configuration, then search modpacks in Operations. Select a client/export file, or enter numeric project/file IDs. Outpost reads its `manifest.json`, detects Minecraft and the pinned Forge/NeoForge/Fabric/Quilt loader, and creates a normal Java instance subject to the user's creation policy and EULA acceptance.

If the selected file links an author server pack, that archive is used for server files. A single wrapping directory is supported. Otherwise required manifest files and overrides are installed; client-only mods may need removal before a first successful server start. Optional manifest mods are omitted. Author/API download restrictions are respected: missing permitted URLs fail rather than falling back to scraped mirrors or invented CDN links. All files in a required manifest must be downloadable for this fallback path to complete.

Downloads use checked HTTPS forgecdn.net URLs, validate redirects and available archive checksums, and enforce compressed/expanded size limits. Archives reject traversal and symlinks; writes reject existing symlink escapes. The manifest archive is capped at 256 MiB, author server packs at 512 MiB, and expanded archives at 2 GiB/20000 files. Pack startup scripts are extracted but **not executed**. The known loader installer configures startup. Arbitrary launcher-based packs, unsupported loader IDs and packs requiring custom bootstrap programs need manual installation. EULA files from the archive cannot override the consent recorded by Outpost. Installation failures remain visible for retry; reinstalling can replace pack-managed files, so keep backups of later customizations.

## CS2 matches, maps, demos and players

The CS2 tab now supports a saved match plan: team names, maximum rounds, round time, freeze time and overtime. It writes `cfg/outpost_match.cfg`, included after existing Outpost cvars on starts/map loads. Live controls use configured RCON to begin warmup, load/start the saved live match, pause/resume, restart rounds and swap teams. Round-changing controls ask for confirmation and display RCON output; native game errors are not hidden. This is match administration, not a tournament bracket/veto system or an automatic match-result service.

Map rotation writes a managed `outpost_rotation` mapgroup into `gamemodes_server.txt` and selects it in startup/configuration. Existing custom `gamemodes_server.txt` files are refused rather than overwritten; merge or move them first. Use installed, plain map names. Workshop map/collection controls remain separate. Emptying rotation removes only Outpost's own mapgroup file; restart to fully reset a currently running group's state.

SourceTV recording requires `tv_enable 1` in the existing CS2 cvars before starting the game. Record/stop controls call `tv_record`/`tv_stoprecord`. Outpost lists only its `game/csgo/outpost_demos/*.dem` regular files, with authenticated downloads. File-read permission controls listing/downloading; file-write permission and a stopped server are required for deletion. Recording actions need console permission. Files already present cannot be overwritten through the Record form. SourceTV ports/encoding settings remain native configuration.

Live player status uses RCON `status`, parses recognized quoted-name formats and shows the raw output for newer/different game formats. Kick uses the current numeric user ID. Ban/unban uses a validated legacy Steam ID from status, a bounded duration (zero means permanent), and `writeid` to persist the native ban list. Player actions require player-administration permission and confirmation. The existing CounterStrikeSharp administrator controls remain available for SteamID64-based plugin administrators. No arbitrary player name or reason is concatenated unvalidated into a command.

## Verification

```sh
npm run build
node server/test/operations.mjs
node server/test/config-access.mjs
node server/test/host-setup.mjs
node server/test/operations-browser.mjs
```

The operations test uses an isolated database, simulated CurseForge/installer data, a fake SteamCMD runner and real local HTTP requests. It verifies lease expiry/collisions, rule authority and first joins, webhook credentials/replay/rotation, encrypted account privacy/one-use codes/private scripts, pinned pack installation, CS2 input/config handling, HTTP actions against simulated RCON, and idempotent local/remote placement after a lost response. It does not log into Steam, provision on a real remote host, download a paid game, or record a real CS2 match. Validate real provider authentication, both-node provisioning and game-version-specific commands on disposable instances before production use.

References: [CurseForge REST API](https://docs.curseforge.com/rest-api/), [Valve SteamCMD documentation](https://developer.valvesoftware.com/wiki/SteamCMD), [Valve CS2 dedicated servers](https://developer.valvesoftware.com/wiki/Counter-Strike_2/Dedicated_Servers).
