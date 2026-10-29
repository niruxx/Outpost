import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { once } from 'node:events';
import { runBrowser } from './browserHarness.mjs';
const app = express(); app.use(express.json());
const disk = { path: '/dev/sdb', kernel: 'sdb', id: '8:16', type: 'disk', size: 1073741824, model: 'Disposable fixture', serial: 'FIXTURE-ONLY', filesystem: '', label: '', uuid: '', transport: 'sata', rotational: true, critical: false, readOnly: false, mountpoints: [], children: [], protected: false, reason: null };
const originLv = { ...disk, path: '/dev/games/data', type: 'lvm', filesystem: 'ext4', children: [] };
const array = { ...disk, path: '/dev/md0', type: 'raid5', filesystem: 'ext4' };
let preview;
app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
app.get('/api/auth/me', (_q, r) => r.json({ user: { id: 'owner', username: 'owner', role: 'admin' } }));
app.get('/api/servers', (_q, r) => r.json({ servers: [] }));
app.get('/api/storage', (_q, r) => r.json({ available: true, permissions: ['view', 'raid', 'erase', 'health', 'lvm'], devices: [disk, originLv, array], fstab: [], jobs: [], busy: false, lvm: { available: true, error: null, pvs: [], vgs: [], lvs: [{ path: originLv.path, vg: 'games', name: 'data', kind: 'linear', size: originLv.size, attributes: '-wi-a-----', pool: '', origin: '' }] }, raid: [{ device: array.path, uuid: 'fixture', name: 'array', level: 'raid5', raidDevices: 3, degraded: 0, sync: 'idle', state: 'clean', members: [] }], encryption: [], boot: [], health: { '/dev/sdb': { status: 'warning', checkedAt: '2026-10-28T12:00:00Z', temperatureC: 39, powerOnHours: 321, selfTest: 'Completed: read failure' } } }));
app.post('/api/storage/preview', (q, r) => { preview = q.body; r.json({ ticket: 'fixture', device: disk, operation: preview, confirmation: 'ERASE /dev/sdb FIXTURE-ONLY', destructive: true, explanation: 'Fixture review only; no real disk actions.', affectedDevices: [] }); });
app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  await runBrowser(`http://127.0.0.1:${server.address().port}`, async ({ navigate, text, click, evaluate }) => {
    await navigate('/storage'); await text('/dev/sdb');
    await evaluate("[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') !== null && b.textContent.includes('/dev/sdb')).click()");
    assert.equal(await evaluate("[...document.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.includes('/dev/sdb')).textContent.includes('SMART: warning')"), true);
    await text('Completed: read failure'); await text('321 hours');
    await click('Sanitize disk firmware'); await text('Firmware sanitize method'); await click('Cancel');
    await text('RAID, encryption recovery and disk maintenance');
    await click('Create RAID from blank members'); await text('RAID level'); await click('Cancel');
    await text('SMART');
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Erase') && b.textContent.includes('disk')).click()");
    await text('Whole-disk erasure method'); await click('Preview operation'); await text('ERASE /dev/sdb FIXTURE-ONLY');
    assert.equal(preview.action, 'secureErase'); assert.equal(preview.device, disk.path);
    assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Apply operation').disabled"), true);
    await click('Cancel');
    await evaluate("[...document.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.includes('/dev/games/data')).click()");
    await click('Attach LVM cache'); await text('Blank cache LV in the same VG'); await text('Writethrough'); await click('Cancel');
    await evaluate("[...document.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.includes('/dev/md0')).click()");
    await click('Grow RAID member count'); await text('Target RAID member count'); await click('Preview operation');
    assert.equal(preview.action, 'raidGrow'); assert.equal(preview.raidDevices, 4);

  });
  console.log('Advanced storage controls and serial-aware erasure review render correctly; no execution endpoint provided');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

