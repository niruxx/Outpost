import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-beammp-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const templates = await import('../dist/services/templateService.js');
const servers = await import('../dist/services/serverService.js');
const addons = await import('../dist/services/pluginService.js');
const { launchEnv } = await import('../dist/services/launchConfig.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { isBeamMP } = await import('../dist/services/beammpService.js');
const { beammpAssetName, installBeamMP } = await import('../dist/services/beammpInstallService.js');
const { defaultUpnpConfig } = await import('../dist/services/upnpService.js');
const fetchOriginal = globalThis.fetch;
let http;
try {
  const tpl = templates.validateTemplate(templates.getTemplate('builtin-beammp'));
  assert(templates.listTemplates().some(t => t.id === 'builtin-beammp'));
  assert.throws(() => templates.deleteTemplate('builtin-beammp'), /cannot be deleted/);
  const privateSetup = templates.instantiate(tpl, templates.resolveVariables(tpl, {}));
  assert.equal(privateSetup.launch.env.find(e => e.key === 'BEAMMP_PRIVATE').value, 'true');
  assert.match(privateSetup.launch.env.find(e => e.key === 'BEAMMP_AUTH_KEY').value, /^[\da-f-]{36}$/);
  assert.throws(() => templates.instantiate(tpl, templates.resolveVariables(tpl, { PRIVATE: 'false' })), /auth key is required/);
  assert.throws(() => templates.resolveVariables(tpl, { PRIVATE: 'invalid' }), /valid value/);
  assert.throws(() => templates.instantiate(tpl, templates.resolveVariables(tpl, { MAX_PLAYERS: 'eight' })), /Maximum players/);
  const publicSetup = templates.instantiate(tpl, templates.resolveVariables(tpl, { PRIVATE: 'false', AUTH_KEY: 'real-key' }));
  assert.equal(publicSetup.launch.env.find(e => e.key === 'BEAMMP_PRIVATE').value, 'false');
  const inst = templates.instantiate(tpl, templates.resolveVariables(tpl, { AUTH_KEY: 'test-secret', MAP: '/levels/earth/info.json' }));
  const s = servers.createServerRecord({ name: 'Earth test', ...inst, serverPort: 30815, createdBy: null, launchConfig: JSON.stringify(inst.launch) });
  servers.setServerStatus(s.id, 'stopped');
  assert(isBeamMP(s));
  assert(!isBeamMP({ ...s, platform: 'steam' }));
  const env = launchEnv(s, inst.launch);
  assert.equal(env.BEAMMP_PORT, '30815');
  assert.equal(env.BEAMMP_MAP, '/levels/earth/info.json');
  assert.equal(env.BEAMMP_AUTH_KEY, 'test-secret');
  assert.equal(addons.getAddonSupport(s).profile.folder, 'Resources/Client');
  const zip = new AdmZip(); zip.addFile('levels/earth/info.json', Buffer.from('{}'));
  const bytes = zip.toBuffer();
  assert.deepEqual(addons.installUploadedAddon(s, 'earth.zip', bytes), ['earth.zip']);
  const file = path.join(instanceDir(s.id), 'Resources/Client/earth.zip');
  assert.deepEqual(fs.readFileSync(file), bytes, 'Map ZIP is preserved intact');
  assert.equal(addons.listPlugins(s)[0].enabled, true);
  addons.setPluginEnabled(s, 'earth.zip', false);
  assert.equal(addons.listPlugins(s)[0].enabled, false);
  addons.setPluginEnabled(s, 'earth.zip.disabled', true);
  assert(fs.existsSync(file));
  assert.throws(() => addons.installUploadedAddon(s, 'broken.zip', Buffer.from('not a zip')), /expected a BeamNG/);
  const other = new AdmZip(); other.addFile('readme.txt', Buffer.from('Not a vehicle or map'));
  assert.throws(() => addons.installUploadedAddon(s, 'other.zip', other.toBuffer()), /expected a BeamNG/);
  assert.throws(() => addons.installUploadedAddon(s, 'script.lua', Buffer.from('')), /expected .zip/i);
  assert.throws(() => addons.deletePlugin(s, '../earth.zip'), /Invalid/);
  const escaped = { ...s, launch_config: JSON.stringify({ ...inst.launch, env: [{ key: 'BEAMMP_RESOURCE_FOLDER', value: '../../outside' }] }) };
  assert.throws(() => addons.installUploadedAddon(escaped, 'earth.zip', bytes), /Invalid path/);
  addons.deletePlugin(s, 'earth.zip'); assert.equal(addons.listPlugins(s).length, 0);
  const exported = templates.exportTemplate(s, { author: 'test', filePaths: [] });
  assert.equal(exported.instance.launch.env.find(e => e.key === 'BEAMMP_AUTH_KEY').value, '');
  assert.equal(exported.instance.launch.installer, 'beammp');
  assert.equal(defaultUpnpConfig(s).rules[0].protocol, 'BOTH');
  assert.equal(beammpAssetName({ platform: 'win32', arch: 'x64' }), 'BeamMP-Server.exe');
  assert.equal(beammpAssetName({ platform: 'linux', arch: 'arm64', osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n' }), 'BeamMP-Server.ubuntu.24.04.arm64');
  assert.equal(beammpAssetName({ platform: 'linux', arch: 'x64', osRelease: 'ID=debian\nVERSION_ID="12"\n' }), 'BeamMP-Server.debian.12.x86_64');
  assert.throws(() => beammpAssetName({ platform: 'darwin', arch: 'arm64' }), /does not support/);
  assert.throws(() => beammpAssetName({ platform: 'win32', arch: 'arm64' }), /does not support/);
  assert.throws(() => beammpAssetName({ platform: 'linux', arch: 'x64', osRelease: 'ID=fedora\nVERSION_ID=43' }), /distribution is not supported/);

  // No external downloads or host runtime installation in fixtures.
  const winHost = { platform: 'win32', arch: 'x64' };
  const managed = { ...s, launch_config: JSON.stringify({ ...inst.launch, executable: 'BeamMP-Server.exe' }) };
  const binary = Buffer.from('MZBeamMP-fixture');
  const asset = { name: 'BeamMP-Server.exe', size: binary.length, digest: `sha256:${crypto.createHash('sha256').update(binary).digest('hex')}`, browser_download_url: 'https://github.com/BeamMP/BeamMP-Server/releases/download/v3.fixture/BeamMP-Server.exe' };
  let release = { tag_name: 'v3.fixture', assets: [asset] };
  let downloaded = binary;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.github.com/repos/BeamMP/BeamMP-Server/releases/')) return Response.json(release);
    if (String(url) === asset.browser_download_url) return new Response(downloaded, { headers: { 'content-length': String(downloaded.length) } });
    if (String(url).startsWith('http://127.0.0.1:')) return fetchOriginal(url, options);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const progress = [], logs = [];
  let runtimeChecks = 0;
  const runtime = async () => { runtimeChecks++; };
  const result = await installBeamMP(managed, (pct, message) => progress.push({ pct, message }), line => logs.push(line), runtime, winHost);
  assert.equal(result.build, 'v3.fixture');
  assert.equal(runtimeChecks, 1);
  const executable = path.join(instanceDir(s.id), 'BeamMP-Server.exe');
  assert.deepEqual(fs.readFileSync(executable), binary);
  const config = path.join(instanceDir(s.id), 'ServerConfig.toml');
  assert.match(fs.readFileSync(config, 'utf8'), /Private = true/);
  assert(fs.existsSync(path.join(instanceDir(s.id), 'Resources/Client')));
  assert(fs.existsSync(path.join(instanceDir(s.id), 'Resources/Server')));
  assert(progress.some(p => p.message.includes('configuration')));
  assert(!logs.join('\n').includes('test-secret'));
  fs.writeFileSync(config, '# User configuration stays intact\n');
  fs.writeFileSync(file, bytes);
  await installBeamMP(managed, () => {}, () => {}, runtime, winHost);
  assert.equal(fs.readFileSync(config, 'utf8'), '# User configuration stays intact\n');
  assert.deepEqual(fs.readFileSync(file), bytes);
  release = { ...release, assets: [{ ...asset, digest: 'sha256:bad' }] };
  await assert.rejects(installBeamMP(managed, () => {}, () => {}, runtime, winHost), /checksum/);
  assert.deepEqual(fs.readFileSync(executable), binary, 'Failed verification preserves the installed binary');
  release = { ...release, assets: [asset] };
  downloaded = Buffer.from('short');
  await assert.rejects(installBeamMP(managed, () => {}, () => {}, runtime, winHost), /size mismatch/);
  downloaded = binary;
  await assert.rejects(installBeamMP(managed, () => {}, () => {}, async () => { throw new Error('Runtime fixture failure'); }, winHost), /Runtime fixture failure/);
  assert(!fs.readdirSync(instanceDir(s.id)).some(name => name.endsWith('.tmp')));
  release = { ...release, assets: [{ ...asset, browser_download_url: 'https://untrusted.invalid/binary.exe' }] };
  await assert.rejects(installBeamMP(managed, () => {}, () => {}, runtime, winHost), /unexpected download URL/);

  // Exercise the authenticated creation/retry lifecycle. An unavailable release fails predictably.
  const { serversRouter } = await import('../dist/routes/servers.routes.js');
  const { createUser } = await import('../dist/services/userService.js');
  const { createToken } = await import('../dist/auth/tokens.js');
  const admin = createUser('beammp-fixture-admin', 'fixture-password-123', 'admin');
  const app = express(); app.use(express.json()); app.use('/api/servers', serversRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  const post = (route, body = {}) => fetch(`${origin}/api/servers${route}`, { method: 'POST', headers: { Authorization: `Bearer ${createToken(admin.id, admin.username, admin.role)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let response = await post('', { templateId: 'builtin-beammp', name: 'Public missing key', variables: { PRIVATE: 'false' } });
  assert.equal(response.status, 400);
  release = { tag_name: 'v3.fixture', assets: [] };
  response = await post('', { templateId: 'builtin-beammp', name: 'Friends fixture', serverPort: 30816, variables: {}, startAfterInstall: false, forwardPort: true });
  const created = await response.json(); assert.equal(response.status, 201, JSON.stringify(created));
  const id = created.server.id;
  async function waitForFailure() {
    for (let i = 0; i < 100; i++) {
      if (servers.getServer(id).status === 'install_failed') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Install job did not report failure');
  }
  await waitForFailure();
  assert.equal(JSON.parse(servers.getServer(id).upnp_config).autoMap, true);
  assert.equal(JSON.parse(servers.getServer(id).upnp_config).rules[0].protocol, 'BOTH');
  assert.equal(JSON.parse(servers.getServer(id).launch_config).env.find(e => e.key === 'BEAMMP_PRIVATE').value, 'true');
  response = await post(`/${id}/retry-install`); assert.equal(response.status, 202);
  await waitForFailure();
  console.log('BeamMP private/public setup, official downloads, verification, configuration, runtime failure/retry, dual-protocol forwarding, mod lifecycle and secret checks passed.');
} finally {
  globalThis.fetch = fetchOriginal;
  if (http) await new Promise(resolve => http.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}


