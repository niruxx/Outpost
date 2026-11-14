// npm run build && node server/test/world-health.mjs
// Structural fixture worlds only; no games are launched or real user saves modified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import express from 'express';
import * as nbt from 'prismarine-nbt';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-world-health-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const { worldHealthRouter } = await import('../dist/routes/worldHealth.routes.js');
const { authRouter } = await import('../dist/routes/auth.routes.js');
const service = await import('../dist/services/worldHealthService.js');
const parser = await import('../dist/services/worldHealthParsers.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { listBackups, resolveBackupPath } = await import('../dist/services/backupService.js');
import AdmZip from 'adm-zip';
const rootNbt = value => nbt.writeUncompressed({ type: 'compound', name: '', value });
const level = zlib.gzipSync(rootNbt({ Data: { type: 'compound', value: { LevelName: { type: 'string', value: 'Fixture' }, RandomSeed: { type: 'long', value: [0, 42] } } } }));
function region(x = 0, z = 0) { const data = zlib.deflateSync(rootNbt({ xPos: { type: 'int', value: x }, zPos: { type: 'int', value: z } })); const bytes = Buffer.alloc(12288); bytes.writeUInt32BE(513, 0); bytes.writeUInt32BE(data.length + 1, 8192); bytes[8196] = 2; data.copy(bytes, 8197); return bytes; }
const string = text => { const bytes = Buffer.from(text); assert.ok(bytes.length < 128); return Buffer.concat([Buffer.from([bytes.length]), bytes]); };
function terraria(id = 123) {
  const title = string('Fixture world'), seed = string('seed'), metadata = Buffer.alloc(8 + 16 + 28); metadata.fill(7, 8, 24); metadata.writeInt32LE(id, 24); metadata.writeInt32LE(1200, 44); metadata.writeInt32LE(4200, 48);
  const body = Buffer.concat([title, seed, metadata]), count = 11, header = Buffer.alloc(28 + count * 4 + 1); header.writeUInt32LE(279, 0); header.write('relogic', 4); header[11] = 2; header.writeInt16LE(count, 24); header.writeInt16LE(1, 26 + count * 4); header[header.length - 1] = 1;
  const parts = [body, ...Array.from({ length: count - 2 }, () => Buffer.alloc(4))]; let offset = header.length; const pointers = [offset]; for (const part of parts) { offset += part.length; pointers.push(offset); } pointers.forEach((v, i) => header.writeInt32LE(v, 26 + i * 4)); const footerId = Buffer.alloc(4); footerId.writeInt32LE(id); return Buffer.concat([header, ...parts, Buffer.from([1]), title, footerId]);
}
let http;
const waitFor = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('World check timeout'); };
try {
  assert.equal(parser.inspectRegion(region(), 'world/region/r.0.0.mca').findings.length, 0);
  assert.equal(parser.inspectRegion(region(99, 0), 'world/region/r.0.0.mca').findings[0].code, 'chunk-unreadable');
  const overlap = region(); overlap.writeUInt32BE(513, 4); assert.equal(parser.inspectRegion(overlap, 'world/region/r.0.0.mca').findings.filter(f => f.code === 'chunk-overlap').length, 2);
  const truncated = region(); truncated.writeUInt32BE(5000, 8192); assert.equal(parser.inspectRegion(truncated, 'world/region/r.0.0.mca').findings[0].severity, 'error');
  const unknown = region(); unknown[8196] = 4; assert.equal(parser.inspectRegion(unknown, 'world/region/r.0.0.mca').findings[0].severity, 'warning');
  assert.equal(parser.inspectRegion(region().subarray(0, 12287), 'world/region/r.0.0.mca').padSafe, true);
  assert.equal(parser.inspectLevel(level, 'world/level.dat').checked, 1);
  assert.equal(parser.inspectTerraria(terraria(), 'worlds/test.wld').findings.length, 0);
  assert.equal(parser.inspectTerraria(terraria().subarray(0, -2), 'worlds/test.wld').findings[0].severity, 'error');
  const future = terraria(); future.writeUInt32LE(1000, 0); assert.equal(parser.inspectTerraria(future, 'worlds/future.wld').findings[0].severity, 'warning');
  const admin = users.createUser('health-admin', 'test-password-123', 'admin'), reader = users.createUser('health-reader', 'test-password-123', 'viewer'), outsider = users.createUser('health-outsider', 'test-password-123', 'viewer');
  for (const [id, platform] of [['java-world', 'java'], ['terraria-world', 'steam']]) {
    db.prepare('INSERT INTO servers(id,name,platform,loader,version,status,steam_preset,steam_app_id) VALUES (?,?,?,?,?,?,?,?)').run(id, id, platform, 'vanilla', '1.21.1', 'stopped', platform === 'steam' ? 'terraria' : null, platform === 'steam' ? '105600' : null);
    fs.mkdirSync(instanceDir(id), { recursive: true });
  }
  const java = instanceDir('java-world'), terra = instanceDir('terraria-world'); fs.mkdirSync(path.join(java, 'world', 'region'), { recursive: true }); fs.mkdirSync(path.join(terra, 'worlds'));
  fs.writeFileSync(path.join(java, 'world', 'level.dat'), 'damaged'); fs.writeFileSync(path.join(java, 'world', 'level.dat_old'), level); fs.writeFileSync(path.join(java, 'world', 'region', 'r.0.0.mca'), region().subarray(0, 12287));
  fs.writeFileSync(path.join(terra, 'worlds', 'test.wld'), terraria().subarray(0, -2)); fs.writeFileSync(path.join(terra, 'worlds', 'test.wld.bak'), terraria());
  users.setUserServerAccess(reader.id, [{ serverId: 'java-world', permissions: ['files.read'] }]);
  const token = user => createToken(user.id, user.username, user.role);
  const app = express(); app.use(express.json()); app.use((q, _r, next) => { if (q.headers.authorization === 'Bearer browser-fixture') q.headers.authorization = `Bearer ${token(admin)}`; next(); }); app.use('/api/auth', authRouter); app.use('/api/servers/:serverId/world-health', worldHealthRouter); app.use((err, _q, r, _next) => r.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening'); const origin = `http://127.0.0.1:${http.address().port}`;
  const request = (id, action = '', method = 'GET', body, user = admin) => fetch(`${origin}/api/servers/${id}/world-health${action}`, { method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const scan = async id => { const response = await request(id, '/scan', 'POST'); assert.equal(response.status, 202, await response.clone().text()); await waitFor(() => service.worldHealthReport(id)?.status !== 'scanning'); const report = service.worldHealthReport(id); assert.equal(report.status, 'complete', report.error); return report; };
  assert.equal((await request('java-world', '', 'GET', null, null)).status, 401); assert.equal((await request('java-world', '', 'GET', null, outsider)).status, 403); assert.equal((await request('java-world', '', 'GET', null, reader)).status, 200);
  const before = fs.readFileSync(path.join(java, 'world', 'level.dat')); let report = await scan('java-world'); assert.deepEqual(fs.readFileSync(path.join(java, 'world', 'level.dat')), before, 'read-only scan never modifies the world');
  assert.equal(report.repairs.length, 2); const levelRepair = report.repairs.find(r => r.target === 'world/level.dat');
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: levelRepair.id, confirm: true }, reader)).status, 403);
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: levelRepair.id })).status, 400);
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: '../../escape', confirm: true })).status, 400);
  const repaired = await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: levelRepair.id, confirm: true }); assert.equal(repaired.status, 200, await repaired.clone().text()); const recovery = await repaired.json();
  assert.deepEqual(fs.readFileSync(path.join(java, 'world', 'level.dat')), level);
  assert.equal(new AdmZip(resolveBackupPath('java-world', recovery.backup)).readAsText('world/level.dat'), 'damaged', 'mandatory backup preserves original damaged bytes');
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: levelRepair.id, confirm: true })).status, 409, 'old repair cannot be replayed');
  report = await scan('java-world'); const padding = report.repairs.find(r => r.kind === 'pad'); const regionFile = path.join(java, 'world', 'region', 'r.0.0.mca'); fs.appendFileSync(regionFile, Buffer.from([2]));
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: padding.id, confirm: true })).status, 409, 'changed file invalidates proposal');
  fs.writeFileSync(regionFile, region().subarray(0, 12287)); report = await scan('java-world');
  assert.equal((await request('java-world', '/repair', 'POST', { reportId: report.id, repairId: report.repairs.find(r => r.kind === 'pad').id, confirm: true })).status, 200); assert.equal(fs.statSync(regionFile).size, 12288);
  let tr = await scan('terraria-world'); assert.equal(tr.repairs.length, 1);
  fs.writeFileSync(path.join(terra, 'worlds', 'test.wld.bak'), terraria(999)); tr = await scan('terraria-world'); assert.equal(tr.repairs.length, 0, 'backup for a different identity is not offered');
  fs.writeFileSync(path.join(terra, 'worlds', 'test.wld.bak'), terraria()); fs.writeFileSync(path.join(terra, 'worlds', 'test.twld'), 'mod companion'); tr = await scan('terraria-world'); assert.equal(tr.repairs.length, 0, 'modded companion prevents partial restore'); fs.unlinkSync(path.join(terra, 'worlds', 'test.twld'));
  tr = await scan('terraria-world'); const restored = await request('terraria-world', '/repair', 'POST', { reportId: tr.id, repairId: tr.repairs[0].id, confirm: true }); assert.equal(restored.status, 200, await restored.clone().text()); assert.deepEqual(fs.readFileSync(path.join(terra, 'worlds', 'test.wld')), terraria());
  db.prepare("UPDATE servers SET status='running' WHERE id='java-world'").run(); assert.equal((await request('java-world', '/scan', 'POST')).status, 409); db.prepare("UPDATE servers SET status='stopped' WHERE id='java-world'").run();
  const lock = service.startWorldHealth('java-world'); assert.throws(() => service.assertWorldHealthIdle('java-world'), { status: 409 }); service.cancelWorldHealth('java-world'); await waitFor(() => service.worldHealthReport('java-world').status !== 'scanning');
  assert.ok(listBackups('java-world').length >= 2);
  if (process.env.OUTPOST_TEST_BROWSER_UI === '1') {
    const {instanceCapabilitiesRouter}=await import('../dist/routes/gameCapabilities.routes.js');
    app.use('/api/servers/:serverId/capabilities',instanceCapabilitiesRouter);
    fs.writeFileSync(regionFile, region().subarray(0, 12287)); await scan('java-world');
    const { runBrowser } = await import('./browserHarness.mjs');
    app.get('/api/servers', (_q, r) => r.json({ servers: db.prepare('SELECT * FROM servers').all(), metrics: {} })); app.get('/api/servers/:serverId', (q, r) => r.json({ server: db.prepare('SELECT * FROM servers WHERE id=?').get(q.params.serverId), permissions: [...users.SERVER_PERMISSIONS], running: false, runtime: null })); app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' })); app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
    await runBrowser(origin, async ({ navigate, text, evaluate, until, viewport, captureScreenshot }) => {
      await navigate('/instances/java-world/world-health'); await text('World overview');
      await evaluate("const s=document.querySelector('select[aria-label=\"World file to inspect\"]');s.value='world/region/r.0.0.mca';s.dispatchEvent(new Event('change',{bubbles:true}))"); await text('Fix trailing sector padding');
      assert.equal(await evaluate('document.querySelectorAll("svg[role=group] rect").length'), 1024);
      await evaluate('document.querySelector("svg[role=group] rect").dispatchEvent(new MouseEvent("click",{bubbles:true}))'); await text('Selected chunk: 0, 0');
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Back up and fix').click()"); await text('Back up and fix this world file?'); await evaluate("[...document.querySelectorAll('[aria-modal=true] button')].find(b=>b.textContent==='Cancel').click()"); await until(() => evaluate("!document.querySelector('[aria-modal=true]')"), 'repair confirmation cancelled'); assert.equal(fs.statSync(regionFile).size, 12287);
      await viewport(390, 844); assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true); if (process.env.OUTPOST_WORLD_SCREENSHOT) { await evaluate("const main=document.querySelector('.ui-main'); main.scrollTop+=document.querySelector('svg[role=group]').getBoundingClientRect().top-main.getBoundingClientRect().top-20"); await captureScreenshot(process.env.OUTPOST_WORLD_SCREENSHOT); }
    });
  }
  console.log('World Health: Java regions/NBT, Terraria envelopes, read-only scans, backup-first repairs, stale-file/identity checks, permissions, locks and cancellation passed.');
} finally { service.stopWorldHealth(); if (http) { http.closeAllConnections(); await new Promise(r => http.close(r)); } db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
