// npm run build --workspace=server && node server/test/persistent-instances.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const modulePath = name => new URL(`../${process.env.OUTPOST_TEST_FROM_SOURCE ? 'src' : 'dist'}/${name}.${process.env.OUTPOST_TEST_FROM_SOURCE ? 'ts' : 'js'}`, import.meta.url).href;
const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}`); };
if (process.env.OUTPOST_SUPERVISOR_TEST_PANEL === '1') {
  const { db } = await import(modulePath('db/db'));
  const { instanceDir } = await import(modulePath('utils/paths'));
  const manager = await import(modulePath('services/processManager'));
  const { getServer } = await import(modulePath('services/serverService'));
  if (!getServer('persistent-fixture')) {
    db.prepare('INSERT INTO servers(id,name,platform,loader,version,status,launch_config) VALUES (?,?,?,?,?,?,?)').run('persistent-fixture', 'Persistent fixture', 'custom', 'vanilla', 'latest', 'stopped', JSON.stringify({ executable: process.execPath, args: 'fixture.cjs', readyPattern: 'READY', stop: { kind: 'stdin', commands: ['stop'] }, stopTimeoutSec: 2 }));
    fs.mkdirSync(instanceDir('persistent-fixture'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir('persistent-fixture'), 'fixture.cjs'), `
      const fs = require('fs');
      fs.appendFileSync('launches.txt', process.pid + '\\n');
      console.log('READY');
      let tick = 0, ignoreStop = false;
      setInterval(() => { fs.writeFileSync('heartbeat.txt', String(++tick)); console.log('TICK ' + tick); }, 100);
      require('readline').createInterface({ input: process.stdin }).on('line', line => {
        console.log('REPLY ' + line);
        if (line === 'ignore-stop') ignoreStop = true;
        if (line === 'stop' && !ignoreStop) process.exit(0);
        if (line === 'exit-later') setTimeout(() => process.exit(0), 300);
      });
    `);
  }
  await manager.restoreRunningInstances();
  process.on('message', async request => {
    try {
      if (request.op === 'start') await manager.startServer('persistent-fixture');
      if (request.op === 'command') manager.sendCommand('persistent-fixture', request.command);
      if (request.op === 'stop') manager.stopServer('persistent-fixture');
      if (request.op === 'shutdown') { manager.stopAllForShutdown(); process.exit(0); }
      process.send({ id: request.id, status: getServer('persistent-fixture').status, runtime: manager.getRuntimeInfo('persistent-fixture'), logs: manager.getLogBuffer('persistent-fixture') });
    } catch (error) { process.send({ id: request.id, error: error.message }); }
  });
  process.send({ ready: true });
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-persistent-instances-'));
  const panels = [];
  let sequence = 0;
  const startPanel = async () => {
    const panel = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, OUTPOST_DATA_DIR: temporary, OUTPOST_SUPERVISOR_TEST_PANEL: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    panels.push(panel);
    let diagnostics = ''; panel.stderr.on('data', chunk => { diagnostics += chunk; }); panel.stdout.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Panel fixture startup timeout: ' + diagnostics)), 15000);
      panel.on('message', message => { if (message.ready) { clearTimeout(timer); resolve(); } });
      panel.once('exit', code => { clearTimeout(timer); reject(new Error(`Panel fixture exited ${code}: ${diagnostics}`)); });
    });
    return panel;
  };
  const request = (panel, op, extra = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { panel.off('message', listen); reject(new Error('Request timed out: ' + op)); }, 15000);
    const listen = message => { if (message.id === id) { clearTimeout(timer); panel.off('message', listen); resolve(message); } };
    panel.on('message', listen); panel.send({ id, op, ...extra });
  });
  try {
    let panel = await startPanel();
    assert.equal((await request(panel, 'start')).error, undefined);
    await until(async () => (await request(panel, 'status')).status === 'running', 'initial ready');
    const first = await request(panel, 'status'), pid = first.runtime.pid;
    assert.ok(pid > 0);
    process.env.OUTPOST_DATA_DIR = temporary;
    const { supervisorStates, connectSupervisor, spawnSupervised } = await import(modulePath('services/instanceSupervisor'));
    await assert.rejects(connectSupervisor({ ...supervisorStates()[0], token: 'invalid-token' }), /closed/);
    await assert.rejects(spawnSupervised('persistent-fixture', {}), /already has a running supervisor/);
    assert.equal((await request(panel, 'status')).runtime.pid, pid, 'unauthenticated connections cannot affect games');
    assert.match((await request(panel, 'start')).error, /already running/);
    await request(panel, 'command', { command: 'before-update' });
    await until(async () => (await request(panel, 'status')).logs.some(line => line.includes('REPLY before-update')), 'first console command');
    const game = path.join(temporary, 'servers', 'persistent-fixture');
    await until(() => fs.existsSync(path.join(game, 'heartbeat.txt')), 'first heartbeat');
    const ticks = Number(fs.readFileSync(path.join(game, 'heartbeat.txt'), 'utf8'));
    const ended = once(panel, 'exit'); panel.send({ op: 'shutdown' }); await ended;
    await until(() => Number(fs.readFileSync(path.join(game, 'heartbeat.txt'), 'utf8')) > ticks + 3, 'game continues while panel offline');
    panel = await startPanel();
    const restored = await request(panel, 'status');
    assert.ok(restored.logs.some(line => line.startsWith('TICK ')), 'offline console output is replayed');
    assert.equal(restored.runtime.pid, pid, 'graceful panel restart retains the exact game process');
    assert.ok(restored.runtime.uptimeMs >= first.runtime.uptimeMs);
    await request(panel, 'command', { command: 'after-update' });
    await until(async () => (await request(panel, 'status')).logs.some(line => line.includes('REPLY after-update')), 'console reconnects');
    const crashed = once(panel, 'exit'); panel.kill('SIGKILL'); await crashed;
    panel = await startPanel();
    assert.equal((await request(panel, 'status')).runtime.pid, pid, 'panel crash retains the game');
    assert.equal(fs.readFileSync(path.join(game, 'launches.txt'), 'utf8').trim().split('\n').length, 1, 'reattachment never launches a duplicate');
    await request(panel, 'stop');
    await until(async () => (await request(panel, 'status')).status === 'stopped', 'explicit stop still works');
    assert.equal((await request(panel, 'start')).error, undefined, 'instance can start again after explicit stop');
    await until(async () => (await request(panel, 'status')).status === 'running', 'second ready');
    await request(panel, 'command', { command: 'exit-later' });
    const offlineExit = once(panel, 'exit'); panel.send({ op: 'shutdown' }); await offlineExit;
    await new Promise(resolve => setTimeout(resolve, 600));
    panel = await startPanel();
    await until(async () => (await request(panel, 'status')).status === 'stopped', 'offline game exit reconciles');
    assert.equal((await request(panel, 'status')).runtime, null);
    await request(panel, 'start');
    await until(async () => (await request(panel, 'status')).status === 'running', 'timeout fixture ready');
    await request(panel, 'command', { command: 'ignore-stop' });
    await request(panel, 'stop');
    const stoppingPanel = once(panel, 'exit'); panel.send({ op: 'shutdown' }); await stoppingPanel;
    await until(() => supervisorStates().some(state => state.exited), 'supervisor enforces stop timeout while panel offline');
    panel = await startPanel();
    await until(async () => (await request(panel, 'status')).status === 'stopped', 'offline force stop reconciles');
    console.log('Persistent instances: graceful restart, panel crash, unchanged PID, offline output, console input, duplicate prevention, explicit stop/restart and offline exits passed.');
  } finally {
    await Promise.all(panels.filter(panel => panel.exitCode === null && panel.signalCode === null).map(async panel => { const ended = once(panel, 'exit'); panel.kill('SIGKILL'); await ended; }));
    const supervisors = path.join(temporary, 'instance-supervisors');
    if (fs.existsSync(supervisors)) for (const name of fs.readdirSync(supervisors)) {
      try { const state = JSON.parse(fs.readFileSync(path.join(supervisors, name, 'state.json'), 'utf8')); for (const pid of [state.pid, state.workerPid]) { try { process.kill(pid, 'SIGKILL'); } catch {} } } catch {}
    }
    if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('outpost-persistent-instances-')) await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
