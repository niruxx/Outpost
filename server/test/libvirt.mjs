import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PNG } from 'pngjs';

// Build first: npm run build --workspace=server && node server/test/libvirt.mjs
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-libvirt-test-'));
process.env.OUTPOST_DATA_DIR = dir;
const { db } = await import('../dist/db/db.js');
const libvirt = await import('../dist/services/libvirtService.js');
const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const info = (state = 'shut off', persistent = 'yes') => `Id: -\nName: Game VM\nUUID: ${uuid}\nState: ${state}\nCPU(s): 2\nMax memory: 4194304 KiB\nUsed memory: 2097152 KiB\nPersistent: ${persistent}\nAutostart: disable`;
const ppm = Buffer.concat([Buffer.from('P6\n# guest display\n2 1\n255\n'), Buffer.from([32, 10, 35, 0, 128, 255])]);
let httpServer;
try {
  assert.deepEqual(libvirt.validateLibvirtSettings({ enabled: true, uri: 'qemu:///system' }), { enabled: true, uri: 'qemu:///system' });
  for (const uri of ['qemu:///session', 'qemu+ssh://outpost@hypervisor/system', 'qemu+ssh://user@[::1]:2222/system']) libvirt.validateLibvirtSettings({ enabled: false, uri });
  for (const uri of ['qemu+ssh://host/system?command=evil', 'qemu+ssh://user:password@host/system', 'qemu:///system\nstart evil', '-c', 'http://example.com']) {
    assert.throws(() => libvirt.validateLibvirtSettings({ enabled: true, uri }), { status: 400 });
  }
  assert.throws(() => libvirt.libvirtClient(), { status: 409 });
  libvirt.saveLibvirtSettings({ enabled: true, uri: 'qemu:///session' });
  assert.equal(libvirt.libvirtClient().uri, 'qemu:///session');
  const parsed = libvirt.parseDomainInfo(info());
  assert.equal(parsed.memoryMb, 2048); assert.equal(parsed.maxMemoryMb, 4096); assert.equal(parsed.cpus, 2);
  assert.equal(parsed.autostart, false); assert.equal(parsed.persistent, true);

  const png = libvirt.screenshotToPng(ppm);
  const decoded = PNG.sync.read(png);
  assert.equal(decoded.width, 2); assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.data], [32, 10, 35, 255, 0, 128, 255, 255]);
  assert.deepEqual(libvirt.screenshotToPng(png), png);
  assert.throws(() => libvirt.screenshotToPng(Buffer.from('P6\n99999999 99999999\n255\n')), { status: 422 });
  assert.throws(() => libvirt.screenshotToPng(Buffer.from('P6\n2 1\n255\nabc')), { status: 422 });
  const crlf = Buffer.concat([Buffer.from('P6\r\n1 1\r\n255\r\n'), Buffer.from([1, 2, 3])]);
  assert.deepEqual([...PNG.sync.read(libvirt.screenshotToPng(crlf)).data], [1, 2, 3, 255]);

  let state = 'shut off';
  const calls = [];
  const client = new libvirt.LibvirtClient('qemu:///system', async (uri, args) => {
    assert.equal(uri, 'qemu:///system'); calls.push(args);
    if (args[0] === 'list') return uuid;
    if (args[0] === 'dominfo') return info(state);
    if (args[0] === 'vcpucount') return '4';
    if (args[0] === 'dumpxml') return `<domain type="kvm"><name>Game VM</name><uuid>${uuid}</uuid></domain>`;
    if (args[0] === 'screenshot') await fs.writeFile(args[2], ppm);
    if (args[0] === 'define') assert.match(await fs.readFile(args[1], 'utf8'), /<domain/);
    return '';
  });
  assert.equal((await client.list())[0].uuid, uuid);
  await client.action(uuid, 'start');
  assert.deepEqual(calls.at(-1), ['start', uuid]);
  await assert.rejects(client.action('--help', 'start'), { status: 400 });
  await assert.rejects(client.action(uuid, 'delete'), { status: 400 });
  state = 'running';
  await assert.rejects(client.configure(uuid, { memoryMb: 1024, cpus: 2, autostart: true }), { status: 409 });
  state = 'shut off';
  await assert.rejects(client.configure(uuid, { memoryMb: 8192, cpus: 2, autostart: true }), { status: 400 });
  await assert.rejects(client.configure(uuid, { memoryMb: 1024, cpus: 5, autostart: true }), { status: 400 });
  assert.equal(calls.some((args) => args[0] === 'setmem'), false);
  await client.configure(uuid, { memoryMb: 1024, cpus: 3, autostart: false });
  assert.deepEqual(calls.slice(-3), [['setmem', uuid, '1024MiB', '--config'], ['setvcpus', uuid, '3', '--config'], ['autostart', uuid, '--disable']]);
  const xml = await client.xml(uuid);
  assert.deepEqual(calls.at(-1), ['dumpxml', uuid, '--inactive']);
  await assert.rejects(client.define(xml), { status: 409 });
  await assert.rejects(client.define('<!DOCTYPE domain><domain/>'), { status: 400 });
  await assert.rejects(client.define(xml.replace(uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), uuid), { status: 400 });
  await client.define(xml, uuid);
  assert.equal(calls.at(-1)[0], 'define'); assert.equal(calls.at(-1)[2], '--validate');
  assert.deepEqual(await client.screenshot(uuid), png);
  assert.deepEqual(await fs.readdir(path.join(dir, 'libvirt-tmp')), []);

  // External Cockpit/virsh guests need no Outpost server row or ownership label.
  const externalUuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const transientUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const vanishedUuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  let kept = false;
  const externalCalls = [];
  const external = new libvirt.LibvirtClient('qemu:///system', async (_uri, args) => {
    externalCalls.push(args);
    if (args[0] === 'list') return [externalUuid, transientUuid, vanishedUuid].join('\n');
    if (args[0] === 'dominfo') {
      if (args[1] === vanishedUuid) throw new Error('Domain not found');
      return info(args[1] === transientUuid ? 'running' : 'shut off', args[1] === transientUuid && !kept ? 'no' : 'yes').replace(uuid, args[1]).replace('Game VM', args[1] === externalUuid ? 'Cockpit guest' : 'virsh transient');
    }
    if (args[0] === 'dumpxml') return `<domain type="kvm"><name>virsh transient</name><uuid>${transientUuid}</uuid></domain>`;
    if (args[0] === 'define') { assert.match(await fs.readFile(args[1], 'utf8'), new RegExp(transientUuid)); kept = true; }
    return '';
  });
  const discovered = await external.list();
  assert.equal(discovered.length, 2); assert(discovered.some((vm) => vm.name === 'Cockpit guest'));
  assert.equal(discovered.find((vm) => vm.uuid === transientUuid).persistent, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  assert.deepEqual(externalCalls[0], ['list', '--all', '--uuid']);
  await external.action(externalUuid, 'start');
  assert.deepEqual(externalCalls.at(-1), ['start', externalUuid]);
  await external.makePersistent(transientUuid);
  assert.equal(kept, true); assert.equal((await external.info(transientUuid)).persistent, true);
  assert(!externalCalls.some((args) => ['destroy', 'shutdown', 'start'].includes(args[0]) && args[1] === transientUuid));

  // Real HTTP middleware checks: anonymous, non-admin, demoted session, read-only API key.
  const { libvirtRouter } = await import('../dist/routes/libvirt.routes.js');
  const users = await import('../dist/services/userService.js');
  const { createToken } = await import('../dist/auth/tokens.js');
  const admin = users.createUser('vmadmin', 'test-password-123', 'admin');
  const viewer = users.createUser('vmviewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin');
  const viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const { createKey } = await import('../dist/services/apiKeyService.js');
  const readOnlyKey = createKey(admin.id, { name: 'VM monitoring', readOnly: true }).key;
  const app = express(); app.use(express.json()); app.use('/api/libvirt', libvirtRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}/api/libvirt`;
  const req = (route, token, init = {}) => fetch(base + route, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  assert.equal((await fetch(base + '/settings')).status, 401);
  assert.equal((await req('/settings', viewerToken)).status, 403);
  assert.equal((await req('/vms/' + uuid + '/preview', viewerToken)).status, 403);
  assert.equal((await req('/settings', adminToken)).status, 200);
  assert.equal((await req('/settings', readOnlyKey)).status, 200);
  assert.equal((await req('/settings', readOnlyKey, { method: 'PUT', body: JSON.stringify({ enabled: false, uri: 'qemu:///system' }) })).status, 403);
  assert.equal((await req('/vms/' + uuid + '/action', readOnlyKey, { method: 'POST', body: JSON.stringify({ action: 'destroy' }) })).status, 403);
  const before = libvirt.libvirtSettings();
  assert.equal((await req('/settings', adminToken, { method: 'PUT', body: JSON.stringify({ enabled: true, uri: 'evil' }) })).status, 400);
  assert.deepEqual(libvirt.libvirtSettings(), before);
  users.updateUserRole(admin.id, 'viewer');
  assert.equal((await req('/settings', adminToken)).status, 403);
  console.log('Libvirt service, screenshots, configuration validation and HTTP authorization checks passed');
} finally {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
}
