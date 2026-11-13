// npm run build --workspace=server && node server/test/game-customization.mjs
// Uses disposable instances and a fake Bedrock process; never runs a game or downloads content.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import AdmZip from 'adm-zip';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-game-customization-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const tf2 = await import('../dist/services/tf2Service.js');
const rules = await import('../dist/services/gameruleService.js');
const { getServer, setServerStatus } = await import('../dist/services/serverService.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const processManager = await import('../dist/services/processManager.js');
const { gameCustomizationRouter } = await import('../dist/routes/gameCustomization.routes.js');
let http;
try {
  for (const [id, platform, loader, version, app, preset] of [
    ['tf', 'steam', 'vanilla', 'latest', '232250', 'tf2'],
    ['java', 'java', 'vanilla', '1.21.11', null, null],
    ['bedrock', 'bedrock', 'vanilla', '1.21.100', null, null],
    ['proxy', 'java', 'velocity', '3.4.0', null, null],
  ]) {
    db.prepare('INSERT INTO servers (id, name, platform, loader, version, steam_app_id, steam_preset, status, isolation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, id, platform, loader, version, app, preset, 'stopped', 'off');
    fs.mkdirSync(instanceDir(id), { recursive: true });
  }
  assert.equal(tf2.isTf2(getServer('tf')), true);
  assert.equal(tf2.isTf2(getServer('java')), false);
  assert.equal(tf2.tf2Map('https://steamcommunity.com/sharedfiles/filedetails/?id=123456789'), 'workshop/123456789');
  for (const bad of ['../bad', 'ctf_2fort; quit', 'foo\nquit', 'workshop/../x', 'https://evil.example/123456789']) assert.throws(() => tf2.tf2Map(bad), { status: 400 });
  assert.throws(() => tf2.sanitizeTf2({ cvars: { mp_timelimit: '30;quit' } }, tf2.tf2SettingsOf(getServer('tf'))), { status: 400 });
  assert.throws(() => tf2.sanitizeTf2({ maxPlayers: -1 }, tf2.tf2SettingsOf(getServer('tf'))), { status: 400 });
  fs.mkdirSync(tf2.tf2Path(getServer('tf'), 'cfg'), { recursive: true });
  fs.writeFileSync(tf2.tf2Path(getServer('tf'), 'cfg/server.cfg'), '// user config\nsv_alltalk 1\n');
  tf2.saveTf2(getServer('tf'), { preset: 'casual', map: 'pl_badwater', rotation: ['ctf_2fort', '123456789'], password: 'private', gslt: 'a'.repeat(32) });
  tf2.prepareTf2(getServer('tf'));
  const cfg = fs.readFileSync(tf2.tf2Path(getServer('tf'), 'cfg/server.cfg'), 'utf8');
  assert.ok(cfg.includes('// user config'));
  assert.equal(cfg.match(/exec outpost.cfg/g).length, 1);
  assert.equal(tf2.tf2LaunchArgs(getServer('tf')).at(-1), 'a'.repeat(32));
  assert.ok(tf2.tf2LaunchArgs(getServer('tf')).includes('pl_badwater'));
  assert.equal(fs.readFileSync(tf2.tf2Path(getServer('tf'), 'cfg/outpost_mapcycle.txt'), 'utf8'), 'ctf_2fort\nworkshop/123456789\n');
  tf2.installTf2Upload(getServer('tf'), 'test.bsp', Buffer.from('VBSP'), 'map');
  assert.ok(tf2.tf2Content(getServer('tf')).maps.includes('test'));
  tf2.installTf2Upload(getServer('tf'), 'test.smx', Buffer.from('plugin'), 'mod');
  tf2.tf2PluginAction(getServer('tf'), 'test.smx', 'plugin', 'disable');
  assert.equal(tf2.tf2Content(getServer('tf')).plugins.find((p) => p.name === 'test.smx').enabled, false);
  tf2.tf2PluginAction(getServer('tf'), 'test.smx', 'plugin', 'enable');
  tf2.tf2PluginAction(getServer('tf'), 'test.smx', 'plugin', 'remove');
  assert.equal(tf2.tf2Content(getServer('tf')).plugins.length, 0);
  const zip = new AdmZip(); zip.addFile('tf/custom/testmod/materials/test.txt', Buffer.from('test'));
  tf2.installTf2Upload(getServer('tf'), 'test.zip', zip.toBuffer(), 'mod');
  tf2.tf2PluginAction(getServer('tf'), 'testmod', 'custom', 'disable');
  assert.ok(fs.existsSync(tf2.tf2Path(getServer('tf'), 'custom_disabled/testmod/materials/test.txt')));
  assert.equal(fs.existsSync(tf2.tf2Path(getServer('tf'), 'custom/testmod')), false);
  tf2.tf2PluginAction(getServer('tf'), 'testmod', 'custom', 'enable');
  const badZip = new AdmZip(); badZip.addFile('server.exe', Buffer.from('bad'));
  assert.throws(() => tf2.installTf2Upload(getServer('tf'), 'bad.zip', badZip.toBuffer(), 'mod'), { status: 400 });
  tf2.tf2FrameworkJobs.set('tf', { state: 'running' });
  assert.throws(() => tf2.prepareTf2(getServer('tf')), { status: 409 });
  tf2.tf2FrameworkJobs.clear();
  if (process.platform === 'win32') {
    const { installTf2Frameworks } = await import('../dist/services/tf2FrameworkService.js');
    const originalFetch = globalThis.fetch;
    fs.writeFileSync(tf2.tf2Path(getServer('tf'), 'gameinfo.txt'), 'fixture');
    const config = tf2.tf2Path(getServer('tf'), 'addons/sourcemod/configs/admins_simple.ini');
    const disabledPlugin = tf2.tf2Path(getServer('tf'), 'addons/sourcemod/plugins/disabled/admin.smx');
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, 'existing admin');
    fs.mkdirSync(path.dirname(disabledPlugin), { recursive: true }); fs.writeFileSync(disabledPlugin, 'disabled');
    globalThis.fetch = async (url) => {
      const prefix = String(url).includes('mmsdrop') ? 'mmsource' : 'sourcemod';
      if (String(url).includes('-latest-')) return new Response(`${prefix}-1.12.0-git123-windows.zip`);
      const archive = new AdmZip();
      if (prefix === 'mmsource') archive.addFile('addons/metamod/bin/server.dll', Buffer.from('fixture'));
      else {
        archive.addFile('addons/sourcemod/bin/sourcemod.dll', Buffer.from('fixture'));
        archive.addFile('addons/sourcemod/configs/admins_simple.ini', Buffer.from('default'));
        archive.addFile('addons/sourcemod/plugins/admin.smx', Buffer.from('default'));
      }
      return new Response(archive.toBuffer());
    };
    try { await installTf2Frameworks(getServer('tf'), () => undefined); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(fs.readFileSync(config, 'utf8'), 'existing admin');
    assert.equal(fs.existsSync(tf2.tf2Path(getServer('tf'), 'addons/sourcemod/plugins/admin.smx')), false, 'framework updates keep disabled plugins disabled');
    assert.equal(tf2.tf2Content(getServer('tf')).frameworks.metamod, true);
    assert.equal(tf2.tf2Content(getServer('tf')).frameworks.sourcemod, true);
  }

  for (const id of ['java', 'bedrock']) rules.saveGamerules(getServer(id), { preset: 'friendly', autoApply: true });
  assert.ok(rules.gameruleCommands(getServer('java')).includes('gamerule keep_inventory true'));
  assert.ok(rules.gameruleCommands(getServer('java')).includes('gamerule fire_spread_radius_around_player 0'));
  assert.ok(rules.gameruleCommands({ ...getServer('java'), version: '1.21.10' }).includes('gamerule keepInventory true'));
  assert.ok(rules.gameruleCommands({ ...getServer('java'), version: '26.1' }).includes('gamerule keep_inventory true'));
  assert.ok(rules.gameruleCommands(getServer('bedrock')).includes('gamerule keepinventory true'));
  assert.ok(rules.gameruleCommands(getServer('bedrock')).includes('gamerule dofiretick false'));
  assert.deepEqual(rules.gameruleCommands(getServer('proxy')), []);
  assert.equal(rules.usesModernGamerules({ ...getServer('java'), version: '25w44a' }), true);
  assert.equal(rules.usesModernGamerules({ ...getServer('java'), version: '1.21.11-pre1' }), true);
  assert.throws(() => rules.sanitizeGamerules({ rules: { 'keepInventory;stop': true } }, rules.gamerulesOf(getServer('java'))), { status: 400 });
  assert.throws(() => rules.sanitizeGamerules({ rules: { keepInventory: 'true' } }, rules.gamerulesOf(getServer('java'))), { status: 400 });

  const admin = users.createUser('admin-test', 'test-password-123', 'admin');
  const viewer = users.createUser('viewer-test', 'test-password-123', 'viewer');
  users.setUserServerAccess(viewer.id, ['tf', 'java', 'bedrock']);
  const app = express(); app.use(express.json());
  app.use((q, _r, next) => { if (q.headers.authorization === 'Bearer browser-fixture') q.headers.authorization = `Bearer ${token(admin)}`; next(); });
  app.use('/api/servers/:serverId', gameCustomizationRouter);
  app.use((err, _q, r, _next) => r.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}/api/servers`;
  const token = (u) => createToken(u.id, u.username, u.role);
  const req = (route, method = 'GET', body, user = admin) => fetch(origin + route, { method, headers: { Authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const view = await (await req('/tf/tf2', 'GET', undefined, viewer)).json();
  assert.equal(view.settings.password, undefined); assert.equal(view.settings.gslt, undefined); assert.equal(view.settings.hasPassword, true);
  assert.equal((await req('/java/gamerules', 'PUT', { preset: 'friendly' }, viewer)).status, 403);
  assert.equal((await req('/tf/tf2', 'PUT', { map: 'ctf_2fort' }, viewer)).status, 403);
  assert.equal((await req('/java/tf2')).status, 400);
  assert.equal((await req('/proxy/gamerules')).status, 400);
  assert.equal((await req('/java/gamerules/apply', 'POST')).status, 409);
  assert.equal((await req('/tf/tf2/action', 'POST', { action: 'changelevel', map: 'ctf_2fort;quit' })).status, 409);
  const form = new FormData(); form.append('file', new Blob(['plugin']), 'another.smx');
  assert.equal((await fetch(origin + '/tf/tf2/upload/mod', { method: 'POST', headers: { Authorization: `Bearer ${token(viewer)}` }, body: form })).status, 403);
  assert.equal((await fetch(origin + '/tf/tf2/upload/mod', { method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: form })).status, 200);

  // End-to-end startup: a disposable Node process impersonates Bedrock and records stdin.
  const fake = path.join(instanceDir('bedrock'), 'fake.cjs');
  const received = path.join(instanceDir('bedrock'), 'received.txt');
  fs.writeFileSync(fake, `const fs = require('fs'); const readline = require('readline'); console.log('Server started.'); readline.createInterface({ input: process.stdin }).on('line', line => { fs.appendFileSync(${JSON.stringify(received)}, line + '\\n'); if (line === 'stop') process.exit(0); });`);
  db.prepare('UPDATE servers SET launch_config = ? WHERE id = ?').run(JSON.stringify({ executable: process.execPath, args: 'fake.cjs', stopTimeoutSec: 2 }), 'bedrock');
  await processManager.startServer('bedrock');
  const until = async (check) => { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for fake server'); await new Promise((r) => setTimeout(r, 50)); } };
  await until(() => fs.existsSync(received) && fs.readFileSync(received, 'utf8').includes('gamerule keepinventory true'));
  assert.equal(fs.readFileSync(received, 'utf8').trim().split('\n').length, 7);
  assert.equal((await req('/bedrock/gamerules/apply', 'POST')).status, 200);
  await processManager.stopServer('bedrock');
  await until(() => !processManager.isRunning('bedrock'));
  if (process.env.OUTPOST_TEST_BROWSER_UI === '1') {
    const { runBrowser } = await import('./browserHarness.mjs');
    app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
    app.get('/api/auth/me', (_q, r) => r.json({ user: { id: admin.id, username: admin.username, role: 'admin', theme: null } }));
    app.get('/api/servers', (_q, r) => r.json({ servers: ['tf', 'java', 'bedrock'].map(getServer) }));
    app.get('/api/servers/:id', (q, r) => r.json({ server: getServer(q.params.id), runtime: null, running: false, permissions: ['settings', 'console', 'plugins', 'files.read', 'power'] }));
    app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
    app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
    await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, text, click, evaluate, until }) => {
      await navigate('/instances/tf/tf2'); await text('Maps & rotation'); await text('Mods & SourceMod plugins');
      assert.equal(await evaluate("[...document.querySelectorAll('a')].some(a => a.textContent.trim() === 'TF2')"), true);
      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Competitive')).click()");
      await click('Save settings'); await text('Saved — applies on next start');
      assert.equal(tf2.tf2SettingsOf(getServer('tf')).maxPlayers, 12);
      assert.equal(tf2.tf2SettingsOf(getServer('tf')).cvars.tf_weapon_criticals, '0');
      await navigate('/instances/java/gamerules'); await text('Gamerule presets');
      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Building')).click()");
      await click('Save gamerules'); await text('gamerule keep_inventory true');
      assert.equal(rules.gamerulesOf(getServer('java')).autoApply, true);
      assert.equal(rules.gamerulesOf(getServer('java')).rules.doMobSpawning, false);
      await navigate('/instances/bedrock/gamerules'); await text('gamerule keepinventory true');
      assert.equal(await evaluate("[...document.querySelectorAll('select')].some(s => s.textContent.includes('Java 1.21.11'))"), false);
      assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save & apply now')).disabled"), true);
      await until(() => evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'page fits viewport');
    });
  }
  console.log('Game customization: TF2 settings, maps, uploads, plugins, permissions, edition-specific gamerules and automatic startup application passed');
} finally {
  processManager.stopAllForShutdown();
  if (http) { http.closeAllConnections(); await new Promise((r) => http.close(r)); }
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
