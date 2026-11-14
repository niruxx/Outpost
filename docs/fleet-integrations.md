# Fleet, integrations and extensibility

Administrators can open **Configuration → Operations** for Host enrollment, Capacity & placement, Fleet recovery, Billing integrations, Extension SDK and Community catalog. Enabled extension pages are also available from **Extensions** in the main navigation. Upgrade every linked host before using the capacity and recovery protocols.

## Install and enroll a host

The enrollment workflow builds an archive from the current compiled panel, pins its SHA-256 and an official Node 22 release, and shows the installer before execution. Build Outpost first (`npm run build`). The bundle contains package manifests, compiled server/web assets and scripts; it excludes the controller's database, environment files, Git checkout and credentials. It is an installed release bundle, not a Git checkout; update these enrolled hosts through a reviewed replacement deployment rather than `git pull`.

Prerequisites on the target are Linux x64/arm64 with systemd, curl, tar/xz, sha256sum and useradd; outbound HTTPS/npm access; and root or passwordless sudo. Configure an HTTPS reverse proxy to the selected panel port first. The controller and new host must reach each other's configured HTTPS origins. HTTP is accepted only on literal loopback addresses for development. Install Java, Steam/game dependencies, antivirus and any required game licenses separately.

1. Enter the host name/origin, controller origin, listener port and initial owner account. Confirm the reverse proxy is ready.
2. Review the pinned release, bundle digest and redacted installer.
3. Provide SSH details, a private key/passphrase and the independently verified **SHA-256 SSH host-key fingerprint** (64 hex characters or the standard `SHA256:base64` form). For example, on the target, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` prints the standard form. Verify the host key through your provider console or another trusted channel.
4. Run the installer and follow its job log. SSH credentials are used in memory for that execution. Enrollment/initial-owner secrets are encrypted at rest, excluded from returned job data and redacted from installer logs. The one-hour bundle/callback token is scoped to this enrollment and revoked after successful enrollment or cancellation.

Each run uses `/opt/outpost-enroll/<enrollment-id>`, a dedicated unprivileged account and `outpost-enroll-<enrollment-id>.service`. It refuses to overwrite an existing enrollment directory. The callback verifies the new node key and reachable host before adding it to the fleet.

**Rollback boundary:** stop and disable that exact new unit, inspect the retained directory/account and remove its linked-host record if applicable. Existing services and deployments are not replaced. Cancellation revokes an unused token; it does not uninstall a remote host. After an interrupted/failed run, inspect the remote unit before creating another plan. A controller restart marks in-progress enrollment interrupted and retains the evidence.

## Capacity planning

Placement explanations consider admission policy/tags, host OS support, RAM, CPU, disk quotas/headroom, instance counts, pending reservations and the complete requested port bundle. A host on an older protocol is shown as unavailable for this workflow. Controller placement policy and the destination's own admission policy both apply; configure required tags on each side. Explanations report missing destination tags. Memory admission policy lives under Host fleet; CPU/disk headroom is editable under Capacity & placement on the host being configured.

Specify memory/disk in MiB and CPU percent (`100` is one logical core). Advanced roles use `{ "role": "rcon", "offset": 10, "protocol": "tcp" }` relative to the game role at offset zero. Bedrock includes its IPv6 port by default. Add every required query/RCON/voice/companion port for Steam games. A pool must fit the entire bundle and its protocols. A fixed base port can be selected explicitly instead.

Reservations are transactional, last ten minutes, survive navigation and are idempotent by request UUID and contents. Pending reservations appear with Resume/Release controls. Normal primary-port allocation, auxiliary bundles and duplicate-instance port selection exclude pending claims. Provisioning consumes the reserved bundle and applies its CPU/disk limits. Retrying the same provisioning definition and reservation returns the existing instance; changing the definition is rejected. Check the destination's instance list before using a fresh ID after an uncertain response.

These are admission reservations and panel limits, not a dedicated hardware partition or a guarantee that an unrelated OS process is not listening. Existing workloads without CPU/disk limits are called out in placement warnings. Manual resource changes and programs outside Outpost can alter available capacity.

## Verified standbys, evacuation and failover

This is an **operator-controlled, stopped-instance recovery workflow**, not live replication or automatic high availability. Select different linked source/destination hosts, a stopped source and a destination budget. `standby` releases the source after the destination confirms its verified fence; `evacuate` retains the source fence for handover.

The source creates a restore-tested backup with a scoped one-hour download ticket. The destination checks the exact length/SHA-256, reserves capacity, checks archive paths/CRC/expansion limits, scans through configured antivirus and imports a new stopped, fenced instance. Invalid imports are removed. A fence persists in the database and blocks manual, scheduled and automatic starts across panel restarts. Preparation disables auto-start and automatic restart on fenced instances.

Activation requires review of destination ports, save paths, runtime libraries, mods, licenses and external dependencies. The source must be fenced before the destination becomes startable. A reachable host's running/conflicting-fence denial cannot be overridden with the external-fence acknowledgement. If the source is unreachable, an administrator must first prevent it from restarting through their provider/network/power controls, then explicitly attest that external fence. Activation leaves the destination stopped for game-level checks.

If a response is lost, reconcile the destination rather than starting another import. A repeated destination import with the same run/digest returns its confirmed standby. Interrupted imports are held for inspection. Rollback requires a stopped destination, fences it before releasing the source, and never merges newer destination saves into the original. If preparation failed before a destination exists, rollback first checks that the destination import is absent or definitively failed. An unreachable destination is not assumed absent. Auto-start/restart policies remain disabled for review after rollback.

Recovery v1 boundaries:

| Workload | Recovery limits |
| --- | --- |
| Minecraft Java | Instance-local world/mod/config files and portable game settings; install a compatible Java runtime and any native mod dependencies on the destination. Query/RCON are disabled during port remapping. |
| Minecraft Bedrock | Matching source/destination OS and architecture; reserve game and IPv6 ports; review native dependencies. |
| Steam presets, including extension adapters | Matching OS and architecture and a compatible installed destination preset; review/reconfigure native game/query/RCON ports and licenses before starting. |
| Valheim | Only worlds explicitly configured for instance-local storage. External home-directory worlds are rejected. |
| Custom processes / Docker | Not included in this recovery importer. Use their deployment/storage-specific procedure. |
| Billing-managed instances | Reconcile billing ownership before migration; this workflow rejects them. |

Instance trees and compressed snapshots are limited to **1 GiB** in v1, with 100,000 archive entries, 256 MiB per file and 20 GiB expanded maximum. Destination disk budget must cover the data. Recovery uses full backups; native configuration files in those archives can contain secrets. Protect the controller/node links and backup storage accordingly. Accounts, grants, billing bindings, external databases/storage, source host credentials and custom launch overrides are not migrated. Portable game settings omit keys identified as credentials; re-enter any required secrets. Restored files do not certify game-world semantic health or mod compatibility; use the separate world-health workflow where supported.

## Billing lifecycle API and WHMCS

Create a connection and copy its secret once. Keep termination disabled until the billing integration is reviewed. Create plans pinned to a managed Java/Bedrock/Steam template, local port pool, template variables, memory, CPU and disk limits. Java plans require administrator EULA acceptance. Provisioning is local to the connected Outpost host; configure another billing connection/server for another host.

Copy [`integrations/whmcs/outpost`](../integrations/whmcs/outpost) to `WHMCS/modules/servers/outpost`. Add an Outpost server with its HTTPS origin as hostname, connection ID as username and connection secret as password. Select the Outpost module for the product and enter the Outpost plan ID in its first module option. Enable optional expiry synchronization only if WHMCS's next due date should control Outpost's expiry timer; otherwise WHMCS drives suspension/renewal itself. Test Connection verifies signed connectivity. Supported callbacks are CreateAccount, SuspendAccount, UnsuspendAccount, Renew, ChangePackage and TerminateAccount, following the [WHMCS provisioning functions](https://developers.whmcs.com/provisioning-modules/core-module-functions).

Other billing systems can POST UTF-8 JSON to `/api/billing/events/<connection-id>`:

```json
{"action":"create","externalId":"order-42","customerId":"customer-8","planId":"OUTPOST_PLAN_ID","expiresAt":"2027-01-01T00:00:00Z"}
```

Headers are `X-Outpost-Event-Id` (a unique delivery ID), `X-Outpost-Timestamp` (Unix seconds) and `X-Outpost-Signature` (hex HMAC-SHA256 of `timestamp + ':' + eventId + ':' + exactRawJson`, keyed by the connection secret). Requests expire after five minutes. Accepted actions are `ping`, `create`, `renew`, `suspend`, `unsuspend`, `changePlan`, `terminate`; all except ping identify the service/customer. A `changePlan` selects another plan using the same pinned template and stops/restarts the game as needed for resource changes. Game/template migrations are separate operations.

Delivery IDs persist with their request hash/result. Retrying an ID with changed bytes is rejected. Repeated creates for an already bound external service return the same instance; uncertain provisioning is held for operator review instead of creating another. A successful create confirms the instance record and installation job; inspect Jobs for game-download/install failures before handing it to a customer. Customer IDs cannot be swapped on an existing service.

Customers get dedicated restricted accounts with ownership of their service instances and no independent creation rights. Arrange panel sign-in/password reset separately through user administration; this module does not implement SSO or email delivery. Renewal clears only that connection/service's billing suspension and preserves manual administrator suspensions. Expiry suspends; it never deletes. Disabling a connection pauses its events and expiry automation. Rotating its secret invalidates old signatures.

Termination is separately opt-in per connection. It stops the game and retains a verified ZIP plus checksum metadata under `OUTPOST_DATA_DIR/billing-archives/<archive-id>/` before removing the active instance. These retained archives have no automatic retention deletion; administer them separately. A second termination is idempotent. Failed/interrupted deliveries and service bindings are visible in the panel for review; do not blindly reset an uncertain provisioning binding.

Native Paymenter packaging is not included; its integration can use the signed lifecycle API.

## Extension SDK and community sources

See [`sdk/README.md`](../sdk/README.md) for manifests, inline page bridge, external backend helper, native game adapters and catalog signing. SDK v1 supports sandboxed UI pages, permission-checked native actions, fixed external backend endpoints and declarative native game adapters. Extensions are installed disabled after a full manifest/digest/permission review. Enable explicitly. Updates show newly requested permissions, retain five previous manifests and also start disabled; restore a prior version for rollback. An extension used by existing game instances cannot be disabled/replaced until those dependencies are migrated or removed.

The community catalog is an administrator-curated list of trusted Ed25519 publisher keys and signed source URLs. Outpost does not ship an unverified public marketplace or silently trust arbitrary publishers. Add a curator's key after verifying it independently, sync its signed catalog and select an exact release. Review shows publisher/key fingerprint, package SHA-256, version, summary, permission differences and full package content. Installation re-downloads and verifies the reviewed bytes and source trust; extensions remain disabled, and templates enter the existing local template library. Updates are explicit version selections, not automatic pulls. An observed package version cannot later change digest or kind, even after disappearing from a catalog. Disabling a source blocks further review/installation; installed versions remain pinned. Signatures establish provenance, not malware safety or game compatibility.

## Verification

`npm run test:fleet` builds both workspaces and runs disposable backend fixtures. Set `OUTPOST_TEST_BROWSER_UI=1` (and `OUTPOST_TEST_BROWSER` when needed) to require the Chromium panel checks too. CI runs the browser-enabled fixture after the release resilience suite on Linux and Windows. Fixture coverage includes reservation collisions/expiry/replay, SDK permission boundaries and native adapters, signed catalog tampering/immutable pins, signed billing lifecycle/retained archives, verified restores/persistent fences and SSH host-key pinning/enrollment callbacks.

Local validation used Windows Chromium and loopback HTTP/SSH with disposable data. It did **not** execute the root installer against a real Linux host, connect to a production WHMCS installation, or start every supported game across real hosts. Those deployment checks and live game/version/OS certification remain release work.
