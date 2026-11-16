import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-beammp-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const templates = await import('../dist/services/templateService.js');
const servers = await import('../dist/services/serverService.js');
const addons = await import('../dist/services/pluginService.js');
const { launchEnv } = await import('../dist/services/launchConfig.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { isBeamMP } = await import('../dist/services/beammpService.js');
try {
  const tpl = templates.validateTemplate(templates.getTemplate('builtin-beammp'));
  assert(templates.listTemplates().some(t => t.id === 'builtin-beammp'));
  assert.throws(() => templates.deleteTemplate('builtin-beammp'), /cannot be deleted/);
  assert.throws(() => templates.resolveVariables(tpl, {}), /required/);
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
  console.log('BeamMP template, launch environment, ZIP preservation, validation, toggles, removal, confinement and secret export checks passed.');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}


