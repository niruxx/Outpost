import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-native-containers-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const native = await import('../dist/services/nativeContainerService.js');
const { createDockerRouter } = await import('../dist/routes/docker.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { createKey } = await import('../dist/services/apiKeyService.js');
const id = 'a'.repeat(64), stoppedId = 'b'.repeat(64), managedId = 'c'.repeat(64), missingId = 'd'.repeat(64);
let server;
try {
  const rows = [
    { ID: id, Names: 'cli-web', Image: 'nginx:latest', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:8080->80/tcp', Labels: 'com.docker.compose.project=web,secret=not-public' },
    { ID: stoppedId, Names: 'cli-stopped', Image: 'redis:latest', State: 'exited', Status: 'Exited', Labels: '' },
    { ID: managedId, Names: 'outpost-existing', Image: 'example/app', State: 'running', Status: 'Up', Labels: 'outpost.instance=existing-instance' },
  ];
  const fixtures = new Map(rows.map((row) => [row.ID, {
    Id: row.ID, Name: '/' + row.Names, Created: '2026-01-01T00:00:00Z',
    Config: { Image: row.Image, Env: ['SECRET=not-public'], Labels: row.ID === id ? { 'com.docker.compose.project': 'web' } : row.ID === managedId ? { 'outpost.instance': 'existing-instance' } : {}, Entrypoint: ['/entrypoint'], Cmd: ['serve'] },
    State: { Status: row.State, StartedAt: '2026-01-01T00:00:01Z' }, HostConfig: { AutoRemove: false, Memory: 268435456, NanoCpus: 1500000000, RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { web_default: {} } },
    Mounts: [{ Type: 'bind', Source: '/srv/external-web', Destination: '/usr/share/nginx/html', RW: false }],
  }]));
  const calls = [];
  const run = async (engine, args) => {
    calls.push({ engine, args }); let stdout = '', stderr = '';
    if (args[0] === 'ps') stdout = rows.map((row) => JSON.stringify(row)).join('\n');
    else if (args[0] === 'images') stdout = 'image1\nimage1\nimage2\n';
    else if (args[0] === 'container' && args[1] === 'inspect') {
      const fixture = fixtures.get(args[2]);
      if (!fixture) { const error = new Error('Container disappeared'); error.status = 404; throw error; }
      stdout = JSON.stringify([fixture]);
    } else if (args[0] === 'logs') { stdout = 'stdout line\n'; stderr = 'stderr line\n'; }
    return { stdout, stderr };
  };
  const client = new native.NativeContainerClient('docker', run);
  const listed = await client.list();
  assert.equal(listed.length, 3);
  assert.equal(listed.find((c) => c.id === id).instanceId, null, 'Unlabelled external containers must be discovered');
  assert.equal(listed.find((c) => c.id === stoppedId).state, 'exited');
  assert.equal(listed.find((c) => c.id === id).composeProject, 'web');
  assert(calls[0].args.includes('--all')); assert(calls[0].args.includes('--no-trunc')); assert(!calls[0].args.includes('--filter'));
  assert(!JSON.stringify(listed).includes('not-public'));
  const podman = native.parseContainerList(JSON.stringify([{ Id: id, Names: ['podman-app'], Image: 'example/app', State: 'running', Labels: { 'io.podman.compose.project': 'pod-apps' }, Ports: [{ host_port: 8090, container_port: 80, protocol: 'tcp' }] }]));
  assert.equal(podman[0].name, 'podman-app'); assert.equal(podman[0].composeProject, 'pod-apps');
  assert.match(podman[0].ports, /8090.*80/);
  assert.equal(await client.imageCount(), 2);
  const details = await client.details(id);
  assert.equal(details.memoryMb, 256); assert.equal(details.cpus, 1.5);
  assert.equal(details.mounts[0].source, '/srv/external-web'); assert.equal(details.mounts[0].writable, false);
  assert.equal(details.networks[0], 'web_default'); assert(!JSON.stringify(details).includes('SECRET'));
  assert.match(await client.logs(id), /stdout line\nstderr line/);
  for (const invalid of ['cli-web', '--all', 'abc', '../container']) await assert.rejects(client.details(invalid), { status: 400 });
  await assert.rejects(client.details(missingId), { status: 404 });
  for (const action of ['start', 'stop', 'restart', 'pause', 'unpause', 'kill']) await client.action(id, action);
  await client.update(id, { restartPolicy: 'always', cpus: 2, memoryMb: 512 });
  assert.deepEqual(calls.at(-1).args, ['update', '--restart', 'always', '--memory', '512m', '--cpus', '2', id]);
  assert(!calls.some((call) => ['run', 'create', 'rm'].includes(call.args[0])), 'Native changes must not recreate containers');
  await assert.rejects(client.action(id, 'remove'), { status: 409 });
  await client.action(stoppedId, 'remove');
  assert.deepEqual(calls.at(-1).args, ['rm', stoppedId]);
  assert(!calls.at(-1).args.includes('--volumes')); assert(!calls.at(-1).args.includes('--force'));
  fixtures.get(id).HostConfig.AutoRemove = true;
  await assert.rejects(client.update(id, { restartPolicy: 'always' }), { status: 409 });
  fixtures.get(id).HostConfig.AutoRemove = false;
  const updatesBefore = calls.filter((c) => c.args[0] === 'update').length;
  await assert.rejects(client.update(id, { cpus: -1 }), { status: 400 });
  await assert.rejects(client.update(id, { restartPolicy: '--privileged' }), { status: 400 });
  assert.equal(calls.filter((c) => c.args[0] === 'update').length, updatesBefore);

  const app = express(); app.use(express.json());
  db.prepare("INSERT INTO servers (id, name, platform, loader, version) VALUES ('existing-instance', 'Linked Outpost instance', 'docker', 'docker', 'example/app')").run();
  let supervised = false;
  app.use('/api/docker', createDockerRouter({ status: () => ({ available: true, engine: 'docker', rootless: false, version: 'test', error: null, hint: null }), client: () => client, socket: () => ({ path: '/var/run/docker.sock', hint: null }), supervised: () => supervised }));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/docker`;
  const admin = users.createUser('container-admin', 'test-password-123', 'admin'), viewer = users.createUser('container-viewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin'), viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const request = (route, token, method = 'GET', body) => fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base)).status, 401);
  const overview = await (await request('', adminToken)).json();
  assert.equal(overview.containers.length, 3); assert.equal(overview.counts.images, 2);
  assert.equal(overview.containers.find((c) => c.id === managedId).instance.id, 'existing-instance');
  assert.equal((await (await request('', viewerToken)).json()).containers.length, 0);
  for (const route of [`/containers/${id}`, `/containers/${id}/logs`]) assert.equal((await request(route, viewerToken)).status, 403);
  assert.equal((await request(`/containers/${id}/action`, viewerToken, 'POST', { action: 'stop' })).status, 403);
  const readonly = createKey(admin.id, { name: 'Native monitoring', readOnly: true }).key;
  assert.equal((await request(`/containers/${id}`, readonly)).status, 200);
  assert.equal((await request(`/containers/${id}/action`, readonly, 'POST', { action: 'stop' })).status, 403);
  assert.equal((await request(`/containers/${stoppedId}/action`, adminToken, 'POST', { action: 'remove', confirmation: 'wrong-name' })).status, 400);
  assert.equal((await request(`/containers/${id}/action`, adminToken, 'POST', { action: 'restart' })).status, 200);
  assert.equal((await request(`/containers/${id}`, adminToken, 'PUT', { cpus: 1 })).status, 200);
  supervised = true;
  assert.equal((await request(`/containers/${managedId}/action`, adminToken, 'POST', { action: 'stop' })).status, 409);
  assert.equal((await request(`/containers/${managedId}`, adminToken, 'PUT', { cpus: 1 })).status, 409);
  supervised = false;
  assert.equal((await request(`/containers/${managedId}/action`, adminToken, 'POST', { action: 'stop' })).status, 200);
  assert.equal((await request(`/containers/${missingId}`, adminToken)).status, 404);
  users.updateUserRole(admin.id, 'viewer');
  assert.equal((await request(`/containers/${id}`, adminToken)).status, 403);
  assert.equal((await (await request('', adminToken)).json()).containers.length, 0);
  console.log('External Docker/Compose and Podman discovery, in-place controls, logs, updates, removal, missing IDs and HTTP authorization checks passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); await fs.rm(temp, { recursive: true, force: true });
}
