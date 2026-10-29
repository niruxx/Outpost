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

  // Creation validates before allocating storage and preserves a defined VM on start failure.
  const createCalls = []; let createdXml = ''; let failStart = false; let failDefine = false;
  const creator = new libvirt.LibvirtClient('qemu:///system', async (_uri, args) => {
    createCalls.push(args);
    if (args[0] === 'pool-info') return 'State: running';
    if (args[0] === 'net-info') return 'Active: yes';
    if (args[0] === 'pool-dumpxml') return "<pool type='dir'/>";
    if (args[0] === 'define') { createdXml = await fs.readFile(args[1], 'utf8'); if (failDefine) throw new Error('Invalid host capabilities'); }
    if (args[0] === 'start' && failStart) throw new Error('ISO is not readable');
    return '';
  });
  const creation = { name: 'new-guest', cpus: 2, memoryMb: 2048, diskMb: 20480, pool: 'default', network: 'default', iso: '/images/linux.iso', start: true, autostart: true };
  await assert.rejects(creator.create({ ...creation, cpus: 0 }), { status: 400 });
  await assert.rejects(creator.create({ ...creation, iso: '/images/../secret.iso' }), { status: 400 });
  assert.equal(createCalls.length, 0);
  const created = await creator.create(creation);
  assert.match(created.uuid, /^[0-9a-f-]{36}$/);
  assert.match(createdXml, /<memory unit='MiB'>2048/);
  assert.match(createdXml, /listen='127.0.0.1'/);
  assert.match(createdXml, /<readonly\/>/);
  assert.deepEqual(createCalls.at(-1), ['start', created.uuid]);
  await creator.create({ ...creation, iso: '', boot: 'network', model: 'e1000e', link: 'down' });
  assert.match(createdXml, /<boot dev='network'\/>/); assert.match(createdXml, /model type='e1000e'/); assert.match(createdXml, /link state='down'/);
  assert(!createdXml.includes("source file=''"));
  await assert.rejects(creator.create({ ...creation, iso: '', boot: 'cdrom' }), { status: 400 });
  failStart = true;
  assert.match((await creator.create(creation)).warning, /VM created.*ISO is not readable/);
  failDefine = true;
  await assert.rejects(creator.create(creation), /Disk default\/.*was retained/);
  assert(!createCalls.some(args => ['vol-delete', 'undefine', 'destroy'].includes(args[0])));

  let deviceXml = `<domain type='kvm'><name>Game VM</name><uuid>${uuid}</uuid><os><type>hvm</type><boot dev='hd'/></os><devices><disk type='file' device='disk'><source file='/images/boot.qcow2'/><target dev='vda' bus='virtio'/></disk><disk type='file' device='cdrom'><source file='/images/linux.iso'/><target dev='sda' bus='sata'/><readonly/></disk><interface type='network'><mac address='52:54:00:12:34:56'/><source network='default'/><model type='virtio'/><address type='pci' slot='0x03'/></interface></devices></domain>`;
  const deviceCalls = []; let deviceState = 'shut off';
  const devices = new libvirt.LibvirtClient('qemu:///system', async (_uri, args) => {
    deviceCalls.push(args);
    if (args[0] === 'dominfo') return info(deviceState);
    if (args[0] === 'dumpxml') return deviceXml;
    if (args[0] === 'define') deviceXml = await fs.readFile(args[1], 'utf8');
    if (args[0] === 'detach-device') assert.match(await fs.readFile(args[2], 'utf8'), /target dev='vda'/);
    return '';
  });
  assert.equal((await devices.devices(uuid)).disks.length, 2);
  await devices.bootDevice(uuid, { target: 'sda' });
  assert(!deviceXml.includes("boot dev='hd'")); assert.match(deviceXml, /<boot order='1'\/><\/disk>/);
  await devices.bootDevice(uuid, { target: 'vda' });
  assert.equal((deviceXml.match(/<boot /g) ?? []).length, 1);
  await devices.media(uuid, { target: 'sda', iso: '' });
  assert.deepEqual(deviceCalls.at(-1), ['change-media', uuid, 'sda', '--eject', '--config']);
  await assert.rejects(devices.media(uuid, { target: 'vda', iso: '' }), { status: 404 });
  await devices.media(uuid, { target: 'sda', iso: '/images/a&b.iso' });
  assert.deepEqual(deviceCalls.at(-1), ['change-media', uuid, 'sda', '/images/a&b.iso', '--update', '--config']);
  await devices.media(uuid, { target: 'sdb', iso: '', add: true });
  assert.match(deviceXml, /target dev='sdb' bus='sata'/);
  await devices.editInterface(uuid, { originalMac: '52:54:00:12:34:56', mac: '52:54:00:65:43:21', network: 'isolated', model: 'e1000e', link: 'down' });
  assert.match(deviceXml, /network='isolated'/); assert.match(deviceXml, /state='down'/); assert.match(deviceXml, /slot='0x03'/);
  assert.match(deviceXml, /52:54:00:65:43:21/);
  assert.throws(() => libvirt.interfaceXml({ network: 'default', mac: 'ff:ff:ff:ff:ff:ff' }), { status: 400 });
  await devices.detachDisk(uuid, 'vda');
  deviceState = 'running';
  await assert.rejects(devices.bootDevice(uuid, { target: 'vda' }), { status: 409 });
  await assert.rejects(devices.media(uuid, { target: 'sda', iso: '' }), { status: 409 });
  await assert.rejects(devices.editInterface(uuid, { mac: '52:54:00:65:43:21', remove: true }), { status: 409 });
  assert(!deviceCalls.some(args => args[0] === 'vol-delete'));

  const imageCalls = [];
  const images = new libvirt.LibvirtClient('qemu+ssh://images-host/system', async (uri, args) => {
    assert.equal(uri, 'qemu+ssh://images-host/system'); imageCalls.push(args);
    if (args[0] === 'pool-info') return 'State: running';
    if (args[0] === 'vol-list') return 'ubuntu.iso\nnotes.txt\nrescue.ISO';
    if (args[0] === 'vol-path') return `/remote/isos/${args[1]}`;
    return '';
  });
  const library = await images.images('/remote/isos');
  assert.equal(library.images.length, 2); assert.equal(library.images[0].path, '/remote/isos/ubuntu.iso');
  assert.equal((await images.images()).directory, '/remote/isos');
  const switched = await images.images('/remote/new-isos'); assert.notEqual(switched.pool, library.pool);
  await assert.rejects(images.images('/remote/../private'), { status: 400 });
  assert(!imageCalls.some(args => ['pool-destroy', 'pool-undefine', 'pool-build'].includes(args[0])));

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
  assert.equal((await req('/vms/create', viewerToken, { method: 'POST', body: JSON.stringify(creation) })).status, 403);
  for (const route of ['/images', `/vms/${uuid}/devices`]) assert.equal((await req(route, viewerToken)).status, 403);
  for (const operation of ['boot', 'media', 'interface', 'detach-disk', 'create-disk']) assert.equal((await req(`/vms/${uuid}/${operation}`, viewerToken, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await req('/vms/create', readOnlyKey, { method: 'POST', body: JSON.stringify(creation) })).status, 403);
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
