# World Health

Open **World Health** in a Minecraft Java or Terraria instance's sidebar. Stop the instance, then choose **Check world files**. The worker performs bounded, read-only structural checks and stores a report. Click a world file or finding to inspect it. Java region files include a selectable 32×32 chunk storage grid; **Terrain preview** opens the existing Minecraft map page separately.

This first version inspects storage structure rather than certifying every block, entity, tile, mod or game load. It is not a Terraria evil-biome removal tool.

## Checks

**Minecraft Java:** the configured world and Bukkit-style Nether/End folders, including nested dimensions. `level.dat` is checked for readable compressed NBT and its `Data` compound. Anvil terrain/entity/POI region files are checked for header size, sector allocations, overlapping sectors, payload lengths, decompression/NBT errors, external chunk files and terrain chunk-coordinate mismatches. Gzip, zlib and uncompressed chunk payloads are supported. LZ4/custom compression is reported as unsupported, not corrupt. Green grid cells mean the supported payload structure decoded; gray means not generated, red a finding and yellow an unsupported/incomplete check.

**Terraria desktop:** world files under `worlds/`, using the version 140–323 file envelope. Checks cover the signature, file type, section-pointer bounds/order, tile-frame header boundary, world identity/dimensions and matching footer. File versions outside that range and Chinese-edition files are labeled unsupported. Tile RLE, chest/NPC contents and mod semantics are not fully decoded. A structurally plausible file can still fail a game load. The layout is based on the [TEdit world-format implementation](https://github.com/TEdit/Terraria-Map-Editor/blob/main/src/TEdit.Terraria/World.FileV2.cs); Anvil behavior is informed by the [Prismarine provider](https://github.com/PrismarineJS/prismarine-provider-anvil/blob/master/src/region.js).

Bedrock LevelDB and tModLoader companion repair are not supported. A `.twld` or `.twld.bak` companion prevents automatic `.wld`-only restoration, so mod data is not accidentally separated from the base world.

## Available fixes

The report offers only these actions when their preconditions are met:

- **Fix trailing sector padding:** append zeros to an incomplete final Anvil sector only when all referenced supported chunk records pass. Existing bytes, chunk pointers and terrain are preserved.
- **Restore local recovery copy:** replace an unreadable `level.dat` from `level.dat_old`, a damaged `.mca` from an adjacent `.mca.bak`, or a damaged/missing Terraria `.wld` from `.wld.bak`. The recovery file must pass the supported structural checks. Readable world identities must match. Region recovery involving external `.mcc` chunks is excluded because an unpaired region backup cannot establish a matching external-data version.

Restoring older data can lose changes saved since the backup. If the original identity cannot be read, the confirmation explicitly asks the user to verify that the adjacent backup belongs to that world. A Terraria backup passing envelope checks does not prove every tile section is healthy.

Each fix requires **Edit files**, **Create snapshots** and **Restore snapshots** permissions, plus explicit confirmation of its impact. Outpost first checks the file hashes, scans replacement bytes through the antivirus gate when enabled, and creates a **full instance backup** labeled `before-world-repair`. Only after the backup succeeds does it recheck hashes and write the replacement atomically. Changed targets, changed backups and newly appearing tModLoader companions abort the operation. The report links the recovery backup; the regular Backups page can restore it. Full backups may need substantial time and disk/memory for large instances.

Only one file is changed per confirmed fix. The previous report then becomes stale; run another check before starting the game. The checker never silently clears chunk pointers, regenerates builds, guesses missing blocks, or rewrites Terraria tile data. When no safe proposal exists, use a known-good snapshot/World Rewind point or a specialist recovery tool offline.

## Consistency and limits

Scans and repairs require a stopped instance and prevent Outpost starts while the task is active. They cannot stop external programs from modifying files: avoid concurrent SFTP/file-manager/SSH edits. Bounded reads and hashes protect each proposed replacement from stale files, but an external process can still invalidate a world after checking.

World discovery is bounded to 20,000 entries, 12 directory levels and 2,000 world files. Region inputs are bounded to 64 MiB, `level.dat` to 8 MiB, Terraria files to 128 MiB, and decompressed/external chunks to 32 MiB. Over-limit or unsupported data receives no automatic repair. Worker threads have a bounded V8 heap and a ten-minute timeout, with at most two active World Health tasks across the host. Cancellation and interrupted scans retain an incomplete report and offer no repairs. Progress appears in Job center.

## Verification

Build the server, then run `node server/test/world-health.mjs`. Disposable structural fixtures exercise Java NBT/region checks, Terraria envelopes, read-only scans, mandatory recovery backups, padding/restoration, stale-file rejection, backup identity checks, tModLoader exclusions, permission checks, start locks and cancellation. These fixtures do not replace validation against live game-generated saves. Set `OUTPOST_TEST_BROWSER_UI=1` and `OUTPOST_TEST_BROWSER` to run the chunk grid, repair-confirmation cancellation and mobile-layout checks in Chromium.
