// npm run build && node server/test/game-controls.mjs
// All data is disposable; no real games or downloads are started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import express from 'express';
import AdmZip from 'adm-zip';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-game-controls-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const { GAME_PROFILES } = await import('../dist/services/gameControlProfiles.js');
const { STEAM_GAME_PRESETS } = await import('../dist/services/steamGames.js');
const controls = await import('../dist/services/gameControlsService.js');
const native = await import('../dist/services/nativeGameConfig.js');
const sf = await import('../dist/services/satisfactoryService.js');
const { getServer } = await import('../dist/services/serverService.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { gameControlsRouter } = await import('../dist/routes/gameControls.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
let http;
try {
  assert.deepEqual(STEAM_GAME_PRESETS.filter((p) => !['cs2', 'tf2', 'gmod'].includes(p.id)).map((p) => p.id).sort(), GAME_PROFILES.map((p) => p.id).sort(), 'Every remaining preset has a UI/settings adapter');
  for (const [i, profile] of GAME_PROFILES.entries()) {
    db.prepare('INSERT INTO servers (id,name,platform,loader,version,steam_app_id,steam_preset,status,server_port,game_settings) VALUES (?,?,?,?,?,?,?,?,?,?)').run(profile.id, `Fixture ${profile.id}`, 'steam', 'vanilla', 'latest', profile.appId, profile.id, 'stopped', 30000 + i, JSON.stringify({ otherGameSettings: { keep: true } }));
    fs.mkdirSync(instanceDir(profile.id), { recursive: true });
    const server = getServer(profile.id);
    const initial = profile.format === 'palworld' ? '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName="Existing",ServerPassword="private",UnknownNative="keep,comma",CrossplayPlatforms=(Steam,Xbox))\n'
      : profile.format === 'xml' ? '<ServerSettings>\n<!-- keep comment -->\n<property name="ServerName" value="Existing" />\n<property value="keep" name="UnknownNative" />\n</ServerSettings>\n'
      : profile.format === 'ini' ? '[Other]\nUnknownNative=keep\n[ServerSettings]\nServerPassword=private\nXPMultiplier=2.5\n[Last]\nExtra=keep\n'
      : profile.format === 'arma' ? '// keep comment\nhostname = "Existing";\nclass Missions { class First { template = "mission.Altis"; difficulty = "Regular"; class Params { Extra=7; }; }; };\n'
      : profile.format === 'commands' ? '// keep comment\nName Existing\nPassword private\nPort 30001\nUnknownNative keep\n'
      : profile.format === 'kv' ? '# keep comment\nUnknownNative=keep\n'
      : profile.format === 'bo3' ? '// keep comment\nset live_steam_server_name "Existing"\nset UnknownNative "keep"\nset sv_maprotation "gametype tdm map mp_biodome gametype dom map mp_spire"\n'
      : profile.format === 'quake' ? '// keep comment\nseta sv_hostname "Existing"\nset UnknownNative "keep"\n'
      : '// keep comment\nhostname "Existing"\nUnknownNative "keep"\nrcon_password "do-not-change"\n';
    if (profile.file) { const file = controls.gameFile(server, controls.resolvedFile(server, profile.file)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, initial); }
    const preset = STEAM_GAME_PRESETS.find((p) => p.id === profile.id);
    const original = preset.buildLaunchArgs(server);
    const before = controls.gameControlsView(server, true);
    const values = { ...before.settings.values };
    const nameField = profile.fields.find((f) => /server name|session name|public server name/i.test(f.label));
    if (nameField) values[nameField.key] = `Managed ${profile.id}`;
    if (profile.id === 'valheim') values.password = 'secret-pass';
    controls.saveGameControls(server, { revision: before.revision, values, port: server.server_port + 1000, ...(profile.map?.rotation ? { rotation: before.settings.rotation } : {}) });
    const updated = getServer(profile.id), after = controls.gameControlsView(updated, true);
    assert.equal(updated.server_port, server.server_port + 1000);
    assert.equal(JSON.parse(updated.game_settings).otherGameSettings.keep, true);
    if (nameField) assert.equal(after.settings.values[nameField.key], `Managed ${profile.id}`);
    assert.throws(() => controls.saveGameControls(updated, { revision: before.revision, values }), { status: 409 });
    if (profile.file) {
      const text = fs.readFileSync(controls.gameFile(updated, controls.resolvedFile(updated, profile.file)), 'utf8');
      if (profile.format !== 'arma') assert.ok(text.includes('UnknownNative'), `${profile.id} preserves unknown fields`);
      if (profile.format === 'palworld') { assert.ok(text.includes('CrossplayPlatforms=(Steam,Xbox)')); assert.ok(text.includes('UnknownNative="keep,comma"')); }
      if (profile.format === 'arma') assert.ok(text.includes('class Params { Extra=7; }'), 'unchanged mission lists preserve custom mission parameters');
      if (profile.format === 'bo3') assert.ok(text.includes('gametype dom map mp_spire'), 'unchanged mixed-mode rotations are preserved');
    }
    const args = preset.buildLaunchArgs(updated);
    assert.ok(args.length > 0);
    if (profile.map?.live && profile.id !== 'arma3') assert.ok(args.includes(after.settings.values[profile.map.key]), `${profile.id} selected map reaches launch arguments`);
    if (profile.id === 'quakelive') assert.equal(args.filter((a) => a === 'ffa').length, 1, 'old factory tokens are not left behind');
    if (profile.id === 'ark') assert.ok(args[0].includes(`Port=${updated.server_port}`));
    if (profile.id === 'valheim') { assert.ok(args.includes('secret-pass')); assert.ok(!updated.game_settings.includes('secret-pass')); }
    if (profile.id === 'terraria') { assert.ok(args.includes('-config')); assert.ok(!args.includes('-world'), 'old world launch flags cannot override the saved config'); }
    if (profile.id === 'project_zomboid') assert.ok(args.some((a) => a.includes('-cachedir=')), 'existing cache isolation stays in place');
    controls.prepareGameControls(updated, profile.id);
    if (profile.fields.some((f) => f.type === 'password')) assert.ok(Object.values(after.settings.values).every((v) => v !== 'private'));
    assert.ok(original.length);
  }
  const css = getServer('css');
  const legacyCss = controls.controlsOf({ ...css, game_settings: null, extra_args: '+map workshop/123456/custom +maxplayers 20 +sv_password "old-private"' });
  assert.equal(legacyCss.values.map, 'workshop/123456/custom'); assert.equal(legacyCss.values.sv_password, 'old-private');
  const customTerraria = { ...getServer('terraria'), game_settings: null, extra_args: '-config custom-world.txt' };
  assert.equal(controls.resolvedFile(customTerraria, 'serverconfig.txt'), 'custom-world.txt');
  const arma = controls.gameControlsView(getServer('arma3'), true);
  controls.saveGameControls(getServer('arma3'), { revision: arma.revision, values: { ...arma.settings.values, difficulty: 'Veteran' }, rotation: arma.settings.rotation });
  const armaText = fs.readFileSync(controls.gameFile(getServer('arma3'), 'server.cfg'), 'utf8');
  assert.ok(armaText.includes('difficulty = "Veteran"')); assert.ok(armaText.includes('class Params { Extra=7; }'));
  assert.throws(() => controls.validateMap('de_dust2;quit', GAME_PROFILES.find((p) => p.id === 'css')), { status: 400 });
  assert.throws(() => controls.validateMap('../outside', GAME_PROFILES.find((p) => p.id === 'css')), { status: 400 });
  controls.uploadGameMap(css, 'community.bsp', Buffer.from('VBSP'));
  assert.ok(controls.gameMaps(css).some((m) => m.value === 'community'));
  assert.throws(() => controls.uploadGameMap(css, 'community.bsp', Buffer.from('VBSP')), { status: 409 });
  const uploaded = controls.gameControlsView(getServer('css'), true).uploads.find((u) => u.name === 'community.bsp');
  const savedCss = controls.gameControlsView(getServer('css'), true);
  controls.saveGameControls(getServer('css'), { revision: savedCss.revision, values: { ...savedCss.settings.values, map: 'community' } });
  assert.throws(() => controls.removeGameMapUpload(getServer('css'), uploaded.id), { status: 409 }, 'selected maps cannot be removed');
  const selectedCss = controls.gameControlsView(getServer('css'), true);
  controls.saveGameControls(getServer('css'), { revision: selectedCss.revision, values: { ...selectedCss.settings.values, map: 'de_dust2' } });
  controls.removeGameMapUpload(getServer('css'), uploaded.id);
  assert.equal(fs.existsSync(controls.gameFile(getServer('css'), 'cstrike/maps/community.bsp')), false);
  assert.throws(() => controls.removeGameMapUpload(getServer('css'), 'not-an-upload'), { status: 404 });
  const q3zip = new AdmZip(); q3zip.addFile('maps/community.bsp', Buffer.from('IBSP'));
  controls.uploadGameMap(getServer('quake3'), 'community.pk3', q3zip.toBuffer());
  assert.ok(controls.gameMaps(getServer('quake3')).some((m) => m.value === 'community'));
  controls.uploadGameMap(getServer('terraria'), 'World.wld', Buffer.from('world'));
  assert.ok(controls.gameMaps(getServer('terraria')).some((m) => m.value === 'worlds/World.wld'));
  const valheim = new AdmZip(); valheim.addFile('Imported.db', Buffer.from('db')); valheim.addFile('Imported.fwl', Buffer.from('fwl'));
  controls.uploadGameMap(getServer('valheim'), 'world.zip', valheim.toBuffer());
  assert.ok(controls.gameMaps(getServer('valheim')).some((m) => m.value === 'Imported'));
  const incomplete = new AdmZip(); incomplete.addFile('Incomplete.db', Buffer.from('db'));
  assert.throws(() => controls.uploadGameMap(getServer('valheim'), 'incomplete.zip', incomplete.toBuffer()), { status: 400 });
  assert.equal(fs.existsSync(controls.gameFile(getServer('valheim'), 'worlds/worlds_local/Incomplete.db')), false);
  const unturned = new AdmZip(); unturned.addFile('Island/Level.dat', Buffer.from('map'));
  controls.uploadGameMap(getServer('unturned'), 'island.zip', unturned.toBuffer());
  const seven = new AdmZip(); seven.addFile('NewWorld/map_info.xml', Buffer.from('<Map/>'));
  controls.uploadGameMap(getServer('7dtd'), 'world.zip', seven.toBuffer());
  controls.uploadGameMap(getServer('arma3'), 'Mission.Altis.pbo', Buffer.from('mission'));
  const wrong = new AdmZip(); wrong.addFile('escape.exe', Buffer.from('bad'));
  assert.throws(() => controls.uploadGameMap(css, 'bad.zip', wrong.toBuffer()), { status: 400 });
  const file = controls.readGameConfig(css, '0');
  controls.writeGameConfig(css, '0', file.content.replace('Managed css', 'Native css'), file.revision);
  assert.equal(controls.controlsOf(getServer('css')).values.hostname, 'Native css');
  assert.throws(() => controls.writeGameConfig(getServer('css'), '0', file.content, file.revision), { status: 409 });
  const sevenFile = controls.readGameConfig(getServer('7dtd'), '0');
  controls.writeGameConfig(getServer('7dtd'), '0', sevenFile.content.replace(/name="ServerPort" value="\d+"/, 'name="ServerPort" value="34567"'), sevenFile.revision);
  assert.equal(getServer('7dtd').server_port, 34567, 'native port edits also update the instance endpoint');
  const escaped = native.patchNative('<ServerSettings></ServerSettings>', GAME_PROFILES.find((p) => p.id === '7dtd'), { ServerName: 'A & B $&' });
  assert.equal(native.readNative(escaped, GAME_PROFILES.find((p) => p.id === '7dtd')).ServerName, 'A & B $&');

  const originalRequest = https.request, calls = [];
  https.request = (options, callback) => {
    const req = new EventEmitter(); req.destroy = (err) => req.emit('error', err);
    req.end = (body) => {
      const json = JSON.parse(body.toString()); calls.push({ options, json });
      const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => undefined;
      callback(res);
      const data = json.function === 'GetServerOptions' ? { serverOptions: { 'FG.DSAutoPause': 'True' }, pendingServerOptions: {} } : json.function === 'EnumerateSessions' ? { sessions: [{ sessionName: 'Factory', saveHeaders: [{ saveName: 'Autosave', saveDateTime: '2026-01-01' }] }] } : { serverGameState: { activeSessionName: 'Factory' } };
      queueMicrotask(() => { res.emit('data', JSON.stringify({ data })); res.emit('end'); });
    }; return req;
  };
  try {
    await sf.connectSatisfactory(getServer('satisfactory'), 'fixture-application-token');
    const state = await sf.satisfactoryView(getServer('satisfactory'));
    assert.equal(state.sessions[0].saves[0].name, 'Autosave');
    assert.equal(state.options['FG.DSAutoPause'], 'True');
    assert.ok(calls.every((c) => c.options.hostname === '127.0.0.1' && c.options.path === '/api/v1/'));
    assert.equal(sf.satisfactoryAction('load', { name: 'Autosave' }).fn, 'LoadGame');
    assert.equal(sf.satisfactoryAction('create', { name: 'New Factory' }).data.NewGameData.MapName, '');
    assert.throws(() => sf.satisfactoryAction('arbitrary-function', {}), { status: 400 });
  } finally { https.request = originalRequest; }

  const admin = users.createUser('admin-test', 'test-password-123', 'admin'), viewer = users.createUser('viewer-test', 'test-password-123', 'viewer');
  users.setUserServerAccess(viewer.id, GAME_PROFILES.map((p) => p.id));
  const token = (u) => createToken(u.id, u.username, u.role);
  const app = express(); app.use(express.json());
  app.use((q, _r, next) => { if (q.headers.authorization === 'Bearer browser-fixture') q.headers.authorization = `Bearer ${token(admin)}`; next(); });
  app.use('/api/servers/:serverId/game-controls', gameControlsRouter);
  app.use((err, _q, r, _next) => r.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  const req = (route, method = 'GET', body, user = admin) => fetch(origin + `/api/servers${route}`, { method, headers: { Authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await req('/css/game-controls', 'GET', undefined, viewer)).status, 200);
  assert.equal((await req('/css/game-controls/config/0', 'GET', undefined, viewer)).status, 403);
  assert.equal((await req('/css/game-controls', 'PUT', {}, viewer)).status, 403);
  assert.equal((await req('/satisfactory/game-controls/satisfactory/connect', 'POST', { token: 'secret' }, viewer)).status, 403);
  db.prepare("UPDATE servers SET status='running' WHERE id='css'").run();
  const before = controls.gameControlsView(getServer('css'), true);
  assert.equal((await req('/css/game-controls', 'PUT', { revision: before.revision, values: before.settings.values })).status, 409);
  db.prepare("UPDATE servers SET status='stopped' WHERE id='css'").run();
  assert.equal((await req('/css/game-controls/config/../../outside')).status, 404);
  const form = new FormData(); form.append('file', new Blob(['VBSP']), 'api.bsp');
  assert.equal((await fetch(origin + '/api/servers/css/game-controls/maps/upload', { method: 'POST', headers: { Authorization: `Bearer ${token(admin)}` }, body: form })).status, 200);
  if (process.env.OUTPOST_TEST_BROWSER_UI === '1') {
    const { runBrowser } = await import('./browserHarness.mjs');
    app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
    app.get('/api/auth/me', (_q, r) => r.json({ user: { id: admin.id, username: admin.username, role: 'admin', theme: null } }));
    app.get('/api/servers', (_q, r) => r.json({ servers: GAME_PROFILES.map((p) => getServer(p.id)) }));
    app.get('/api/servers/:id', (q, r) => r.json({ server: getServer(q.params.id), runtime: null, running: false, permissions: ['settings', 'files.write', 'files.read', 'console', 'power'] }));
    app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
    app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
    await runBrowser(origin, async ({ navigate, text, click, evaluate, until }) => {
      for (const profile of GAME_PROFILES) { await navigate(`/instances/${profile.id}/game-settings`); await text(`${profile.label} settings`); await text('Save game settings'); }
      await navigate('/instances/css/game-settings'); await text('Counter-Strike: Source settings');
      await until(() => evaluate("[...document.querySelectorAll('input')].some(i=>i.value==='Native css')"), 'native field value appears');
      await click('Save game settings'); await text('Game settings saved');
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Edit').click()");
      await until(() => evaluate("!!document.querySelector('textarea[aria-label=\"Native configuration content\"]')"), 'native configuration editor opens');
      assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Native configuration content\"]').value.includes('UnknownNative')"), true);
      await click('Close');
      await navigate('/instances/satisfactory/game-settings'); await text('Satisfactory server & saves');
      await until(() => evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'game settings fits viewport');
    });
  }
  console.log(`Game controls: all ${GAME_PROFILES.length} profiles, native persistence, launch adapters, map/world uploads, save protection, permissions and Satisfactory API passed`);
} finally {
  if (http) { http.closeAllConnections(); await new Promise((r) => http.close(r)); }
  db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
