# Installed mods, details and dependency-aware uninstall

Each instance's **Mods / Plugins / Add-ons** page lists its actual installed artifacts. The inventory is scoped to that instance's add-on profile and directory. Search names, versions, filenames and module IDs, or filter enabled/disabled artifacts, explicitly installed/kept mods, automatic dependencies and untracked files. Uploaded and externally added files remain visible even when Outpost has no catalog record for them.

Choose **Details** or a mod's name for its dedicated instance-specific page. It shows the readable manifest's name, version, description, authors/license, safe publisher links, installed path, SHA-256, source/project/version references, provided modules, bundled libraries, required/optional dependencies and incoming references from other installed add-ons. Installed dependencies and dependants link to their own detail pages. “Enabled” describes the installed filename/activation state; it is not a claim that a running game successfully loaded the mod.

## Sources and local manifests

New Modrinth and CurseForge Minecraft mod installations retain project/version information and whether a file was explicitly selected or installed as a dependency. Managed Modrinth update sets also distinguish roots from dependencies. Existing records without that distinction are kept conservatively. A checksum mismatch invalidates the old source record instead of attributing changed bytes to an old catalog version. Uploads are recorded as explicit user choices. **Keep explicitly installed** pins a library against automatic cleanup; selecting that same artifact for uninstall remains possible after dependency review.

The inspector reads bounded metadata from JAR central directories without executing code or extracting classes:

- Fabric `fabric.mod.json`, including `provides`, declared dependencies and bounded nested JARs.
- Quilt `quilt.mod.json`, including simple dependency declarations and aliases. Conditional/alternative declarations that cannot be represented safely are marked incomplete.
- Forge `META-INF/mods.toml` and NeoForge `META-INF/neoforge.mods.toml`, including multiple provided mods, required/optional server-side dependencies and bounded Jar-in-Jar metadata. Manifest version placeholders are resolved from `Implementation-Version` where available.
- Legacy Forge `mcmod.info` is displayed with incomplete coverage because annotation-only dependencies may be absent from the file.
- Bukkit, Paper, Bungee and Velocity plugin manifests, including required and optional plugin references.
- Bedrock pack `manifest.json` UUID dependencies. Native pack removal updates activation through the existing pack handler.

Other supported profiles still have artifact detail pages, but opaque formats such as native DLL/PAK add-ons do not acquire an invented dependency graph. Their existing uninstall handlers are used with a full instance backup first; automatic dependency pruning is unavailable. Workshop-managed or game-specific content continues to use its existing game/Workshop page where no generic add-on profile exists.

Metadata inspection is bounded to 1,024 artifacts, 16,384 files and 4 GiB of inspected content per inventory. ZIP metadata is capped at 1 MiB per declaration and an 8 MiB central directory; nested archives are bounded to 128 entries, three levels and 32 MiB combined data. Oversized, malformed, encrypted, unsupported or symbolic-link metadata is not treated as a trustworthy dependency declaration. A mod set beyond inspection limits needs administrative/file-level management instead of a partial “safe” removal claim.

## Review an uninstall

Stop the instance and finish other installation/update/recovery jobs first. Management requires current **plugins** permission; users with instance access can still read the installed list and details.

1. Choose **Uninstall** or **Uninstall with dependency review**.
2. Review the exact filenames proposed for removal and the retained dependencies/reasons.
3. Leave **Also remove unused dependencies** selected to collect eligible automatic dependencies. A dependency is retained if any other installed artifact still references it, including disabled mods and optional consumers. Explicitly installed/kept files are retained.
4. Untracked dependencies are kept by default. **Include untracked dependencies with readable manifests** allows those in the selected root's dependency closure to be considered after review. This does not remove unrelated untracked mods or explicitly kept artifacts.
5. Apply the reviewed plan. It expires after ten minutes; current permissions, stopped state and all installed artifact hashes are checked again before changes.

The graph considers transitive relationships, aliases, modules bundled inside another JAR and dependency cycles. It collects an unreferenced dependency cycle as a group, while retaining one referenced by a remaining root. Multiple providers are handled conservatively. A root cannot be removed or disabled while a retained add-on declares a required dependency on one of its provided identities. Enabling an add-on checks that identified required providers are enabled. Dependency version constraints are displayed for review; they are not a complete game/loader version solver.

If any installed artifact has incomplete dependency coverage, automatic pruning is disabled. Acknowledgement is required to change only the selected artifact, retaining its dependencies. Hybrid Mohist/SpongeForge instances also retain dependencies because other plugin folders may contain cross-loader requirements. Undeclared runtime relationships, reflected/dynamic imports and game-specific dependencies cannot be certified from manifests. Test significant mod-set changes in staging.

## Recovery and concurrency

Java JAR removals move selected artifacts as a batch to the existing **File Management recycle bin** for 30 days. Separate configuration directories, saved worlds and unrelated files remain. A failed move rolls back earlier moves where possible. Native pack/game uninstall handlers get a full instance backup before removal; use the recorded backup to recover their files/activation metadata when needed.

The instance cannot start during an add-on mutation. An interrupted publication persists a startup fence so a partially changed dependency cycle cannot auto-start after a panel restart. Restore the original artifacts from the recycle bin or backup, then choose **Confirm original files restored** on the installed list. Recovery clears only after the pre-action inventory hash matches exactly. If files changed intentionally, an administrator should review and recover the original set first; the panel does not silently bless an uncertain partial operation. Removal plans are one-use/idempotent and scoped to the instance and operator.

Catalog downloads still pass through configured antivirus before publication. The installed inventory and dependency graph are not malware scans. Advanced File Management, SFTP, external tools and edits outside the panel can change a mod set; stale reviews are rejected, and changed files lose old provenance until reconciled.

## Checks

Run `npm run test:addons` to build and exercise metadata, real fixture catalog installs, shared/transitive/optional/disabled consumers, cycles, stale reviews, current permissions, batch rollback, persisted recovery fences, nested JAR providers, native pack dependencies and instance isolation. Set `OUTPOST_TEST_BROWSER_UI=1` and `OUTPOST_TEST_BROWSER` for Chromium list/detail/uninstall/mobile checks. CI runs the browser fixture. These are disposable fixtures, not live Minecraft/modpack certification.

Format references: [Fabric metadata](https://docs.fabricmc.net/develop/loader/fabric-mod-json), [Forge mod files](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/), [NeoForge mod files](https://docs.neoforged.net/docs/gettingstarted/modfiles/).
