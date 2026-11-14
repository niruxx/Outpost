# Roadmap

Outpost feature roadmap. Checked items are implemented; unchecked items are proposed work, not release commitments. See [UI workspace documentation](docs/ui-workspace.md) for the supported workflows and limits of the general UI features.

## General UI and usability

- [x] Customizable dashboards with movable widgets for instances, host health, players, storage, backups and recent failures.
- [x] Saved and shareable views with filters, sorting, column visibility and grouping by game, host, owner or tag.
- [x] A persistent job center for installs, updates, imports, backups and transfers, showing individual stages, logs, cancellation where supported and retryable failures.
- [x] Extend existing bulk instance actions to multiple hosts and configuration changes, with a preview, per-instance results and retry of failed items only.
- [x] Configuration change previews with validation, restart requirements and a before/after diff before applying a preset or importing settings.
- [x] A permissions inspector showing what a selected user can access and why an action is allowed or blocked.
- [x] Expand command-palette actions and provide a searchable keyboard-shortcut reference, with consistent focus handling across dialogs and editors.
- [x] Mobile and accessibility improvements: touch-friendly tables, screen-reader labels, keyboard-only workflows, visible focus and reduced-motion coverage.

## Files, uploads and editing

- [x] Drag-and-drop folder uploads that preserve directory structure, with a visible queue and per-file results.
- [x] Resumable uploads with pause, cancel, retry and recovery after a connection drop, building on the existing percentage indicators.
- [x] Transfer controls for bandwidth limits, concurrent uploads and collision choices: skip, rename or explicitly replace.
- [x] A file recycle bin with retention and restore, extending existing change history and snapshot recovery.
- [x] Search across instance files and configuration contents, with filename/type filters and permission checks.
- [x] Extend the editors with syntax-aware diagnostics, schema hints, formatting and validation for supported game configuration formats.

Implemented in the shared instance file manager. See [file workspace details and limits](docs/file-workspace.md).

## Game and player features

- [x] Protocol-aware sleep and wake-on-connect for supported servers, starting with Minecraft; show wake progress and protect against repeated wake requests.
- [x] Allocate game, query, RCON, voice and companion ports together as a bundle, including required offsets and collision checks.
- [x] A mod/plugin update plan showing version changes, dependencies and incompatibilities, with a way to restore the previous managed mod set.
- [x] A staging workflow that clones an instance, tests a game or modpack update, and provides a reviewed promotion and rollback path.
- [x] Game-aware world import checks for edition/version, required mods or DLC, missing companion files and likely save incompatibilities.
- [x] Optional FastDL/static asset hosting for supported Source games, including asset publishing, compression and download verification.
- [x] Reusable game configuration profiles with inheritance, version history and selective application across instances.
- [x] Extend existing player and moderation controls with searchable identity/history, moderation notes, timed actions and a permission-controlled shared ban list where supported.
- [x] Minecraft performance diagnostics through supported profiler integrations, connecting tick lag, expensive plugins/mods and resource spikes to actionable reports.
- [x] CS2/TF2 match workflows for team rosters, map vetoes, tournament presets and match-result history, extending existing match and demo controls.
- [x] An optional authenticated Discord bot for status, player counts and approved server actions, mapped to Outpost permissions rather than unrestricted console access.

## Reliability, monitoring and backups

- [x] Configurable health alerts for sustained CPU/memory pressure, disk growth, tick lag, stalled startups and failed game queries, with cooldowns and maintenance silencing.
- [x] A maintenance workflow with player warnings, scheduled downtime, dependency-aware stop/start order and a record of completed steps.
- [x] Backup verification with integrity checks and optional disposable filesystem restore tests (without booting a game).
- [x] Incremental or deduplicated backups for large worlds, with storage estimates and daily/weekly/monthly retention policies.
- [x] Update preflight checks for disk space, dependencies and game readiness, with explicit recovery steps when a build or restart fails.
- [x] A troubleshooting bundle that gathers relevant logs, versions, configuration differences and failed job details while redacting credentials.

Implemented in **Game workflows** and **Reliability**. See the [capability matrix, setup and recovery limits](docs/game-reliability-workflows.md). Live game-installation certification remains in the release-quality section below.

## Login and account management

- [ ] OIDC single sign-on with providers such as Authentik or Keycloak, including account linking and controlled role mapping.
- [ ] Passkeys and WebAuthn security keys alongside existing TOTP.
- [ ] Email-based password reset and account recovery with expiring, single-use links.
- [ ] Account session management showing active devices, recent sign-ins and remote session revocation.

## Fleet, integrations and extensibility

- [x] Unattended installation and enrollment of new Outpost hosts from the panel, with provisioning logs and a clear rollback boundary. Reviewed, pinned SSH enrollment for Linux/systemd hosts.
- [x] Capacity planning across linked hosts, including reserved resources, auxiliary ports and placement explanations. Transactional resource/port-bundle reservations, resume/release and admission explanations.
- [x] Controlled instance evacuation and failover using verified backups and available host capacity, with game-specific recovery limits made explicit. Stopped-instance standbys, persistent source/destination fences, reviewed activation and rollback.
- [x] Billing lifecycle integration with WHMCS or Paymenter for provisioning, plan limits, renewal, suspension and termination. WHMCS module and signed, replay-protected lifecycle API with retained termination archives.
- [x] A versioned panel extension SDK for adding UI pages, backend capabilities, game adapters and integrations, with declared permissions and compatibility checks. SDK v1 sandboxed pages, external backend actions and declarative native adapters.
- [x] A curated community template/extension catalog with version pinning, update review and provenance information, extending existing template import/export. Administrator-trusted Ed25519 sources and immutable reviewed package digests.

See [fleet operations, deployment prerequisites and v1 recovery limits](docs/fleet-integrations.md) and the [extension SDK](sdk/README.md). Production Linux enrollment, WHMCS deployment and live cross-host game certification are separate validation work; local checks use disposable fixtures and Chromium.

## Compatibility and release quality

- [ ] Validate the new game settings and map/world controls against disposable live installations of every supported game, rather than relying only on fixtures and browser tests.
- [x] Publish a tested capability matrix by game, server version and host OS; make unavailable actions and prerequisites clear in the UI. See the [recorded fixture/browser matrix](docs/game-capability-matrix.md), the Compatibility page and each instance’s Capabilities tab. Unverified versions/OS combinations and live certification are kept explicit.
- [x] Add release checks for repeated tab navigation, reconnects, slow networks, large uploads and failed background jobs. See [release resilience checks](docs/release-checks.md).
