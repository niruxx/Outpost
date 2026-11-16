// Optional live smoke: official binary, loopback-only private server, no host package installs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-beammp-live-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const { createServerRecord } = await import('../dist/services/serverService.js');
const { instantiate, resolveVariables } = await import('../dist/services/templateService.js');
const { beammpTemplate, beamngEarthTemplate } = await import('../dist/services/beammpService.js');
const { earthStatus } = await import('../dist/services/beamngEarthService.js');
const { installBeamMP } = await import('../dist/services/beammpInstallService.js');
const { launchEnv } = await import('../dist/services/launchConfig.js');
const { instanceDir } = await import('../dist/utils/paths.js');
let child;
try {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const earth = process.argv.includes('--earth');
  const template = earth ? beamngEarthTemplate() : beammpTemplate();
  const inst = instantiate(template, resolveVariables(template, {}));
  const server = createServerRecord({ ...inst, name: 'Outpost loopback smoke', serverPort: port, createdBy: null, launchConfig: JSON.stringify(inst.launch) });
  let lastMessage;
  const result = await installBeamMP(server, (_pct, message) => { if (message !== lastMessage) { console.log(message); lastMessage = message; } }, () => {}, async () => {});
  const dir = instanceDir(server.id);
  const config = path.join(dir, 'ServerConfig.toml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('[General]', '[General]\nIP = "127.0.0.1"'));
  child = spawn(path.join(dir, result.executable), [], { cwd: dir, env: { ...process.env, ...launchEnv(server, inst.launch) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const closed = once(child, 'close');
  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (/ALL SYSTEMS STARTED SUCCESSFULLY/i.test(output) && (!earth || /\[BeamNG\.Earth\] plugin loaded/i.test(output))) { clearInterval(interval); clearTimeout(timeout); resolve(); }
    }, 100);
    const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('BeamMP did not become ready: ' + output.replaceAll(launchEnv(server, inst.launch).BEAMMP_AUTH_KEY, '[redacted]'))); }, 30_000);
    child.once('error', error => { clearInterval(interval); clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearInterval(interval); clearTimeout(timeout); reject(new Error('BeamMP exited before ready: ' + code + ' ' + output)); });
  });
  child.stdin.write('exit\n');
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [code] = await closed; clearTimeout(timeout);
  assert.notEqual(code, null, 'The temporary server has exited');
  console.log(`Live BeamMP ${result.build}: official download, generated configuration and private startup without a Keymaster key passed on loopback.`);
  if (earth) console.log(`Live BeamNG.Earth ${earthStatus(server).version}: official package verified, Earth map selected and server plugin loaded successfully.`);
  if (code !== 0) console.warn(`Official BeamMP binary returned ${code} after its exit command; clean shutdown was not verified.`);
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'close'); }
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}
