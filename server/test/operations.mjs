import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import AdmZip from 'adm-zip';
import { WebSocketServer } from 'ws';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-operations-'));
process.env.OUTPOST_DATA_DIR = root;
const { db, prep } = await import('../dist/db/db.js');
const users = await import('../dist/services/userService.js');
const servers = await import('../dist/services/serverService.js');
const { createToken } = await import('../dist/auth/tokens.js');
const allocations = await import('../dist/services/allocationService.js');
const automation = await import('../dist/services/automationService.js');
const steam = await import('../dist/services/steamAccountService.js');
const { runSteamCmd } = await import('../dist/services/steamCmdService.js');
const packs = await import('../dist/services/curseforgePackService.js');
const cf = await import('../dist/services/curseforgeService.js');
const match = await import('../dist/services/cs2MatchService.js');
const fleet = await import('../dist/services/fleetService.js');
const { operationsRouter, automationRouter, hooksRouter } = await import('../dist/routes/operations.routes.js');
const { nodeLinkRouter } = await import('../dist/routes/nodeLink.routes.js');
const { serversRouter } = await import('../dist/routes/servers.routes.js');
const { cs2Router } = await import('../dist/routes/cs2.routes.js');
const { workshopRouter } = await import('../dist/routes/workshop.routes.js');
const { publish, consoleTopic } = await import('../dist/services/wsHub.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { setSetting } = await import('../dist/services/systemSettingsService.js');
const fetchOriginal = globalThis.fetch, total = os.totalmem, free = os.freemem;
os.totalmem = () => 64 * 1024 ** 3; os.freemem = () => 48 * 1024 ** 3;
const fixtureZip = new AdmZip();
fixtureZip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'Fixture pack', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.0', primary: true }] }, files: [], overrides: 'overrides' })));
fixtureZip.addFile('overrides/config/test.json', Buffer.from('{"test":true}'));
const zipBytes = fixtureZip.toBuffer();
const packFile = { id: 456, displayName: 'Pinned pack', fileName: 'pack.zip', downloadUrl: 'https://edge.forgecdn.net/files/pack.zip', isAvailable: true, hashes: [{ algo: 1, value: crypto.createHash('sha1').update(zipBytes).digest('hex') }] };
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchOriginal(url, init);
  if (u.hostname.endsWith('forgecdn.net')) return new Response(zipBytes, { status: 200 });
  if (u.hostname === 'api.curseforge.com') {
    assert.equal(init.headers['x-api-key'], 'fixture-cf-key');
    if (u.pathname === '/v1/mods/123/files/456') return Response.json({ data: packFile });
    if (u.pathname === '/v1/mods/123') return Response.json({ data: { id: 123, name: 'Fixture pack', classId: 4471, allowModDistribution: true } });
    if (u.pathname === '/v1/categories') return Response.json({ data: [{ id: 4471, name: 'Modpacks', slug: 'modpacks' }] });
    if (u.pathname === '/v1/games') return Response.json({ data: [] });
    throw new Error(`Unexpected CF fixture request: ${u}`);
  }
  // Fail closed: no real Steam/Mojang/provider traffic during tests.
  return Response.json({ error: 'No real downloads in fixtures' }, { status: 503 });
};
let httpServer, remoteServer, rconServer;
try {
  const admin = users.createUser('operations-owner', 'test-password-123', 'admin'), actor = users.createUser('operations-user', 'test-password-123', 'moderator'), stranger = users.createUser('operations-stranger', 'test-password-123', 'viewer');
  const token = createToken(actor.id, actor.username, actor.role), adminToken = createToken(admin.id, admin.username, admin.role), strangerToken = createToken(stranger.id, stranger.username, stranger.role);
  const make = name => servers.createServerRecord({ name, platform: 'java', loader: 'vanilla', version: '1.20.1', minMemoryMb: 512, maxMemoryMb: 1024, serverPort: 25565, createdBy: actor.id });
  const server = make('Automation fixture'); servers.setServerStatus(server.id, 'stopped');
  users.setUserServerAccess(actor.id, [{ serverId: server.id, permissions: ['settings', 'console', 'backups.create', 'players', 'files.read', 'files.write'] }]);
  const pool = allocations.createAllocationPool({ name: 'Game pool', address: '127.0.0.1', protocol: 'both', firstPort: 31000, lastPort: 31001 });
  assert.throws(() => allocations.createAllocationPool({ name: 'overlap', address: '0.0.0.0', protocol: 'udp', firstPort: 31001, lastPort: 31002 }), { status: 409 });
  const lease = allocations.reserveAllocation(pool.id, 'tcp'), lease2 = allocations.reserveAllocation(pool.id, 'udp'); assert.equal(lease.port, 31000); assert.equal(lease2.port, 31001);
  assert.throws(() => allocations.reserveAllocation(pool.id, 'tcp'), { status: 409 });
  allocations.releaseAllocation(lease2.token); allocations.commitAllocation(lease.token, server.id);
  assert.throws(() => allocations.assertManualPort(31000, 'different-server'), { status: 409 });
  assert.throws(() => allocations.assertManualPort(31002, server.id), { status: 409 });
  allocations.assertManualPort(31000, server.id);
  assert.throws(() => allocations.removeAllocationPool(pool.id), { status: 409 });
  const lease3 = allocations.reserveAllocation(pool.id, 'tcp'); prep('UPDATE allocations SET expires=0 WHERE token=?').run(lease3.token);
  assert.throws(() => allocations.commitAllocation(lease3.token, 'other'), { status: 409 });
  const next = allocations.reserveAllocation('auto', 'udp'); assert.equal(next.port, 31001); allocations.releaseAllocation(next.token);

  const input = { name: 'State setting', event: 'state.running', cooldown: 5, enabled: true, action: { type: 'settings', kind: 'setting', values: { name: 'Changed by event' } } };
  const rule = automation.saveRule(server.id, actor.id, input);
  automation.initAutomation(); publish(consoleTopic(server.id), { type: 'status', status: 'running' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers.getServer(server.id).name, 'Changed by event'); assert.equal(automation.listRules(server.id, actor.id)[0].last_result, 'Succeeded');
  const firstJoin = automation.saveRule(server.id, actor.id, { ...input, event: 'player.firstJoin', name: 'First join', action: { type: 'settings', kind: 'setting', values: { name: 'First observed join' } } });
  publish(consoleTopic(server.id), { type: 'player', action: 'join', name: 'Steve' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(servers.getServer(server.id).name, 'First observed join');
  servers.updateServerRecord(server.id, { name: 'unchanged' }); prep('UPDATE automation_rules SET last_run=0 WHERE id=?').run(firstJoin.id);
  publish(consoleTopic(server.id), { type: 'player', action: 'join', name: 'Steve' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(servers.getServer(server.id).name, 'unchanged');
  assert.throws(() => automation.saveRule(server.id, stranger.id, input), { status: 403 });
  assert.throws(() => automation.validateRuleAction({ type: 'settings', kind: 'property', values: { 'server-port': 31000 } }), { status: 400 });
  assert.throws(() => automation.validateRuleAction({ type: 'command', command: 'say hi\nquit' }), { status: 400 });
  const hook = automation.saveRule(server.id, actor.id, { ...input, event: 'webhook', name: 'Hook', action: { type: 'settings', kind: 'property', values: { motd: 'From webhook' } } });
  assert(!JSON.stringify(automation.listRules(server.id, actor.id)).includes(hook.secret));
  await assert.rejects(automation.acceptWebhook(hook.id, 'wrong', 'delivery-123', String(Date.now())), { status: 403 });
  await assert.rejects(automation.acceptWebhook(hook.id, hook.secret, 'delivery-123', '1000000000000'), { status: 400 });
  assert.deepEqual(await automation.acceptWebhook(hook.id, hook.secret, 'delivery-123', String(Date.now())), { duplicate: false });
  assert.match(await fs.readFile(path.join(instanceDir(server.id), 'server.properties'), 'utf8'), /motd=From webhook/);
  assert.deepEqual(await automation.acceptWebhook(hook.id, hook.secret, 'delivery-123', String(Date.now())), { duplicate: true });
  await assert.rejects(automation.acceptWebhook(hook.id, hook.secret, 'delivery-124', String(Date.now())), { status: 429 });
  const rotated = automation.rotateRuleSecret(server.id, actor.id, hook.id); await assert.rejects(automation.acceptWebhook(hook.id, hook.secret, 'delivery-125', String(Date.now())), { status: 403 });
  users.setUserServerAccess(actor.id, [{ serverId: server.id, permissions: ['settings'], configAccess: { properties: { motd: false } } }]);
  // Configuration-item denials survive a stored rule and are checked again at execution.
  prep('UPDATE user_server_access SET config_access=? WHERE user_id=? AND server_id=?').run(JSON.stringify({ 'property.motd': false }), actor.id, server.id);
  prep('UPDATE automation_rules SET last_run=0 WHERE id=?').run(hook.id);
  await assert.rejects(automation.acceptWebhook(hook.id, rotated.secret, 'delivery-126', String(Date.now())), { status: 403 });
  users.setUserServerAccess(actor.id, [{ serverId: server.id, permissions: ['settings', 'console', 'backups.create', 'players', 'files.read', 'files.write'], configAccess: {} }]);

  const secret = 'P@ssword with spaces'; const account = steam.saveSteamAccount(actor.id, { username: 'steam-user', password: secret });
  assert.equal(steam.steamAccounts(stranger.id).length, 0); assert.throws(() => steam.ownSteamAccount(stranger.id, account.id), { status: 404 });
  assert(!String(prep('SELECT secret FROM steam_accounts WHERE id=?').get(account.id).secret).includes(secret));
  assert.throws(() => steam.saveSteamAccount(actor.id, { username: 'x1', password: '+quit' }), { status: 400 });
  steam.setSteamGuard(actor.id, account.id, 'ABCDE');
  const source = path.join(root, 'fake-steam'); await fs.mkdir(path.join(source, 'config'), { recursive: true }); await fs.writeFile(path.join(source, 'config', 'loginusers.vdf'), 'OTHER ACCOUNT'); await fs.writeFile(path.join(source, 'steamcmd.exe'), 'fake binary');
  const logs = []; let temporaryScript;
  await runSteamCmd(path.join(source, 'steamcmd.exe'), ['+force_install_dir', instanceDir(server.id), '+login', `account:${account.id}`, '+app_update', '730', 'validate', '+quit'], instanceDir(server.id), s => logs.push(s), async (exe, args, cwd, onLog, env) => {
    assert(!JSON.stringify(args).includes(secret)); assert.equal(args[0], '+runscript');
    const script = await fs.readFile(args[1], 'utf8'); assert.match(script, /login "steam-user" "P@ssword with spaces" "ABCDE"/); assert.equal(await fs.realpath(env.HOME), await fs.realpath(path.join(root, 'steam-accounts', account.id)));
    temporaryScript = args[1]; assert(path.relative(await fs.realpath(root), await fs.realpath(args[1])).startsWith('..'), 'Login script must remain outside the environment-backup data tree');
    await assert.rejects(fs.access(path.join(path.dirname(exe), 'config', 'loginusers.vdf')));
    onLog(`echo ${secret} ABCDE`); return `Success! ${secret}`;
  });
  assert(!logs.join('').includes(secret)); assert(!logs.join('').includes('ABCDE'));
  await assert.rejects(fs.access(temporaryScript));
  assert(!(await fs.readdir(path.join(root, 'steam-accounts', account.id))).some(f => f.startsWith('request-')));
  assert.equal(steam.resolveSteamAccount(`account:${account.id}`).guard, undefined);
  await runSteamCmd(path.join(source, 'steamcmd.exe'), ['+login', `account:${account.id}`, 'FGHJK', '+quit'], instanceDir(server.id), undefined, async (_exe, args) => { const script = await fs.readFile(args[1], 'utf8'); assert.match(script, /login "steam-user" "P@ssword with spaces" "FGHJK"/); return 'done'; });
  steam.removeSteamAccount(actor.id, account.id); assert.throws(() => steam.resolveSteamAccount(`account:${account.id}`), { status: 409 });

  setSetting(cf.SETTING_CURSEFORGE_KEY, 'fixture-cf-key');
  const inspection = packs.inspectCurseForgePack(zipBytes); assert.equal(inspection.loader, 'forge'); assert.equal(inspection.loaderVersion, '47.3.0');
  const resolved = await packs.resolveCurseForgePack('123', '456'); assert.equal(resolved.ref.source, 'curseforge'); assert.equal(resolved.ref.versionId, '456');
  const packDir = path.join(root, 'cf-install'); await fs.mkdir(packDir); await packs.installCurseForgePack(resolved.ref, packDir, () => {}); assert.equal(await fs.readFile(path.join(packDir, 'config', 'test.json'), 'utf8'), '{"test":true}');
  await assert.rejects(packs.cfDownload('http://127.0.0.1/private'), { status: 400 });
  await assert.rejects(packs.cfDownload('https://edge.forgecdn.net/file', 1000000, [{ algo: 1, value: 'bad' }]), { status: 502 });
  const badZip = new AdmZip(); badZip.addFile('manifest.json', Buffer.from(JSON.stringify({ ...inspection.manifest, minecraft: { version: '1.2', modLoaders: [{ id: 'unknown-1' }] } }))); assert.throws(() => packs.inspectCurseForgePack(badZip.toBuffer()), { status: 400 });

  const plan = { ...match.DEFAULT_MATCH, team1: 'Test Alpha', rotation: ['de_dust2', 'de_nuke'] };
  match.saveMatch(server.id, plan); assert.match(await fs.readFile(path.join(instanceDir(server.id), 'game/csgo/gamemodes_server.txt'), 'utf8'), /outpost_rotation/);
  assert.throws(() => match.validateMatch({ ...plan, team1: 'evil";quit' }), { status: 400 });
  assert.throws(() => match.playerCommands({ action: 'kick', userId: '1;quit' }), { status: 400 });
  assert.deepEqual(match.playerCommands({ action: 'ban', steamId: 'STEAM_1:0:123', minutes: 30 }), ['banid 30 STEAM_1:0:123 kick', 'writeid']);
  assert.equal(match.parseCs2Status('# 5 "Player One" STEAM_1:0:123 01:00')[0].userId, 5);
  const demoDir = match.demoDirectory(server.id); await fs.writeFile(path.join(demoDir, 'test.dem'), 'fixture'); assert.equal(match.demos(server.id)[0].name, 'test.dem'); assert.throws(() => match.demoPath(server.id, '../test.dem'), { status: 400 });

  const app = express(); app.use(express.json()); app.use('/api/operations', operationsRouter); app.use('/api/hooks', hooksRouter); app.use('/api/node-link', nodeLinkRouter); app.use('/api/servers/:serverId/automation', automationRouter); app.use('/api/servers/:serverId/cs2', cs2Router); app.use('/api/servers/:serverId/workshop', workshopRouter); app.use('/api/servers', serversRouter); app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  httpServer = app.listen(0, '127.0.0.1'); await once(httpServer, 'listening'); const base = `http://127.0.0.1:${httpServer.address().port}/api`;
  const request = (route, body, auth = adminToken, method = body === undefined ? 'GET' : 'POST', extra = {}) => fetchOriginal(base + route, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request('/operations/fleet', undefined, token)).status, 403);
  assert.equal((await request('/operations/steam', undefined, strangerToken)).status, 200);
  assert.equal((await request(`/servers/${server.id}/automation`, undefined, strangerToken)).status, 403);
  assert.equal((await request('/node-link/inventory', undefined, '')).status, 401);
  const stateHook = automation.saveRule(server.id, actor.id, { ...input, event: 'webhook', name: 'HTTP hook', action: { type: 'settings', kind: 'setting', values: { name: 'HTTP webhook result' } } });
  assert.equal((await request(`/hooks/${stateHook.id}`, {}, stateHook.secret, 'POST', { 'X-Outpost-Delivery': 'http-delivery-1', 'X-Outpost-Timestamp': String(Date.now()) })).status, 200);
  assert.equal(servers.getServer(server.id).name, 'HTTP webhook result');
  const newAccount = steam.saveSteamAccount(actor.id, { username: 'steam-another', password: 'secret-pass' });
  const forbiddenSteam = await request('/servers', { name: 'Forbidden Steam', platform: 'steam', loader: 'steam', version: 'latest', steamAppId: '730', steamPreset: 'cs2', steamLogin: `account:${newAccount.id}` }, strangerToken); assert([403, 404].includes(forbiddenSteam.status));
  const requestId = crypto.randomUUID(), definition = { name: 'Provisioned fixture', platform: 'java', loader: 'vanilla', version: '1.20.1', acceptEula: true, minMemoryMb: 512, maxMemoryMb: 1024, allocationPoolId: 'auto' };
  const created = await request('/operations/provision', { requestId, nodeId: 'local', tags: [], definition }); assert.equal(created.status, 201, await created.clone().text()); const id = (await created.json()).server.id;
  await new Promise(resolve => setImmediate(resolve));
  const retry = await request('/operations/provision', { requestId, nodeId: 'local', tags: [], definition }); assert.equal(retry.status, 200); assert.equal((await retry.json()).server.id, id);
  assert.equal(Number(prep('SELECT COUNT(*) n FROM servers WHERE name=?').get('Provisioned fixture').n), 1);
  assert.equal((await request('/operations/provision', { requestId, nodeId: 'local', tags: [], definition: { ...definition, name: 'Changed' } })).status, 409);
  assert.equal((await request('/operations/provision', { requestId: crypto.randomUUID(), nodeId: 'local', tags: ['missing-tag'], definition })).status, 409);
  assert.equal(fleet.placements()[0].status, 'created');
  // A lost remote response must retry the same destination and request ID, not create again.
  const remoteApp = express(); remoteApp.use(express.json()); const remoteCreates = new Map(); let loseResponse = true;
  remoteApp.use((req, res, next) => { if (req.headers['x-outpost-node-key'] !== 'fixture-node-secret') return res.status(401).end(); next(); });
  remoteApp.get('/api/node-link/inventory', (_req, res) => res.json({ info: { hostname: 'remote-fixture', platform: 'linux', totalMemoryMb: 65536, freeMemoryMb: 60000, reservedMemoryMb: 0, cpus: 8, instances: 0, running: 0 }, servers: [], pools: [{ id: 'remote-pool', name: 'Remote pool', address: '0.0.0.0', protocol: 'both', first_port: 32000, last_port: 32010, allocations: [] }] }));
  remoteApp.post('/api/node-link/provision', (req, res) => { const key = req.get('X-Outpost-Provision-Id'); if (!remoteCreates.has(key)) remoteCreates.set(key, crypto.randomUUID()); if (loseResponse) { loseResponse = false; req.socket.destroy(); return; } res.status(201).json({ server: { id: remoteCreates.get(key) } }); });
  remoteServer = remoteApp.listen(0, '127.0.0.1'); await once(remoteServer, 'listening');
  const remoteId = crypto.randomUUID(); prep('INSERT INTO nodes(id,name,url,api_key) VALUES (?,?,?,?)').run(remoteId, 'Simulated remote', `http://127.0.0.1:${remoteServer.address().port}`, 'fixture-node-secret');
  const remoteRequestId = crypto.randomUUID(), remoteBody = { requestId: remoteRequestId, nodeId: remoteId, tags: [], definition };
  assert.equal((await request('/operations/provision', remoteBody)).ok, false);
  const remoteRetry = await request('/operations/provision', remoteBody); assert.equal(remoteRetry.status, 201); assert.equal((await remoteRetry.json()).server.id, remoteCreates.get(remoteRequestId)); assert.equal(remoteCreates.size, 1);
  assert.equal(prep('SELECT node_id FROM fleet_placements WHERE id=?').get(remoteRequestId).node_id, remoteId);

  // Use the real HTTP/RCON routes against a simulated game transport.
  const cs2 = servers.createServerRecord({ name: 'CS2 fixture', platform: 'steam', loader: 'steam', version: 'latest', minMemoryMb: 512, maxMemoryMb: 1024, serverPort: 27015, steamAppId: '730', steamPreset: 'cs2', createdBy: actor.id });
  servers.setServerStatus(cs2.id, 'stopped'); users.setUserServerAccess(actor.id, [{ serverId: server.id, permissions: ['settings'] }, { serverId: cs2.id, permissions: ['settings', 'console', 'players', 'files.read', 'files.write'] }]);
  const nativeCommands = []; rconServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(rconServer, 'listening');
  rconServer.on('connection', ws => ws.on('message', bytes => { const request = JSON.parse(bytes); nativeCommands.push(request.Message); ws.send(JSON.stringify({ Identifier: request.Identifier, Message: request.Message === 'status' ? '# 5 "Player One" STEAM_1:0:123 01:00' : 'OK' })); }));
  servers.setRconConfig(cs2.id, JSON.stringify({ enabled: true, protocol: 'webrcon', host: '127.0.0.1', port: rconServer.address().port, password: 'test-rcon-password', useForConsole: true }));
  const cs2base = `/servers/${cs2.id}/cs2`;
  assert.equal((await request(`${cs2base}/match`, plan, token, 'PUT')).status, 200);
  assert.equal((await request(`${cs2base}/match/action`, { action: 'live' }, token)).status, 200); assert(nativeCommands.includes('mp_restartgame 1'));
  const playerStatus = await request(`${cs2base}/players/status`, undefined, token); assert.equal(playerStatus.status, 200); assert.equal((await playerStatus.json()).players[0].userId, 5);
  assert.equal((await request(`${cs2base}/players/action`, { action: 'kick', userId: 5, reason: 'Fixture test' }, token)).status, 200); assert(nativeCommands.includes('kickid 5 "Fixture test"'));
  assert.equal((await request(`${cs2base}/demos/record`, { name: 'match-fixture' }, token)).status, 200); assert(nativeCommands.includes('tv_record outpost_demos/match-fixture'));
  const file = path.join(match.demoDirectory(cs2.id), 'match-fixture.dem'); await fs.writeFile(file, 'fake demo bytes');
  const downloaded = await request(`${cs2base}/demos/match-fixture.dem/download`, undefined, token); assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), 'fake demo bytes');
  assert.equal((await request(`${cs2base}/demos/match-fixture.dem`, undefined, token, 'DELETE')).status, 204);
  assert.equal((await request(`${cs2base}/match/action`, { action: 'live' }, strangerToken)).status, 403);
  users.setUserServerAccess(actor.id, [{ serverId: cs2.id, permissions: ['files.read'] }]);
  assert.equal((await request(`${cs2base}/players/action`, { action: 'kick', userId: 5 }, token)).status, 403);
  assert.equal((await request(`${cs2base}/match/action`, { action: 'restart' }, token)).status, 403);
  const arma = servers.createServerRecord({ name: 'Workshop fixture', platform: 'steam', loader: 'steam', version: 'latest', minMemoryMb: 512, maxMemoryMb: 1024, serverPort: 2302, steamAppId: '233780', steamPreset: 'arma3', createdBy: actor.id });
  users.setUserServerAccess(actor.id, [{ serverId: arma.id, permissions: ['settings', 'plugins'] }]);
  users.setUserServerAccess(stranger.id, [{ serverId: arma.id, permissions: ['settings', 'plugins'] }]);
  assert.equal((await request(`/servers/${arma.id}/workshop/login`, { username: `account:${newAccount.id}`, password: '' }, strangerToken, 'PUT')).status, 404);
  assert.equal((await request(`/servers/${arma.id}/workshop/login`, { username: `account:${newAccount.id}`, password: '' }, token, 'PUT')).status, 200);
  assert.equal(JSON.parse(servers.getServer(arma.id).workshop).login, `account:${newAccount.id}`);
  const disposable = users.createUser('steam-disposable', 'test-password', 'viewer'); const discarded = steam.saveSteamAccount(disposable.id, { username: 'discarded-steam', password: 'temporary-pass' });
  const discardedDirectory = path.join(root, 'steam-accounts', discarded.id); await fs.mkdir(discardedDirectory, { recursive: true });
  steam.steamAccountBusy.add(discarded.id); assert.throws(() => users.deleteUser(disposable.id), { status: 409 }); steam.steamAccountBusy.delete(discarded.id);
  users.deleteUser(disposable.id); assert.equal(users.getUserById(disposable.id), undefined); await assert.rejects(fs.access(discardedDirectory));
  users.updateUserRole(admin.id, 'viewer'); assert.equal((await request('/operations/fleet')).status, 403);
  console.log('Allocation leases/collisions, event and webhook rules/revocation/replay, encrypted Steam accounts/private scripts/Guard, CurseForge pinned installs, CS2 validation and idempotent fleet provisioning passed with simulated downloads');
} finally {
  globalThis.fetch = fetchOriginal; os.totalmem = total; os.freemem = free;
  if (httpServer) { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); }
  if (remoteServer) { remoteServer.closeAllConnections(); await new Promise(resolve => remoteServer.close(resolve)); }
  if (rconServer) { for (const ws of rconServer.clients) ws.terminate(); await new Promise(resolve => rconServer.close(resolve)); }
  await new Promise(resolve => setImmediate(resolve)); db.close(); await fs.rm(root, { recursive: true, force: true });
}
