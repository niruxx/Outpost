// Services & Software regression test. Uses an isolated database and recorded tool output, so it
// runs on any OS without touching systemd or the package manager.
//   npm run build && node server/test/host-system.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import express from 'express';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-host-system-'));
process.env.OUTPOST_DATA_DIR = path.join(dir, 'data');
const source = process.env.OUTPOST_TEST_SOURCE === '1';
const ext = source ? 'ts' : 'js';
const load = (file) => import(new URL(`../${source ? 'src' : 'dist'}/${file}.${ext}`, import.meta.url));
const { db } = await load('db/db');
const users = await load('services/userService');
const { createToken } = await load('auth/tokens');
const { createKey } = await load('services/apiKeyService');
const ops = await load('services/hostSystemOps');
const svc = await load('services/hostServicesService');
const pkg = await load('services/hostPackagesService');
const hostFiles = await load('services/hostFilesService');
const { hostAdminApi, hostLocalOnly, localHostContext } = await load('routes/hostAdmin.routes');
const { requireAuth, requireRole } = await load('auth/middleware');
let server;
try {
  // --- unit names and actions ---
  assert.equal(ops.validUnitName('nginx.service'), true);
  assert.equal(ops.validUnitName('getty@tty1.service'), true);
  assert.equal(ops.validUnitName('dev-disk-by\\x2duuid-1.swap'), true);
  for (const bad of ['nginx', '-x.service', '../etc.service', 'a b.service', 'x.service;rm', '']) assert.equal(ops.validUnitName(bad), false, bad);
  assert.deepEqual(ops.unitActionArgs('nginx.service', 'enable-now'), ['enable', '--now', '--', 'nginx.service']);
  assert.deepEqual(ops.unitActionArgs('nginx.service', 'restart'), ['restart', '--', 'nginx.service']);
  assert.throws(() => ops.unitActionArgs('nginx.service', 'kill'), { status: 400 });

  // --- systemctl parsing ---
  const units = svc.parseListUnits(
    [
      'nginx.service      loaded    active   running High performance web server',
      '● broken.service   loaded    failed   failed  Something broken',
      'ghost.service      not-found inactive dead    ghost.service',
    ].join('\n')
  );
  assert.deepEqual(units.map((u) => [u.unit, u.active, u.sub]), [['nginx.service', 'active', 'running'], ['broken.service', 'failed', 'failed'], ['ghost.service', 'inactive', 'dead']]);
  assert.equal(units[0].description, 'High performance web server');
  const files = svc.parseUnitFiles('nginx.service enabled enabled\nfoo@.service disabled -\nbar.service masked\n');
  assert.deepEqual(files.get('nginx.service'), { state: 'enabled', preset: 'enabled' });
  assert.deepEqual(files.get('foo@.service'), { state: 'disabled', preset: null });
  assert.equal(files.get('bar.service').state, 'masked');

  // listUnits merges installed-but-unloaded unit files and skips templates.
  const fakeExec = async (_cmd, args) =>
    args[0] === 'list-units'
      ? { code: 0, stdout: 'nginx.service loaded active running Web\n', stderr: '' }
      : { code: 0, stdout: 'nginx.service enabled enabled\nidle.service disabled enabled\nfoo@.service static -\n', stderr: '' };
  const merged = await svc.listUnits('service', { exec: fakeExec });
  assert.deepEqual(merged.map((u) => [u.unit, u.active, u.fileState]), [['idle.service', 'inactive', 'disabled'], ['nginx.service', 'active', 'enabled']]);

  const shown = svc.parseShow('Id=a.timer\nNextElapseUSecRealtime=@1700000000\nLastTriggerUSec=n/a\n\nId=b.timer\nNextElapseUSecRealtime=\n');
  assert.equal(shown.length, 2);
  assert.equal(svc.showTime(shown[0].NextElapseUSecRealtime), new Date(1700000000 * 1000).toISOString());
  assert.equal(svc.showTime(shown[0].LastTriggerUSec), null);
  assert.equal(svc.showTime('Mon 2026-11-09 00:00:00 UTC'), 'Mon 2026-11-09 00:00:00 UTC');

  const cal = svc.parseCalendar('  Original form: daily\nNormalized form: *-*-* 00:00:00\n    Next elapse: Tue 2026-11-10 00:00:00 UTC\n       (in UTC): Tue 2026-11-10 00:00:00 UTC\n       From now: 5h left\n        Iter. #2: Wed 2026-11-11 00:00:00 UTC\n');
  assert.equal(cal.normalized, '*-*-* 00:00:00');
  assert.deepEqual(cal.next, ['Tue 2026-11-10 00:00:00 UTC', 'Wed 2026-11-11 00:00:00 UTC']);

  assert.equal(svc.ownUnitFromCgroup('0::/system.slice/outpost.service\n'), 'outpost.service');
  assert.equal(svc.ownUnitFromCgroup('0::/user.slice/user-1000.slice/session-2.scope\n'), null);

  // --- lockout protection ---
  assert.match(svc.protectionFor('ssh.service', 'stop', null), /lock you out/);
  assert.match(svc.protectionFor('sshd.service', 'mask', null), /lock you out/);
  assert.equal(svc.protectionFor('ssh.service', 'restart', null), null);
  assert.equal(svc.protectionFor('ssh.service', 'start', null), null);
  assert.match(svc.protectionFor('outpost.service', 'restart', 'outpost.service'), /Outpost itself/);
  assert.match(svc.protectionFor('outpost.service', 'stop', 'outpost.service'), /stops responding/);
  assert.equal(svc.protectionFor('nginx.service', 'stop', 'outpost.service'), null);

  // --- timers: validation, rendering, round trip, files ---
  assert.throws(() => ops.sanitizeTimer({ name: 'x', command: '' }), { status: 400 });
  assert.throws(() => ops.sanitizeTimer({ name: '../evil', command: '/bin/true', onCalendar: 'daily' }), { status: 400 });
  assert.throws(() => ops.sanitizeTimer({ name: 'x', command: '/bin/true\nExecStartPost=/bin/sh', onCalendar: 'daily' }), { status: 400 });
  assert.throws(() => ops.sanitizeTimer({ name: 'x', command: '/bin/true' }), /Choose when/);
  assert.throws(() => ops.sanitizeTimer({ name: 'x', command: '/bin/true', onUnitActiveSec: 'soon' }), /time span/);
  assert.throws(() => ops.sanitizeTimer({ name: 'x', command: '/bin/true', onCalendar: 'daily', user: 'Root Admin' }), /user name/);
  const interval = ops.sanitizeTimer({ name: 'poll.timer', command: '/bin/true', onUnitActiveSec: '15min' });
  assert.equal(interval.name, 'poll');
  assert.equal(interval.onBootSec, '1min'); // anchored so it fires the first time

  const def = ops.sanitizeTimer({ name: 'nightly', description: '100% backup', command: 'date +%F >> /tmp/x', user: 'backup', onCalendar: '*-*-* 04:00:00', persistent: true, randomizedDelaySec: '5min' });
  const rendered = ops.renderTimerUnits(def);
  assert.match(rendered.service, /^# Managed by Outpost/);
  assert.match(rendered.service, /ExecStart=date \+%%F >> \/tmp\/x/);
  assert.match(rendered.service, /User=backup/);
  assert.match(rendered.timer, /OnCalendar=\*-\*-\* 04:00:00/);
  assert.match(rendered.timer, /Persistent=true/);
  assert.match(rendered.timer, /Unit=nightly\.service/);
  assert.deepEqual(ops.parseManagedTimer('nightly', rendered.service, rendered.timer), def);
  assert.equal(ops.parseManagedTimer('nightly', '[Unit]\n', rendered.timer), null);

  const unitDir = path.join(dir, 'units');
  await fs.mkdir(unitDir);
  await ops.__testing.writeTimer({ definition: def, enable: false, replace: false, unitDir });
  assert.match(await fs.readFile(path.join(unitDir, 'nightly.timer'), 'utf8'), /OnCalendar/);
  await assert.rejects(ops.__testing.writeTimer({ definition: def, enable: false, replace: false, unitDir }), { status: 409 });
  await ops.__testing.writeTimer({ definition: { ...def, onCalendar: 'weekly' }, enable: false, replace: true, unitDir });
  assert.match(await fs.readFile(path.join(unitDir, 'nightly.timer'), 'utf8'), /OnCalendar=weekly/);
  await fs.writeFile(path.join(unitDir, 'foreign.service'), '[Unit]\nDescription=not ours\n');
  await assert.rejects(ops.__testing.writeTimer({ definition: { ...def, name: 'foreign' }, enable: false, replace: true, unitDir }), /wasn’t created by Outpost/);
  await assert.rejects(ops.__testing.deleteTimer({ name: 'foreign', unitDir }), { status: 403 });
  await ops.__testing.deleteTimer({ name: 'nightly', unitDir });
  assert.deepEqual((await fs.readdir(unitDir)).sort(), ['foreign.service']);

  // --- package commands ---
  assert.deepEqual(ops.packageCommand('apt', 'install', ['nginx']).args.slice(-2), ['install', 'nginx']);
  assert.ok(ops.packageCommand('apt', 'install', ['nginx']).args.includes('-y'));
  assert.deepEqual(ops.packageCommand('apt', 'install', ['nginx'], true).args, ['-s', 'install', 'nginx']);
  assert.equal(ops.packageCommand('apt', 'install', ['nginx']).env.DEBIAN_FRONTEND, 'noninteractive');
  assert.deepEqual(ops.packageCommand('apt', 'upgrade-all', []).args.slice(-2), ['upgrade', '--with-new-pkgs']);
  assert.deepEqual(ops.packageCommand('apt', 'upgrade', ['curl'], true).args, ['-s', 'install', '--only-upgrade', 'curl']);
  assert.deepEqual(ops.packageCommand('dnf', 'remove', ['httpd'], true).args, ['--assumeno', 'remove', 'httpd']);
  assert.deepEqual(ops.packageCommand('dnf', 'refresh', []).args, ['makecache', '--refresh']);
  assert.deepEqual(ops.packageCommand('pacman', 'install', ['nginx']).args, ['-Syu', '--needed', '--noconfirm', 'nginx']);
  assert.deepEqual(ops.packageCommand('pacman', 'remove', ['nginx'], true).args, ['-Rs', '--print', 'nginx']);
  assert.throws(() => ops.packageCommand('pacman', 'upgrade', ['nginx']), /Arch/);
  assert.throws(() => ops.packageCommand('apt', 'install', []), { status: 400 });
  assert.throws(() => ops.packageCommand('apt', 'install', ['-o=evil']), /Invalid package/);
  assert.throws(() => ops.packageCommand('apt', 'install', ['a;b']), /Invalid package/);
  assert.throws(() => ops.packageCommand('yum', 'install', ['a']), { status: 400 });
  assert.throws(() => ops.packageCommand('apt', 'refresh', [], true), { status: 400 });

  // --- package output parsing ---
  const aptUp = pkg.parseAptUpgradable('Listing...\ncurl/jammy-updates,jammy-security 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]\nvim/jammy-updates 2:8.2-1 amd64 [upgradable from: 2:8.2-0]\n');
  assert.deepEqual(aptUp.map((u) => [u.name, u.security, u.current]), [['curl', true, '7.81.0-1ubuntu1.15'], ['vim', false, '2:8.2-0']]);
  const dnfUp = pkg.parseDnfCheckUpdate('\nkernel.x86_64            6.11.4-301.fc41     updates\npython3.12.x86_64  3.12.7-1.fc41  updates\n\nObsoleting Packages\ngrub2-tools.x86_64 1:2.12-9 updates\n');
  assert.deepEqual(dnfUp.map((u) => u.name), ['kernel', 'python3.12']);
  pkg.markDnfSecurity(dnfUp, 'FEDORA-2026-abc Important/Sec. kernel-6.11.4-301.fc41.x86_64\n');
  assert.deepEqual(dnfUp.map((u) => u.security), [true, false]);
  assert.deepEqual(pkg.parsePacmanUpdates('linux 6.11.1-1 -> 6.11.2-1\nvim 9.1-1 -> 9.1-2\n').map((u) => u.name), ['linux', 'vim']);

  assert.deepEqual(pkg.parseAptSearch('nginx - small, powerful, scalable web/proxy server\nnginx-core - nginx web/proxy server (standard version)\n').map((r) => r.name), ['nginx', 'nginx-core']);
  const show = pkg.parseAptShow('Package: nginx\nVersion: 1.24.0-2\nSection: httpd\nInstalled-Size: 1200\nDescription-en: small, powerful web server\n\nPackage: libfoo1\nVersion: 1\nSection: universe/libs\nDescription: foo\n');
  assert.equal(show.get('nginx').section, 'httpd');
  assert.equal(show.get('nginx').size, 1200 * 1024);
  assert.equal(show.get('libfoo1').summary, 'foo');
  assert.deepEqual(
    pkg.parseDnfSearch('Last metadata expiration check: 0:01:00 ago\n=== Name Exactly Matched: nginx ===\nnginx.x86_64 : A high performance web server\nMatched fields: name\n nginx-mod-stream.x86_64: Nginx stream modules\n'),
    [{ name: 'nginx', summary: 'A high performance web server' }, { name: 'nginx-mod-stream', summary: 'Nginx stream modules' }]
  );
  const pac = pkg.parsePacmanSearch('extra/nginx 1.26.2-1 [installed]\n    Lightweight HTTP server\ncore/base-devel 1-2 (base-devel)\n    Basic tools to build Arch Linux packages\n');
  assert.deepEqual(pac.map((p) => [p.repo, p.name, p.installed, p.groups.join()]), [['extra', 'nginx', true, ''], ['core', 'base-devel', false, 'base-devel']]);
  const dpkg = pkg.parseInstalledTsv('nginx\t1.24\thttpd\t1200\tii \tweb server\nold\t1\tadmin\t5\trc \tremoved\n', 1024);
  assert.deepEqual(dpkg.map((p) => p.name), ['nginx']);
  const rpm = pkg.parseInstalledTsv('gpg-pubkey\t1-1\tPublic Keys\t0\tinstalled\tkey\nhttpd\t2.4-1\tUnspecified\t9000\tinstalled\tApache\n', 1);
  assert.deepEqual(rpm.map((p) => [p.name, p.section]), [['httpd', null]]);
  const qi = pkg.parsePacmanQi('Name            : nginx\nVersion         : 1.26\nDescription     : HTTP server\nGroups          : None\nInstalled Size  : 1.50 MiB\nInstall Reason  : Explicitly installed\n\nName            : zlib\nVersion         : 1.3\nDescription     : lib\nGroups          : None\nInstalled Size  : 300.00 KiB\nInstall Reason  : Installed as a dependency for another package\n');
  assert.deepEqual(qi.map((p) => [p.name, p.manual, p.size]), [['nginx', true, Math.round(1.5 * 1024 ** 2)], ['zlib', false, 300 * 1024]]);

  // --- groups ---
  assert.equal(pkg.categorize('nginx'), 'web');
  assert.equal(pkg.categorize('mariadb-server'), 'databases');
  assert.equal(pkg.categorize('whatever', 'universe/games'), 'games');
  assert.equal(pkg.categorize('libssl3', 'libs'), 'libraries');
  assert.equal(pkg.categorize('python3-requests'), 'development');
  assert.equal(pkg.categorize('libfoo'), 'libraries');
  assert.equal(pkg.categorize('zzz-unknown'), 'other');
  const ids = new Set(pkg.CATEGORIES.map((c) => c.id));
  for (const app of pkg.CATALOG) assert.ok(ids.has(app.category), app.id);
  assert.equal(new Set(pkg.CATALOG.map((a) => a.id)).size, pkg.CATALOG.length);

  // --- background jobs ---
  pkg.__resetPackageState();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const job = pkg.startJob(async (_args, progress) => { progress('Reading package lists...\n'); await gate; progress('Done\n'); return { code: 0, output: '' }; }, { manager: 'apt', verb: 'install', packages: ['nginx'] }, 'tester');
  assert.equal(job.state, 'running');
  assert.throws(() => pkg.startJob(async () => ({ code: 0, output: '' }), { manager: 'apt', verb: 'refresh', packages: [] }, 'tester'), { status: 409 });
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pkg.getJob().state, 'succeeded');
  assert.match(pkg.getJob().output, /Reading package lists[\s\S]*Done/);
  pkg.startJob(async () => { throw new Error('dpkg was interrupted'); }, { manager: 'apt', verb: 'upgrade-all', packages: [] }, 'tester');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pkg.getJob().state, 'failed');
  assert.equal(pkg.getJob().error, 'dpkg was interrupted');
  pkg.__resetPackageState();

  // --- the privileged helper accepts system ops, validates them, and streams progress ---
  const helperPath = fileURLToPath(new URL(`../${source ? 'src' : 'dist'}/services/hostFilesHelper.${ext}`, import.meta.url));
  const helper = spawn(process.execPath, [...process.execArgv, helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: helper.stdout });
  const replies = [];
  const waiters = [];
  lines.on('line', (line) => (waiters.length ? waiters.shift()(JSON.parse(line)) : replies.push(JSON.parse(line))));
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiters.push(resolve)));
  assert.equal((await next()).ready, true);
  helper.stdin.write(`${JSON.stringify({ id: 1, op: 'unit.action', args: { unit: 'x;reboot', action: 'stop' } })}\n`);
  assert.deepEqual(await next(), { id: 1, ok: false, status: 400, error: 'Invalid unit name' });
  helper.stdin.write(`${JSON.stringify({ id: 2, op: 'pkg.run', args: { manager: 'apt', verb: 'install', packages: ['--evil'] } })}\n`);
  const bad = await next();
  assert.equal(bad.status, 400);
  helper.stdin.write(`${JSON.stringify({ id: 3, op: 'timer.delete', args: { name: '../../etc/passwd' } })}\n`);
  assert.equal((await next()).status, 400);
  helper.stdin.write(`${JSON.stringify({ id: 4, op: '__proto__', args: {} })}\n`);
  assert.equal((await next()).error, 'Unknown operation');
  helper.stdin.end();
  assert.equal(await new Promise((resolve) => helper.once('exit', resolve)), 0);

  // --- routes: admins with a real sign-in only; changes need Admin Mode ---
  const admin = users.createUser('system-admin', 'test-password-123', 'admin');
  const viewer = users.createUser('system-viewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin');
  const viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const apiKey = createKey(admin.id, { name: 'Not a host admin login', readOnly: false }).key;
  const app = express();
  app.use(express.json());
  app.use('/api/host', requireAuth, requireRole('admin'), localHostContext, hostLocalOnly, hostAdminApi);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const req = (route, token, init = {}) => fetch(origin + route, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  for (const route of ['/host/services', '/host/packages']) {
    assert.equal((await fetch(origin + route)).status, 401);
    assert.equal((await req(route, viewerToken)).status, 403);
    assert.equal((await req(route, apiKey)).status, 403);
    assert.equal((await req(route, adminToken)).status, 200);
  }
  assert.equal((await req('/host/services?type=bogus', adminToken)).status, 400);
  assert.equal((await req('/host/services/units/bad%20name/logs', adminToken)).status, 400);
  const pkgStatus = await (await req('/host/packages', adminToken)).json();
  assert.equal(typeof pkgStatus.available, 'boolean');

  const privileged = hostFiles.hostFilesStatus(adminToken).admin.alwaysOn;
  if (!privileged) {
    const denied = await req('/host/services/units/nginx.service/action', adminToken, { method: 'POST', body: JSON.stringify({ action: 'restart' }) });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /Admin Mode/);
    const timer = await req('/host/services/timers', adminToken, { method: 'POST', body: JSON.stringify({ definition: { name: 'x', command: '/bin/true', onBootSec: '5min' } }) });
    assert.equal(timer.status, 403);
    if (pkgStatus.available) {
      assert.equal((await req('/host/packages/jobs', adminToken, { method: 'POST', body: JSON.stringify({ verb: 'install', packages: ['nginx'] }) })).status, 403);
    }
  }
  assert.equal((await req('/host/services/units/nginx.service/action', adminToken, { method: 'POST', body: JSON.stringify({ action: 'explode' }) })).status, 400);
  assert.equal((await req('/host/services/timers', adminToken, { method: 'POST', body: JSON.stringify({ definition: { name: 'x;y', command: '/bin/true', onBootSec: '5min' } }) })).status, 400);
  assert.equal((await req('/host/services/units/nginx.service/action', viewerToken, { method: 'POST', body: JSON.stringify({ action: 'stop' }) })).status, 403);

  console.log('host-system: ok');
} finally {
  hostFiles.stopHostFileSessions();
  server?.close();
  db.close?.();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
