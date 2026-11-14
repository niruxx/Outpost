# Roadmap

Fresh backlog for Outpost. All items below are proposed work, not shipped features or release commitments. Completed work and the previous comparison backlog have been cleared out. Existing capabilities are only listed where the proposal extends them.

## General UI and usability

- [ ] Customizable dashboards with movable widgets for instances, host health, players, storage, backups and recent failures.
- [ ] Saved and shareable views with filters, sorting, column visibility and grouping by game, host, owner or tag.
- [ ] A persistent job center for installs, updates, imports, backups and transfers, showing individual stages, logs, cancellation where supported and retryable failures.
- [ ] Extend existing bulk instance actions to multiple hosts and configuration changes, with a preview, per-instance results and retry of failed items only.
- [ ] Configuration change previews with validation, restart requirements and a before/after diff before applying a preset or importing settings.
- [ ] A permissions inspector showing what a selected user can access and why an action is allowed or blocked.
- [ ] Expand command-palette actions and provide a searchable keyboard-shortcut reference, with consistent focus handling across dialogs and editors.
- [ ] Mobile and accessibility improvements: touch-friendly tables, screen-reader labels, keyboard-only workflows, visible focus and reduced-motion coverage.

## Files, uploads and editing

- [ ] Drag-and-drop folder uploads that preserve directory structure, with a visible queue and per-file results.
- [ ] Resumable uploads with pause, cancel, retry and recovery after a connection drop, building on the existing percentage indicators.
- [ ] Transfer controls for bandwidth limits, concurrent uploads and collision choices: skip, rename or explicitly replace.
- [ ] A file recycle bin with retention and restore, extending existing change history and snapshot recovery.
- [ ] Search across instance files and configuration contents, with filename/type filters and permission checks.
- [ ] Extend the editors with syntax-aware diagnostics, schema hints, formatting and validation for supported game configuration formats.

## Game and player features

- [ ] Protocol-aware sleep and wake-on-connect for supported servers, starting with Minecraft; show wake progress and protect against repeated wake requests.
- [ ] Allocate game, query, RCON, voice and companion ports together as a bundle, including required offsets and collision checks.
- [ ] A mod/plugin update plan showing version changes, dependencies and incompatibilities, with a way to restore the previous managed mod set.
- [ ] A staging workflow that clones an instance, tests a game or modpack update, and provides a reviewed promotion and rollback path.
- [ ] Game-aware world import checks for edition/version, required mods or DLC, missing companion files and likely save incompatibilities.
- [ ] Optional FastDL/static asset hosting for supported Source games, including asset publishing, compression and download verification.
- [ ] Reusable game configuration profiles with inheritance, version history and selective application across instances.
- [ ] Extend existing player and moderation controls with searchable identity/history, moderation notes, timed actions and a permission-controlled shared ban list where supported.
- [ ] Minecraft performance diagnostics through supported profiler integrations, connecting tick lag, expensive plugins/mods and resource spikes to actionable reports.
- [ ] CS2/TF2 match workflows for team rosters, map vetoes, tournament presets and match-result history, extending existing match and demo controls.
- [ ] An optional authenticated Discord bot for status, player counts and approved server actions, mapped to Outpost permissions rather than unrestricted console access.

## Reliability, monitoring and backups

- [ ] Configurable health alerts for sustained CPU/memory pressure, disk growth, tick lag, stalled startups and failed game queries, with cooldowns and maintenance silencing.
- [ ] A maintenance workflow with player warnings, scheduled downtime, dependency-aware stop/start order and a record of completed steps.
- [ ] Backup verification with integrity checks and optional restore tests into a disposable instance.
- [ ] Incremental or deduplicated backups for large worlds, with storage estimates and daily/weekly/monthly retention policies.
- [ ] Update preflight checks for disk space, dependencies and game readiness, with explicit recovery steps when a build or restart fails.
- [ ] A troubleshooting bundle that gathers relevant logs, versions, configuration differences and failed job details while redacting credentials.

## Login and account management

- [ ] OIDC single sign-on with providers such as Authentik or Keycloak, including account linking and controlled role mapping.
- [ ] Passkeys and WebAuthn security keys alongside existing TOTP.
- [ ] Email-based password reset and account recovery with expiring, single-use links.
- [ ] Account session management showing active devices, recent sign-ins and remote session revocation.

## Fleet, integrations and extensibility

- [ ] Unattended installation and enrollment of new Outpost hosts from the panel, with provisioning logs and a clear rollback boundary.
- [ ] Capacity planning across linked hosts, including reserved resources, auxiliary ports and placement explanations.
- [ ] Controlled instance evacuation and failover using verified backups and available host capacity, with game-specific recovery limits made explicit.
- [ ] Billing lifecycle integration with WHMCS or Paymenter for provisioning, plan limits, renewal, suspension and termination.
- [ ] A versioned panel extension SDK for adding UI pages, backend capabilities, game adapters and integrations, with declared permissions and compatibility checks.
- [ ] A curated community template/extension catalog with version pinning, update review and provenance information, extending existing template import/export.

## Compatibility and release quality

- [ ] Validate the new game settings and map/world controls against disposable live installations of every supported game, rather than relying only on fixtures and browser tests.
- [ ] Publish a tested capability matrix by game, server version and host OS; make unavailable actions and prerequisites clear in the UI.
- [ ] Add release checks for repeated tab navigation, reconnects, slow networks, large uploads and failed background jobs.
