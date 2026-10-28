# Libvirt virtual machines

Administrators have **Virtual Machines** and **Libvirt Configuration** in the left sidebar. This manages libvirt domains separately from Outpost's game and container instances; existing game-instance permissions do not grant access to VMs.

All guests on the selected connection are discovered automatically, including Cockpit/virt-manager/virsh-created VMs. No Outpost import or ownership record is required. Transient guests can use **Keep VM definition** to become persistent without restarting. See [external workload discovery](external-workloads.md) for connection scope and details.

## Connect a hypervisor

1. Install the libvirt client tools on the Outpost host. `virsh` must be available on the Outpost service account's PATH. Install and configure QEMU/KVM and libvirt on the hypervisor itself.
2. Open **Libvirt Configuration** and select a URI:
   - `qemu:///system`: this host's system VMs.
   - `qemu:///session`: VMs belonging to the operating system account running Outpost.
   - `qemu+ssh://outpost@hypervisor/system`: a remote QEMU/KVM host. An explicit SSH port is supported.
3. Grant the service account permission to connect. For a system connection use the host's libvirt group or polkit policy. For SSH, set up a key and verified `known_hosts` entry for that account. Verify `virsh --connect <URI> list --all` works without interactive prompts. Restart Outpost if group membership or PATH changed.
4. Click **Test connection**, enable management, then **Save settings**. Testing does not persist the draft settings.

Passwords and URI query parameters are deliberately unsupported. There is no password prompt in the panel. SSH commands time out after 20 seconds. Windows Outpost hosts need a virsh client with a working SSH transport to connect to a remote Linux hypervisor; this feature does not turn Windows into a KVM host.

## Manage VMs

- List active and inactive VMs, see state, CPU count, memory, persistence and autostart.
- Start, request guest shutdown/reboot, pause/resume, or force power off. Force off keeps the VM definition and disks but can lose unsaved guest data. Guest shutdown/reboot are asynchronous; state updates on refresh.
- Edit next-boot memory, CPU count and autostart for a stopped persistent VM. Memory and CPU counts must fit the maximum in its definition. Configuration commands run sequentially; an error can leave some fields applied, which the panel reports and reloads.
- Load and edit the inactive domain XML for disks, networks, boot order, graphics and other devices. Saving requires a stopped VM, keeps its UUID, and uses libvirt's schema validation. The editor does not create disk images or install guest operating systems.
- **Define VM from XML** imports a new persistent definition. Names/UUIDs that already exist are rejected. Disks, installation media and networks referenced by the XML must already exist on the hypervisor. Use an existing VM's XML editor for updates.

No VM deletion or disk removal operation is provided. Disabling this integration does not stop guests. Outpost shutdown also leaves VMs running under libvirt's supervision.

## Display preview

Selecting a running VM captures its graphical display through the libvirt screenshot API. Enable **Refresh every 5 seconds** for a preview window or select **Fullscreen**. Background tabs stop requesting frames. Automatic capture stops on error; use **Capture** to retry.

The preview is **read-only**: it does not forward keyboard/mouse input and is not an interactive VNC/SPICE console. It needs a graphics device and a hypervisor driver that implements screenshots. PNG and QEMU's 8-bit P6 PPM screenshots are supported. No VNC/SPICE port is exposed to the browser, no external preview service is needed, and frames are authenticated with the panel session and sent with `Cache-Control: no-store`.

## Access and validation

All API routes require a current administrator account; demoted administrator sessions are rejected. Read-only API keys cannot mutate VM state or settings. Successful changes enter the audit log. Commands use a fixed `virsh` executable, argument arrays, validated domain UUIDs and restricted QEMU URIs. Domain XML rejects DTDs/entities, is bounded to 1 MB, and is stored in temporary private files that are removed after each request. At most four preview captures run concurrently, with one capture per VM.

Libvirt access has the authority of the Outpost service account on the hypervisor. Domain XML is advanced host administration, so VM delegation to non-admin users is not included.

## Verification

```sh
npm run build
node server/test/libvirt.mjs
node server/test/config-access.mjs
```

The libvirt tests use an isolated database and a simulated command runner. They cover URI/UUID validation, resource ceilings, stopped-VM requirements, XML identity, screenshot conversion and HTTP authorization, including demoted sessions and read-only API keys. They do not need a hypervisor.

For a real-host smoke test, connect to a disposable VM with a graphical display. Check inventory and preview, start/pause/resume/shutdown, then save CPU/memory/autostart while stopped. Reload XML, make a harmless change, save and compare with `virsh dumpxml --inactive <UUID>`. Confirm a viewer receives HTTP 403 for inventory, preview and actions. Test the same steps with an SSH URI if using a remote hypervisor.

Command semantics: [official virsh reference](https://www.libvirt.org/manpages/virsh.html). Connection setup: [libvirt connection URIs](https://www.libvirt.org/uri.html).
