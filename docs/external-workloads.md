# Manage workloads created outside Outpost

No import or Outpost ownership label is required to discover host containers and libvirt VMs. Administrators can use the **Docker** and **Virtual Machines** sidebar pages to manage these native resources directly. They are separate from the game/application instance records in the Instances dashboard.

## Docker and Podman

The Docker page's **Containers on this engine** inventory queries all running and stopped containers, not just containers with an `outpost.instance` label. It refreshes every eight seconds while the browser tab is visible. This includes containers started by the Docker CLI, Compose, Portainer, or another tool against the same engine. Podman is also supported when it is the selected engine.

Select a container to:

- Start, stop, restart, pause/resume or force stop it.
- Read its most recent 500 log lines, with bounded output.
- Inspect published ports, mounts, networks, command, image and Compose project.
- Update restart policy, CPU limit or memory limit in place when supported by the engine/container platform.
- Remove a stopped container after confirming its name. The writable container layer is removed; named volumes, anonymous volumes and bind-mounted host directories are not explicitly deleted.

Power/settings operations use full engine container IDs. They do not call Outpost's instance provisioning code, recreate the container, move its data, rewrite environment variables, change port bindings or replace mounts. Existing Compose/systemd/Swarm reconciliation can still override manual changes or restart/recreate workloads according to its own configuration. Auto-remove containers can disappear when stopped and cannot have a restart policy added. Some memory updates need compatible swap/cgroup configuration; the engine's error is shown rather than silently changing other limits. Windows containers do not support all Docker update operations.

Containers linked to an active Outpost process supervisor show an instance link and use that instance's normal controls for changes. This avoids two competing power/restart controllers. Labelled leftovers without an active supervisor remain visible and can be controlled natively. Discovery does not adopt unlabelled containers into Outpost's instance lifecycle or give them instance backups/scheduling automatically.

Engine-wide inventory, details and changes require a **current administrator account**. Non-admin users keep seeing only their assigned Outpost container instances; creation permissions do not grant access to unrelated host workloads. Read-only API keys can monitor as an administrator but cannot change containers. Actions/settings changes enter the audit log.

### Connection scope

Outpost uses the Docker/Podman CLI as the operating system account running its service. It sees the engine, context, socket and rootless namespace available to that account. To match your own `docker ps -a`, use the same Docker context/`DOCKER_HOST` and account permissions for Outpost. If both engines are installed, Outpost uses its selected engine; `OUTPOST_CONTAINER_ENGINE=docker` or `podman` pins it. It does not merge every user's rootless engines or every Docker context into a single inventory.

## Libvirt / Cockpit VMs

The Virtual Machines page uses `virsh list --all --uuid` against the configured connection. It lists VMs regardless of whether they were created in Cockpit, virt-manager, virsh, Outpost's XML import, or another libvirt client. Running, stopped and transient domains are included. The page displays the connection URI and refreshes every ten seconds while visible. Domains that disappear during discovery are omitted.

Existing VMs immediately have the same power, preview and configuration controls as any other listed guest, subject to its state and persistence. There is no Outpost server-record or ownership-label requirement. Set up the connection in **Libvirt Configuration**; see [libvirt setup](libvirt.md).

If a Cockpit VM is missing, check that both tools use the **same host and libvirt URI**. `qemu:///system` and `qemu:///session` contain different guests, and session guests belong to the OS account making the connection. For another host, configure the matching SSH URI. Discovery does not scan other users' sessions or silently connect to additional hypervisors.

Transient guests may disappear from libvirt when shut down. **Keep VM definition** saves that running guest's own XML as a persistent domain with its UUID and devices intact, without restarting it. Stop it normally afterwards if you want to change next-boot CPU/memory or XML. Outpost shutdown leaves these VMs running under libvirt.

## Verification

```sh
npm run build
node server/test/native-containers.mjs
node server/test/libvirt.mjs
```

These tests use simulated engine/libvirt responses and an isolated panel database. They cover external/unlabelled containers, stopped containers, Compose/Podman metadata, native commands and updates, volume-preserving removal, disappeared IDs, live admin checks, read-only keys, Cockpit-style guests without database records, transient guests and persistence without power cycling. No live Docker daemon or hypervisor is required; real host integration should also be checked against disposable workloads on the intended connection.

References: [Docker container inventory](https://docs.docker.com/reference/cli/docker/container/ls/), [Docker in-place updates](https://docs.docker.com/reference/cli/docker/container/update/), [Podman updates](https://docs.podman.io/en/latest/markdown/podman-update.1.html), [virsh](https://www.libvirt.org/manpages/virsh.html).
