// Host administration regression test: accounts, networking, settings, security, TLS, diagnostics,
// metrics history and administration of linked hosts. Uses an isolated database and recorded tool
// output, so it runs on any OS without changing the host.
//   npm run build && node server/test/host-admin.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import express from 'express';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-host-admin-'));
process.env.OUTPOST_DATA_DIR = path.join(dir, 'data');
const source = process.env.OUTPOST_TEST_SOURCE === '1';
const ext = source ? 'ts' : 'js';
const load = (file) => import(new URL(`../${source ? 'src' : 'dist'}/${file}.${ext}`, import.meta.url));
const { db } = await load('db/db');
const users = await load('services/userService');
const { createToken } = await load('auth/tokens');
const { requireAuth, requireRole } = await load('auth/middleware');
const acc = await load('services/hostAccountsOps');
const accSvc = await load('services/hostAccountsService');
const net = await load('services/hostNetworkOps');
const netSvc = await load('services/hostNetworkService');
const set = await load('services/hostSettingsOps');
const setSvc = await load('services/hostSettingsService');
const sec = await load('services/hostSecurityOps');
const tls = await load('services/tlsService');
const diag = await load('services/hostDiagnosticsOps');
const diagSvc = await load('services/hostDiagnosticsService');
const metrics = await load('services/hostMetricsHistoryService');
const jobs = await load('services/hostJobs');
const hostFiles = await load('services/hostFilesService');
const nodes = await load('services/nodeService');
const { setSetting } = await load('services/systemSettingsService');
const { hostAdminApi, hostLocalOnly, localHostContext, REMOTE_ADMIN_SETTING } = await load('routes/hostAdmin.routes');
const { remoteHostRouter } = await load('routes/remoteHost.routes');
const { nodeLinkRouter } = await load('routes/nodeLink.routes');
let server;
try {
  // --- accounts ---
  assert.equal(acc.assertName('alice'), 'alice');
  for (const bad of ['Alice', '-x', 'a b', 'a:b', '', 'x'.repeat(40)]) assert.throws(() => acc.assertName(bad), { status: 400 }, bad);
  assert.equal(acc.uidMin('UID_MIN   1000\n'), 1000);
  assert.equal(acc.uidMin('#UID_MIN 500\nUID_MIN 2000\n'), 2000);
  assert.equal(acc.adminGroupFrom('root:x:0:\nwheel:x:10:alice\n'), 'wheel');
  assert.equal(acc.adminGroupFrom('sudo:x:27:\nwheel:x:10:\n'), 'sudo');
  const passwd = acc.parsePasswd('root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice A,,,:/home/alice:/bin/zsh\n');
  assert.deepEqual(passwd.map((u) => [u.name, u.uid, u.gecos, u.shell]), [['root', 0, 'root', '/bin/bash'], ['alice', 1000, 'Alice A', '/bin/zsh']]);
  const shadow = acc.parseShadow('alice:$6$salt$hash:19000:0:90:7:::\nbob:!$6$x$y:19000:0:99999:7:::\ncarol:!:19000::::::\nsvc:*:19000:::::\nold:$6$a$b:0:0:99999:7::1:\n', 20000);
  assert.deepEqual(shadow.map((s) => [s.name, s.locked, s.hasPassword, s.maxDays, s.mustChange]), [
    ['alice', false, true, 90, false],
    ['bob', true, true, null, false],
    ['carol', true, false, null, false],
    ['svc', false, false, null, false],
    ['old', true, true, null, true],
  ]);
  assert.ok(!JSON.stringify(shadow).includes('$6$'), 'password hashes must never leave the helper');
  const goodKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alice@laptop';
  assert.equal(acc.validateAuthorizedKeys(`# keys\n${goodKey}\r\nfrom="10.0.0.0/8",no-pty ${goodKey}\n\n`), `# keys\n${goodKey}\nfrom="10.0.0.0/8",no-pty ${goodKey}\n`);
  assert.throws(() => acc.validateAuthorizedKeys('not a key'), /Line 1/);
  assert.throws(() => acc.validateAuthorizedKeys(`${goodKey}\nssh-rsa`), /Line 2/);
  const groups = accSvc.parseGroups('root:x:0:\nsudo:x:27:alice,bob\ngamers:x:1001:alice\n', 1000);
  assert.deepEqual(groups.map((g) => [g.name, g.system, g.members.length]), [['root', true, 0], ['sudo', true, 2], ['gamers', false, 1]]);
  const last = accSvc.parseLast('alice    pts/0        192.168.1.5      Mon Nov  9 10:00:01 2026 - Mon Nov  9 11:00:00 2026  (00:59)\nalice    pts/1        10.0.0.2         Sun Nov  8 09:00:00 2026 - down\nreboot   system boot  6.11.0           Sun Nov  8 08:00:00 2026   still running\nbob      tty1                          Sat Nov  7 08:00:00 2026 - crash\n');
  assert.equal(last.get('alice').from, '192.168.1.5');
  assert.equal(last.get('bob').from, null);
  assert.ok(!last.has('reboot'));
  assert.deepEqual(accSvc.parseLoginDefs('PASS_MAX_DAYS\t99999\n# PASS_MIN_LEN 5\nPASS_MIN_LEN 8\n'), { PASS_MAX_DAYS: '99999', PASS_MIN_LEN: '8' });

  // --- networking ---
  assert.deepEqual(netSvc.splitTerse('eth0:ethernet:connected:Wired connection 1:abc'), ['eth0', 'ethernet', 'connected', 'Wired connection 1', 'abc']);
  assert.deepEqual(netSvc.splitTerse('IP6.ADDRESS[1]:fe80\\:\\:1/64'), ['IP6.ADDRESS[1]', 'fe80::1/64']);
  assert.deepEqual(netSvc.splitTerse('a\\\\b:c'), ['a\\b', 'c']);
  const devices = netSvc.parseDevices('eth0:ethernet:connected:Wired 1:11111111-1111-1111-1111-111111111111\nlo:loopback:connected (externally):lo:\n');
  assert.equal(devices[0].uuid, '11111111-1111-1111-1111-111111111111');
  assert.equal(devices[1].uuid, null);
  const conns = netSvc.parseConnections('Wired 1:11111111-1111-1111-1111-111111111111:802-3-ethernet:eth0:yes:yes\nOld:22222222-2222-2222-2222-222222222222:802-3-ethernet::no:no\n');
  assert.deepEqual(conns.map((c) => [c.name, c.active, c.device]), [['Wired 1', true, 'eth0'], ['Old', false, null]]);
  const fields = netSvc.parseFields('ipv4.method:manual\nipv4.addresses:192.168.1.10/24,10.0.0.2/8\nipv4.gateway:192.168.1.1\nipv4.dns:1.1.1.1\nIP6.ADDRESS[1]:2001\\:db8\\:\\:1/64\nIP6.ADDRESS[2]:fe80\\:\\:1/64\n');
  assert.equal(fields['IP6.ADDRESS'], '2001:db8::1/64,fe80::1/64');
  assert.deepEqual(netSvc.ipConfigFrom(fields, 4), { method: 'manual', addresses: ['192.168.1.10/24', '10.0.0.2/8'], gateway: '192.168.1.1', dns: ['1.1.1.1'], ignoreAutoDns: false });
  const uuid = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(net.changeCommands({ kind: 'ip', uuid, ipv4: { method: 'manual', addresses: ['192.168.1.10/24'], gateway: '192.168.1.1', dns: ['1.1.1.1'] } }), [
    ['connection', 'modify', uuid, 'ipv4.method', 'manual', 'ipv4.addresses', '192.168.1.10/24', 'ipv4.gateway', '192.168.1.1', 'ipv4.dns', '1.1.1.1', 'ipv4.ignore-auto-dns', 'no'],
    ['connection', 'up', uuid],
  ]);
  assert.throws(() => net.changeCommands({ kind: 'ip', uuid, ipv4: { method: 'manual', addresses: [], gateway: '', dns: [] } }), /at least one address/);
  assert.throws(() => net.changeCommands({ kind: 'ip', uuid, ipv4: { method: 'manual', addresses: ['300.1.1.1/24'], gateway: '', dns: [] } }), /valid IPv4/);
  assert.throws(() => net.changeCommands({ kind: 'ip', uuid, ipv4: { method: 'manual', addresses: ['10.0.0.1/24'], gateway: '::1', dns: [] } }), /gateway/);
  assert.throws(() => net.changeCommands({ kind: 'ip', uuid: 'eth0; reboot', ipv4: { method: 'auto', addresses: [], gateway: '', dns: [] } }), { status: 400 });
  assert.throws(() => net.changeCommands({ kind: 'ip', uuid, mtu: 100 }), /MTU/);
  const bond = net.changeCommands({ kind: 'bond', name: 'bond0', mode: 'active-backup', ports: ['eth0', 'eth1'] });
  assert.equal(bond.length, 4);
  assert.deepEqual(bond[1], ['connection', 'add', 'type', 'ethernet', 'con-name', 'bond0-port-eth0', 'ifname', 'eth0', 'master', 'bond0', 'slave-type', 'bond']);
  assert.throws(() => net.changeCommands({ kind: 'bond', name: 'bond0', mode: 'evil', ports: ['eth0'] }), /bond mode/);
  assert.throws(() => net.changeCommands({ kind: 'bridge', name: 'br0', stp: false, ports: [] }), /at least one port/);
  assert.throws(() => net.changeCommands({ kind: 'vlan', name: 'eth0.5000', parent: 'eth0', id: 5000 }), /VLAN ID/);
  assert.equal(net.changeCommands({ kind: 'vlan', name: 'eth0.10', parent: 'eth0', id: 10 })[0].includes('vlan.id'), true);
  assert.throws(() => net.changeCommands({ kind: 'bridge', name: 'this-name-is-too-long', stp: false, ports: ['eth0'] }), /interface name/);
  assert.equal(net.parseCheckpoint('o "/org/freedesktop/NetworkManager/Checkpoint/3"\n'), '/org/freedesktop/NetworkManager/Checkpoint/3');
  assert.equal(net.parseCheckpoint('o "/etc/passwd"'), null);

  // --- settings ---
  assert.equal(set.assertHostname('game-01.example.com'), 'game-01.example.com');
  for (const bad of ['-bad', 'a_b', 'a..b', 'x'.repeat(64)]) assert.throws(() => set.assertHostname(bad), { status: 400 }, bad);
  assert.deepEqual(set.assertNtpServers(['time.cloudflare.com', '192.168.1.1', '2001:db8::1']), ['time.cloudflare.com', '192.168.1.1', '2001:db8::1']);
  assert.throws(() => set.assertNtpServers(['time.example.com; rm -rf /']), { status: 400 });
  assert.throws(() => set.assertTimezone('../../etc/passwd'), { status: 400 });
  assert.equal(set.chronySourceDir('pool 2.pool.ntp.org iburst\nsourcedir /etc/chrony/sources.d\n'), '/etc/chrony/sources.d');
  const tuned = setSvc.parseTunedList('Available profiles:\n- balanced                    - General non-specialized tuned profile\n- throughput-performance      - Broadly applicable tuning\nCurrent active profile: balanced\n');
  assert.deepEqual(tuned, { profiles: [{ name: 'balanced', description: 'General non-specialized tuned profile' }, { name: 'throughput-performance', description: 'Broadly applicable tuning' }], active: 'balanced' });
  assert.equal(setSvc.parseTunedList('Current active profile: No current active profile.').active, null);
  const sched = setSvc.parseScheduledShutdown('USEC=1700000000000000\nWARN_WALL=1\nMODE=reboot\nWALL_MESSAGE=Maintenance\n');
  assert.deepEqual(sched, { at: new Date(1700000000000).toISOString(), mode: 'reboot', message: 'Maintenance' });
  assert.equal(setSvc.parseScheduledShutdown(''), null);
  assert.deepEqual(setSvc.parseKeyValues('Timezone=Europe/Berlin\nNTP=yes\nPRETTY_NAME="Debian GNU/Linux 13"\n'), { Timezone: 'Europe/Berlin', NTP: 'yes', PRETTY_NAME: 'Debian GNU/Linux 13' });

  // --- security ---
  assert.equal(sec.setSelinuxConfig('# comment\nSELINUX=enforcing\nSELINUXTYPE=targeted\n', 'permissive'), '# comment\nSELINUX=permissive\nSELINUXTYPE=targeted\n');
  assert.equal(sec.setSelinuxConfig('SELINUXTYPE=targeted', 'enforcing'), 'SELINUXTYPE=targeted\nSELINUX=enforcing\n');
  const avc = sec.parseAvc('type=AVC msg=audit(1700000000.123:456): avc:  denied  { read } for  pid=1234 comm="nginx" name="index.html" dev="sda1" ino=1 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:user_home_t:s0 tclass=file permissive=0\ntype=SYSCALL msg=audit(1700000000.123:456): arch=c000003e\n');
  assert.equal(avc.length, 1);
  assert.deepEqual([avc[0].comm, avc[0].permission, avc[0].target, avc[0].targetClass, avc[0].source], ['nginx', 'read', 'index.html', 'file', 'system_u:system_r:httpd_t:s0']);
  assert.equal(avc[0].time, new Date(1700000000000).toISOString());
  const aa = sec.parseAppArmorDenials('audit: type=1400 audit(1700000000.1:9): apparmor="DENIED" operation="open" profile="/usr/sbin/cupsd" name="/etc/shadow" pid=1 comm="cupsd" requested_mask="r" denied_mask="r"\nother line\n');
  assert.deepEqual([aa[0].profile, aa[0].target, aa[0].permission], ['/usr/sbin/cupsd', '/etc/shadow', 'r']);
  const profileFiles = [
    { file: '/etc/apparmor.d/usr.sbin.cupsd', text: '#include <tunables/global>\n/usr/sbin/cupsd flags=(attach_disconnected) {\n}\n' },
    { file: '/etc/apparmor.d/docker', text: 'profile docker-default flags=(attach_disconnected,mediate_deleted) {\n}\n' },
  ];
  assert.equal(sec.findProfileFile('/usr/sbin/cupsd', profileFiles), '/etc/apparmor.d/usr.sbin.cupsd');
  assert.equal(sec.findProfileFile('docker-default', profileFiles), '/etc/apparmor.d/docker');
  assert.equal(sec.findProfileFile('nope', profileFiles), null);
  assert.match(sec.deployHook('/var/lib/outpost/tls', 'outpost'), /install -D -m 600 -o outpost "\$RENEWED_LINEAGE\/privkey.pem" \/var\/lib\/outpost\/tls\/key.pem/);
  assert.throws(() => sec.deployHook('/tmp/x; rm -rf /', 'outpost'), { status: 400 });
  assert.throws(() => sec.deployHook('/tmp/x', 'root;id'), { status: 400 });

  // --- panel TLS ---
  assert.throws(() => tls.validatePair('nope', 'nope'), /certificate isn’t valid/);
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (openssl.status === 0) {
    const info = await tls.generateSelfSigned(['panel.test']);
    assert.ok(info.names.includes('panel.test'));
    assert.equal(info.selfSigned, true);
    assert.ok(info.daysLeft > 800);
    const status = tls.tlsStatus();
    assert.equal(status.source, 'self-signed');
    assert.equal(status.enabled, false);
    const cert = await fs.readFile(path.join(tls.TLS_DIR, 'cert.pem'), 'utf8');
    const key = await fs.readFile(path.join(tls.TLS_DIR, 'key.pem'), 'utf8');
    assert.equal(tls.validatePair(cert, key).fingerprint, info.fingerprint);
    const otherKey = (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => tls.validatePair(cert, otherKey), /doesn’t match/);
    console.log('TLS with openssl: ok');
  } else {
    console.log('TLS with openssl: skipped (openssl not found)');
  }
  assert.throws(() => tls.setTlsOptions({ port: 70000 }), { status: 400 });

  // --- diagnostics ---
  assert.equal(diag.setKdumpPath('fedora', 'path /var/crash\ncore_collector makedumpfile -l\n', '/srv/crash'), 'path /srv/crash\ncore_collector makedumpfile -l\n');
  assert.equal(diag.setKdumpPath('fedora', 'core_collector x\n', '/srv/crash'), 'core_collector x\npath /srv/crash\n');
  assert.equal(diag.setKdumpPath('debian', 'USE_KDUMP=1\n#KDUMP_COREDIR="/var/crash"\n', '/srv/crash'), 'USE_KDUMP=1\nKDUMP_COREDIR="/srv/crash"\n');
  assert.equal(diagSvc.kdumpPathFrom('debian', 'KDUMP_COREDIR="/data/dumps"\n'), '/data/dumps');
  assert.equal(diagSvc.kdumpPathFrom('fedora', ''), '/var/crash');
  assert.ok(diag.SOS_NAME_RE.test('sosreport-host-2026-11-09-abcdef.tar.xz'));
  assert.ok(!diag.SOS_NAME_RE.test('../sosreport-x.tar.xz'));
  assert.throws(() => diagSvc.reportPath('../../etc/passwd'), { status: 400 });

  // --- metrics history ---
  assert.deepEqual(metrics.parseIoStat('8:0 rbytes=100 wbytes=50 rios=1\n8:16 rbytes=10 wbytes=5\n'), { read: 110, write: 55 });
  assert.equal(metrics.parseCpuStat('usage_usec 123456\nuser_usec 1\n'), 123456);
  const cg = path.join(dir, 'cgroup');
  await fs.mkdir(path.join(cg, 'system.slice', 'nginx.service'), { recursive: true });
  await fs.writeFile(path.join(cg, 'cgroup.controllers'), 'cpu io memory\n');
  await fs.writeFile(path.join(cg, 'system.slice', 'nginx.service', 'cpu.stat'), 'usage_usec 5000000\n');
  await fs.writeFile(path.join(cg, 'system.slice', 'nginx.service', 'memory.current'), '10485760\n');
  await fs.writeFile(path.join(cg, 'system.slice', 'nginx.service', 'io.stat'), '8:0 rbytes=1 wbytes=2\n');
  assert.deepEqual(metrics.readServiceCgroups(cg).get('nginx.service'), { cpuUsec: 5000000, memBytes: 10485760, ioRead: 1, ioWrite: 2 });
  const rows = Array.from({ length: 120 }, (_, i) => ({ at: i * 60_000, cpu: i === 100 ? 95 : 5 + (i % 3) }));
  const ds = metrics.downsample(rows, 0, 120 * 60_000, ['cpu']);
  assert.equal(ds.length, 120);
  assert.deepEqual(metrics.anomalies(ds, 'cpu', 20), [100 * 60_000]);
  const [detail] = metrics.anomalyDetails(ds, 'cpu', 20);
  assert.equal(detail.at, 100 * 60_000);
  assert.equal(detail.value, 95);
  assert.equal(detail.samples, 120);
  assert.ok(detail.value > detail.threshold && detail.standardDeviations > 3);
  assert.ok(Math.abs(detail.threshold - (detail.mean + 3 * (detail.value - detail.mean) / detail.standardDeviations)) < 1e-8);
  assert.deepEqual(metrics.anomalyDetails(ds, 'cpu', 100), [], 'minimum threshold suppresses small spikes');
  assert.deepEqual(metrics.anomalyDetails(Array.from({ length: 30 }, (_, at) => ({ at, cpu: 5 })), 'cpu'), [], 'constant values are not unusual');
  assert.deepEqual(metrics.anomalies(ds.slice(0, 20), 'cpu'), [], 'too few points to judge');
  assert.ok(metrics.downsample(Array.from({ length: 2000 }, (_, i) => ({ at: i * 60_000, cpu: 1 })), 0, 2000 * 60_000, ['cpu']).length <= 360);
  const history = metrics.metricsHistory('1h');
  assert.equal(history.range, '1h');
  assert.ok(Array.isArray(history.host));

  // --- generic host jobs ---
  const j = jobs.startHostJob('t', 'Test', 'tester', async (p) => { p('hello\n'); return { file: 'x' }; });
  assert.throws(() => jobs.startHostJob('t', 'Again', 'tester', async () => 1), { status: 409 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobs.getHostJob('t').state, 'succeeded');
  assert.deepEqual(jobs.getHostJob('t').result, { file: 'x' });
  assert.equal(j.output, 'hello\n');

  // --- the helper validates every new operation before running anything ---
  const helperPath = fileURLToPath(new URL(`../${source ? 'src' : 'dist'}/services/hostFilesHelper.${ext}`, import.meta.url));
  const helper = spawn(process.execPath, [...process.execArgv, helperPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: helper.stdout });
  const replies = [];
  const waiters = [];
  lines.on('line', (line) => (waiters.length ? waiters.shift()(JSON.parse(line)) : replies.push(JSON.parse(line))));
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiters.push(resolve)));
  assert.equal((await next()).ready, true);
  const cases = [
    ['account.create', { username: 'Bad Name', shell: '/bin/bash' }],
    ['account.keys.write', { username: '../root', content: '' }],
    ['group.members', { name: 'wheel', add: ['x;y'] }],
    ['session.terminate', { id: '1; reboot' }],
    ['net.apply', { change: { kind: 'delete', uuid: 'nope' } }],
    ['net.confirm', { checkpoint: '/etc/passwd' }],
    ['settings.hostname', { hostname: '-x' }],
    ['settings.ntpServers', { servers: ['$(id)'] }],
    ['power.schedule', { action: 'explode' }],
    ['tuned.profile', { profile: '../x' }],
    ['selinux.mode', { mode: 'off' }],
    ['crypto.policy', { policy: 'default; id' }],
    ['tls.certbot', { domain: 'localhost', email: 'a@b.c', targetDir: '/tmp', owner: 'x' }],
    ['sos.report', { targetDir: 'relative', owner: 'x' }],
    ['kdump.config', { path: '/x; id' }],
  ];
  for (const [i, [op, args]] of cases.entries()) {
    helper.stdin.write(`${JSON.stringify({ id: i + 1, op, args })}\n`);
    const r = await next();
    assert.equal(r.ok, false, op);
    assert.ok(r.status === 400 || r.status === 409, `${op} → ${r.status} ${r.error}`);
  }
  helper.stdin.end();
  assert.equal(await new Promise((resolve) => helper.once('exit', resolve)), 0);

  // --- routes: local, node link and the proxy to a linked host ---
  const admin = users.createUser('host-admin', 'test-password-123', 'admin');
  const viewer = users.createUser('host-viewer', 'test-password-123', 'viewer');
  const adminToken = createToken(admin.id, admin.username, 'admin');
  const viewerToken = createToken(viewer.id, viewer.username, 'viewer');
  const app = express();
  app.use(express.json());
  app.use('/api/host', requireAuth, requireRole('admin'), localHostContext, hostLocalOnly, hostAdminApi);
  app.use('/api/remote-host', requireAuth, requireRole('admin'), localHostContext, remoteHostRouter);
  app.use('/api/node-link', nodeLinkRouter);
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message }));
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = (route, token, init = {}) => fetch(origin + route, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

  assert.equal((await req('/api/host/settings')).status, 401);
  assert.equal((await req('/api/host/settings', viewerToken)).status, 403);
  for (const route of ['/api/host/settings', '/api/host/metrics?range=24h', '/api/host/security', '/api/host/diagnostics', '/api/host/admin-mode', '/api/host/network', '/api/host/accounts']) {
    const r = await req(route, adminToken);
    assert.equal(r.status, 200, `${route}: ${await r.clone().text()}`);
  }
  const privileged = hostFiles.hostFilesStatus(adminToken).admin.alwaysOn;
  if (!privileged && process.platform === 'linux') {
    for (const [route, body] of [['/api/host/settings/hostname', { hostname: 'x' }], ['/api/host/accounts/users', { username: 'x' }], ['/api/host/network/changes', { change: {} }], ['/api/host/diagnostics/sos', {}]]) {
      const r = await req(route, adminToken, { method: 'POST', body: JSON.stringify(body) });
      assert.ok([403, 409].includes(r.status), `${route} without Admin Mode → ${r.status}`);
    }
  }
  assert.equal((await req('/api/host/diagnostics/reports/..%2F..%2Fetc%2Fpasswd', adminToken)).status, 400);
  assert.equal((await req('/api/host/accounts/users/' + os.userInfo().username, adminToken, { method: 'DELETE' })).status, process.platform === 'linux' ? 403 : 409);

  // Remote administration is off by default.
  assert.deepEqual(await (await req('/api/host/remote-access', adminToken)).json(), { enabled: false });
  const key = nodes.getLocalNodeKey();
  const nodeHeaders = { 'x-outpost-node-key': key, 'x-outpost-host-session': 'a'.repeat(43), 'x-outpost-acting-user': 'alice', 'x-outpost-origin': 'central' };
  assert.equal((await req('/api/node-link/host/admin-mode', null, { headers: { 'x-outpost-host-session': 'a'.repeat(43) } })).status, 401);
  assert.equal((await req('/api/node-link/host/admin-mode', null, { headers: nodeHeaders })).status, 403);
  assert.equal((await req('/api/host/remote-access', adminToken, { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status, 200);
  const remoteStatus = await (await req('/api/node-link/host/admin-mode', null, { headers: nodeHeaders })).json();
  assert.equal(remoteStatus.remote, true);
  assert.equal((await req('/api/node-link/host/admin-mode', null, { headers: { ...nodeHeaders, 'x-outpost-host-session': 'short' } })).status, 400);
  // The local-only switch isn't reachable over the node link.
  assert.equal((await req('/api/node-link/host/remote-access', null, { headers: nodeHeaders, method: 'PUT', body: '{"enabled":false}' })).status, 404);

  // Proxy: register this same panel as a linked node and go through /api/remote-host.
  const { node } = await nodes.addNode('loopback', origin, key);
  const proxied = await req(`/api/remote-host/${node.id}/admin-mode?token=${adminToken}`, adminToken);
  assert.equal(proxied.status, 200);
  assert.equal((await proxied.json()).remote, true);
  assert.equal((await req(`/api/remote-host/${node.id}/settings`, adminToken)).status, 200);
  assert.equal((await req(`/api/remote-host/${node.id}/settings`, viewerToken)).status, 403);
  assert.equal((await req(`/api/remote-host/nope/settings`, adminToken)).status, 404);
  setSetting(REMOTE_ADMIN_SETTING, '0');
  assert.equal((await req(`/api/remote-host/${node.id}/settings`, adminToken)).status, 403);
  // A rejected node key must not sign the browser out (401 would).
  db.prepare('UPDATE nodes SET api_key = ? WHERE id = ?').run('mcn_wrong', node.id);
  assert.equal((await req(`/api/remote-host/${node.id}/settings`, adminToken)).status, 502);
  const audited = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'host.remote%'").all().map((r) => r.action);
  assert.ok(audited.includes('host.remote.allow'));

  console.log('host-admin: ok');
} finally {
  hostFiles.stopHostFileSessions();
  tls.stopTls();
  server?.close();
  db.close?.();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
