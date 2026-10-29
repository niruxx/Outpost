# Libvirt virtual machines

Administrators have **Virtual Machines** and **Libvirt Configuration** in the left sidebar. This manages libvirt domains separately from Outpost's game and container instances; existing game-instance permissions do not grant access to VMs. Users with explicit VM grants also see Virtual Machines, showing only their assigned guests.

All guests on the selected connection are discovered automatically, including Cockpit/virt-manager/virsh-created VMs. No Outpost import or ownership record is required. Transient guests can use **Keep VM definition** to become persistent without restarting. See [external workload discovery](external-workloads.md) for connection scope and details.

## Connect a hypervisor

1. Install the libvirt client tools on the Outpost host. `virsh` must be available on the Outpost service account's PATH. Install and configure QEMU/KVM and libvirt on the hypervisor itself.
2. Open **Libvirt Configuration** and select a URI:
   - `qemu:///system`: this host's system VMs.
   - `qemu:///session`: VMs belonging to the operating system account running Outpost.
   - `qemu+ssh://outpost@hypervisor/system`: a remote QEMU/KVM host. An explicit SSH port is supported.
3. Grant the service account permission to connect. For a system connection use the host's libvirt group or polkit policy. For SSH, set up a key and verified `known_hosts` entry for that account. Verify `virsh --connect <URI> list --all` works without interactive prompts. Restart Outpost if group membership or PATH changed.
4. Click **Test connection**, enable management, then **Save settings**. Testing does not persist the draft settings.

Passwords and URI query parameters are deliberately unsupported. There is no password prompt in the panel. Most commands time out after two minutes. Migration runs as a background job without the ordinary command timeout. Windows Outpost hosts need a virsh client with a working SSH transport to connect to a remote Linux hypervisor; this feature does not turn Windows into a KVM host.

## Create a VM

Admins can click **New virtual machine** in **Virtual Machines**. Choose a name, CPU count, memory, disk capacity, active directory storage pool and active virtual network. Supply an absolute path to a Linux installer `.iso` on the selected hypervisor (not the browser or Outpost host when using a remote connection). The hypervisor must be able to read this file.

The form creates an x86_64 KVM guest with Q35/BIOS, a new sparse qcow2 disk and a loopback VNC display, following the [libvirt domain format](https://www.libvirt.org/formatdomain.html). Choose disk, ISO or PXE as the first boot device. Customize the interface network, model (virtio/e1000e/rtl8139), optional unicast MAC and connected/disconnected state. An additional existing raw/qcow2 disk from the selected pool can be attached as vdb; shared writable disks are refused. Optionally start immediately or enable host-boot autostart. Open the created guest's interactive VNC console to finish OS installation. UEFI and other architectures remain XML workflows.

Configure and start a directory pool and network in **Libvirt Configuration** first if none are available. Creation follows existing admin permissions; delegates can manage assigned guests but cannot allocate new host resources. If definition fails after disk creation, the error identifies the retained volume. If startup fails after definition, the VM remains listed with a warning; inspect it before retrying.

## ISO library and VM Images directory

In **Libvirt Configuration**, set **VM Images directory** to an existing absolute directory on the selected hypervisor. Outpost defines/starts a dedicated directory pool, enables its autostart, and refreshes it to discover `.iso` files. The directory is saved per connection and supplies the ISO selectors in creation and device settings. Refresh after copying new files to the directory; scanning is direct rather than recursive. Switching directories retains previous pools and files. Manual absolute ISO paths remain supported. No directory is created or formatted.

## Devices and boot settings

On a selected VM, **Disks, installation media and boot** shows existing disks, CD-ROM drives and interfaces. Stop a persistent VM before making changes:

- Insert, replace or eject an ISO; add an empty or loaded SATA CD-ROM drive.
- Select a disk, loaded CD-ROM or network interface as the boot device. This replaces previous boot priorities; it does not install an OS or make a blank image contain a bootloader.
- Detach a virtual disk while retaining its volume. Use **Storage pools and virtual disks** to create raw/qcow2 images, attach existing volumes, or **Create and attach disk** in one step with a free virtio target (for example vdb).
- Attach interfaces and edit their virtual network, adapter model, MAC address and link state, or remove them. Other interface types remain available through XML. Guest IP configuration is managed inside the guest or by the network's DHCP service.

Changes apply at next start. Media uses libvirt's [change-media command](https://www.libvirt.org/manpages/virsh.html#change-media) without forced ejection. Disk files are retained on detach and when attachment fails after image creation; errors identify the retained image. Refresh devices after attaching an image through the storage form.

## Manage VMs

- List active and inactive VMs, see state, CPU count, memory, persistence and autostart.
- Start, request guest shutdown/reboot, pause/resume, or force power off. Force off keeps the VM definition and disks but can lose unsaved guest data. Guest shutdown/reboot are asynchronous; state updates on refresh.
- Edit next-boot memory, CPU count and autostart for a stopped persistent VM. Memory and CPU counts must fit the maximum in its definition. Configuration commands run sequentially; an error can leave some fields applied, which the panel reports and reloads.
- Load and edit the inactive domain XML for disks, networks, boot order, graphics and other devices. Saving requires a stopped VM, keeps its UUID, and uses libvirt's schema validation. The editor does not create disk images or install guest operating systems.
- **Define VM from XML** imports a new persistent definition. Names/UUIDs that already exist are rejected. Disks, installation media and networks referenced by the XML must already exist on the hypervisor. Use an existing VM's XML editor for updates.

Admins can use **Delete VM entry** on a stopped persistent guest. Type its exact name and confirm to remove its libvirt definition while retaining disk volumes, UEFI NVRAM and TPM state. Save its XML before deletion if you plan to register it again. Outpost removes only that connection/UUID's delegated grants. Running/transient guests cannot be deleted through this control. Snapshot metadata blocks undefinition unless its separate removal checkbox is explicitly selected; its on-disk snapshot data remains. Managed-save/checkpoint state can still cause libvirt to refuse deletion and must be resolved with native tools. The operation uses `undefine --keep-nvram --keep-tpm`, never storage-wipe/delete flags; older clients lacking those preservation options fail safely instead of falling back. No disk removal operation is supplied. Disabling this integration does not stop guests. Outpost shutdown also leaves VMs running under libvirt's supervision.

## Display preview

Selecting a running VM captures its graphical display through the libvirt screenshot API. Enable **Refresh every 5 seconds** for a preview window or select **Fullscreen**. Background tabs stop requesting frames. Automatic capture stops on error; use **Capture** to retry.

The preview is **read-only**: it does not forward keyboard/mouse input and is not an interactive VNC/SPICE console. It needs a graphics device and a hypervisor driver that implements screenshots. PNG and QEMU's 8-bit P6 PPM screenshots are supported. No VNC/SPICE port is exposed to the browser, no external preview service is needed, and frames are authenticated with the panel session and sent with `Cache-Control: no-store`.

## Interactive VNC and SPICE

The separate **Interactive console** card forwards keyboard/mouse input with noVNC or spice-html5. Start the VM, select its configured protocol, enter its display password if configured, and click **Connect**. Ctrl+Alt+Delete, disconnect and fullscreen controls are available. Passwords stay in browser memory and go to the guest display protocol; Outpost does not store them or include them in audit records.

The browser uses an authenticated, same-origin WebSocket bridge, not a direct hypervisor connection. VNC tickets are single-use; SPICE tickets permit a bounded set of channels for 60 seconds because SPICE opens separate display/input/cursor/audio connections. Tickets are tied to the current account, domain and libvirt URI. Revocation, account deletion, disabling libvirt or changing the connection closes active channels within three seconds; sessions last at most eight hours. API keys cannot obtain tickets. Limits bound pending sessions, open channels, message size and buffered bytes. Only connection metadata is audited.

Configure a plain TCP VNC/SPICE graphics listener on hypervisor loopback (preferred). Wildcard listeners are supported but should be restricted by the host firewall. Unix-socket displays, display TLS/SASL and arbitrary remote display addresses are outside this bridge. For a local URI Outpost opens hypervisor loopback; for a remote URI it uses `ssh -W` with noninteractive authentication and strict host-key verification. The Outpost account needs an OpenSSH client, working keys/agent and known-host entries; SSH forwarding must be permitted. No graphics ports need to be opened to browser clients. Use HTTPS for a remote panel so its WebSocket uses WSS, and forward WebSocket upgrades through the panel's reverse proxy. The existing `TERMINAL_ORIGIN` override also applies to this bridge.

The frontend requires browsers supporting ES2022/top-level await. Clients load only when connecting. SPICE uses browser cryptographic randomness for RSA authentication padding rather than the upstream legacy random pool. Browser SPICE supports the codecs/devices implemented by spice-html5; advanced native-client features, USB redirection and file-transfer controls are not supplied here. A protocol mismatch or unsupported authentication/display setup requires changing the VM graphics configuration or using a native viewer.

## Snapshots

**Snapshots** lists libvirt-managed snapshot names. Create, restore and delete require a stopped persistent VM. Creation uses atomic internal snapshots; libvirt rejects unsupported disk formats/layouts (normally use qcow2). Restoring accepts only metadata indicating the guest was shut off when captured, so the panel cannot unexpectedly resume a running-state snapshot. Restoring discards later guest disk state; deletion removes the restore point. Both require confirmation. No forced restore, child deletion or metadata-only deletion is used.

External snapshot-chain merging and live memory snapshots remain native-tool workflows. Snapshots share the VM's storage and are not separate backups. Existing snapshots created by other tools are listed, but names used for operations must use letters, digits, dots, underscores or hyphens and begin with a letter/digit/underscore.

## Storage pools, disks and virtual networks

Admins can manage shared resources in **Libvirt Configuration**, or beneath a selected VM:

- Discover storage pools and volumes; define directory pools pointing to existing hypervisor directories. Start/stop, refresh, toggle autostart and forget definitions. Files remain when a pool is stopped or forgotten. No pool build/format/delete command is offered.
- Create sparse raw/qcow2 file volumes in active directory pools with explicit MiB capacity. Existing volume names are refused. Other pool types remain visible but are not provisioned by this form.
- Attach an existing raw/qcow2 file volume to a stopped persistent VM using a virtio target such as `vdb`. The panel checks known guests' live and inactive XML for explicit references to that path/pool-volume and rejects duplicate targets and detected sharing. Operators must still avoid aliases/symlinks or consumers outside the selected libvirt connection. Disk removal is not supplied; advanced attachment edits use the admin XML editor.
- Discover networks and XML; define NAT, isolated or existing-host-bridge networks. NAT/isolated forms validate an IPv4 gateway, subnet prefix and DHCP range excluding gateway/network/broadcast addresses. Select an unused host subnet. Bridged mode references an already configured host bridge; it does not create one.
- Start/stop networks, toggle autostart, forget definitions and attach a virtio NIC to a stopped persistent VM. Stop/forget prompts describe effects on connected guests. New pool/network definitions are inactive until explicitly started. Use domain XML for custom NIC, MAC, boot or other device options.

## Migration

Admins can start **Migration** to a validated `qemu+ssh://.../system` or `/session` destination. Live migration requires a running persistent guest; offline migration requires a stopped persistent guest and transfers its definition only. Both make the destination definition persistent. Source undefinition is optional and occurs only after successful migration. Retaining the source definition requires ensuring both copies never run against the same disks.

Live migration can copy non-shared writable disks with `--copy-storage-all`. Offline disk copying is refused: shared or separately pre-copied storage must exist there. Prepare matching paths, compatible CPU/machine types, bridges/networks and destination images/pools as required by libvirt. Migration uses the service account's SSH/libvirt access to both ends. This does not configure migration networks, CPU compatibility or storage automatically; SSH management transport alone does not guarantee encryption of QEMU's separate migration/storage streams. Use a trusted migration network or host-configured transport security.

The page submits a background job, polls status and allows **Abort migration** through libvirt's job-abort API. A live migration reaching its one-hour timeout suspends the guest to finish; an abort/failure requires checking guest state at both ends. One migration runs at a time and conflicting VM changes are blocked. Jobs survive browser navigation but job tracking is in memory: restarting Outpost loses tracking and may interrupt the client, so inspect both hypervisors before retrying. Results are audited. Changing the global connection does not retarget an already started migration.

## Delegated VM access

Under **Users → Edit user → Virtual machine access**, grant each VM's **View / preview**, **Power controls**, **Interactive console**, **CPU / memory / autostart**, and **Create / restore / delete snapshots** independently. Any action grant includes viewing; clearing View revokes the whole VM grant. Admins retain full access. These grants apply regardless of the user's game-instance role, so a viewer can receive explicitly authorized VM power controls.

Grants are stored against both the libvirt connection URI and domain UUID. Changing to another URI does not carry them over, even if that host has a matching UUID. Old/stopped/other-connection grants remain visible in the editor for revocation. Refresh/sign in again to refresh sidebar visibility after granting access; backend enforcement always uses current grants. Snapshot access includes destructive restore/delete, and guest console access can control guest sign-in/recovery; delegate deliberately. CPU/memory grants do not add quotas beyond the domain's configured ceilings.

Connection settings, import, persistence, domain XML, pool/network/disk administration and migration remain administrator-only. Delegates cannot read XML that might contain host paths or graphics passwords. Inventory queries only assigned UUIDs and omits the connection URI for delegates.

## Access and validation

Every request checks the current account and VM grants, including old sessions. Connection settings, raw domain XML, import/persistence, shared storage/network resources and migration require a current administrator. VM inventory/preview, power, interactive console, CPU/memory/autostart and snapshots can be granted separately per VM. API keys can read authorized information, but cannot mutate VM state/settings or obtain interactive console tickets. Successful changes enter the audit log. Commands use a fixed `virsh` executable, argument arrays, validated domain UUIDs and restricted QEMU URIs. Domain XML rejects DTDs/entities, is bounded to 1 MB, and is stored in temporary private files that are removed after each request. At most four preview captures run concurrently, with one capture per VM.

Libvirt access has the authority of the Outpost service account on the hypervisor. Domain XML is advanced host administration and remains restricted to administrators; the separately listed VM controls can be delegated.

## Verification

```sh
npm run build
node server/test/libvirt.mjs
node server/test/vm-management.mjs
node server/test/vm-browser.mjs
node server/test/config-access.mjs
```

The libvirt tests use an isolated database and a simulated command runner. They cover URI/UUID validation, resource ceilings, stopped-VM requirements, XML identity, screenshot conversion and HTTP authorization, including demoted sessions and read-only API keys. They do not need a hypervisor.

For a real-host smoke test, connect to a disposable VM with a graphical display. Check inventory and preview, start/pause/resume/shutdown, then save CPU/memory/autostart while stopped. Reload XML, make a harmless change, save and compare with `virsh dumpxml --inactive <UUID>`. Confirm an unassigned viewer sees an empty inventory and receives HTTP 403 for another VM's preview/actions. Grant one VM, check each allowed operation, then revoke access while its console is connected. Test the same steps with an SSH URI if using a remote hypervisor.

The management tests additionally exercise snapshot/pool/disk/network/migration command construction, migration job lifecycle, connection-scoped grants, binary WebSocket forwarding, SPICE multiple channels and live revocation against a local simulated TCP peer. The browser test uses a built frontend and headless Edge (override `OUTPOST_TEST_BROWSER` with a Chrome/Chromium executable on another OS), a simulated VNC handshake/canvas and SPICE protocol initialization. It does not test a complete SPICE session or perform real migration/snapshot/provisioning. Validate those workflows against disposable guests on your Linux hypervisor before using valuable VMs.

Command semantics: [official virsh reference](https://www.libvirt.org/manpages/virsh.html). Connection setup: [libvirt connection URIs](https://www.libvirt.org/uri.html).
