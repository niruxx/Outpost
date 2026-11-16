import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-firewall-instances-'));
process.env.OUTPOST_DATA_DIR = root;
const { db } = await import('../dist/db/db.js');
const { createFirewall, firewall, parseUfwAdded } = await import('../dist/services/firewallService.js');
const { instanceFirewallPorts } = await import('../dist/services/instanceFirewallService.js');
const servers = await import('../dist/services/serverService.js');
const users = await import('../dist/services/userService.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { createToken } = await import('../dist/auth/tokens.js');
const originals = { status: firewall.status, allowPorts: firewall.allowPorts };
let http;

function fixture(backend, options = {}) {
  const commands = [], ufw = [], runtime = new Set(), permanent = new Set();
  let active = options.active !== false, fail = options.fail ?? null;
  const instance = createFirewall({
    platform: 'linux', isRoot: !options.sudo, user: 'outpost', panelPort: 8642, sshPorts: () => [22],
    exists: file => backend === 'ufw' ? file === '/usr/sbin/ufw' : file === '/usr/bin/firewall-cmd' || !options.onlyFirewalld && file === '/usr/sbin/ufw',
    exec: async (command, originalArgs) => {
      commands.push([command, ...originalArgs]);
      if (options.denySudo) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
      const args = command === 'sudo' ? originalArgs.slice(2) : originalArgs;
      const bin = command === 'sudo' ? originalArgs[1] : command;
      let stdout = '';
      if (bin.endsWith('ufw')) {
        if (args[0] === 'status') stdout = `Status: ${active ? 'active' : 'inactive'}\nDefault: deny (incoming), allow (outgoing)\n`;
        else if (args[0] === 'show') stdout = ufw.join('\n');
        else if (args[0] === 'insert') ufw.unshift('ufw ' + args.slice(2).map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' '));
        else throw new Error('Unexpected ufw command: ' + args.join(' '));
      } else if (args[0] === '--state') stdout = active ? 'running' : 'not running';
      else if (args.includes('--get-default-zone')) stdout = 'public\n';
      else if (args.includes('--list-ports')) stdout = [...(args.includes('--permanent') ? permanent : runtime)].join(' ');
      else if (args.includes('--list-rich-rules')) stdout = options.rich || '';
      else if (args.includes('--list-services')) stdout = '';
      else if (args.some(a => a.startsWith('--add-port='))) {
        const port = args.find(a => a.startsWith('--add-port=')).slice('--add-port='.length);
        if (fail === port && !args.includes('--permanent')) { fail = null; return { code: 1, stdout: '', stderr: 'fixture write failed' }; }
        (args.includes('--permanent') ? permanent : runtime).add(port);
      } else throw new Error('Unexpected firewall-cmd command: ' + args.join(' '));
      return { code: 0, stdout, stderr: '' };
    },
  });
  return { ...instance, commands, ufw, runtime, permanent };
}
function make(name, platform = 'java', options = {}) {
  const record = servers.createServerRecord({ name, platform, loader: platform === 'java' ? 'paper' : platform, version: 'fixture', serverPort: 25565, minMemoryMb: 128, maxMemoryMb: 256, createdBy: null, ...options });
  servers.setServerStatus(record.id, 'stopped'); return servers.getServer(record.id);
}
function write(server, file, text) { const target = path.join(instanceDir(server.id), file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
try {
  const mc = make('Minecraft'), cs2 = make('CS2', 'steam', { steamPreset: 'cs2', steamAppId: '730', serverPort: 27016, extraArgs: '-port 27025' });
  write(mc, 'server.properties', 'server-port=25580\nenable-query=true\nquery.port=25581\nenable-rcon=true\nrcon.port=25575\n');
  assert.deepEqual(instanceFirewallPorts(mc).map(p => [p.port, p.protocol]), [[25580, 'tcp'], [25581, 'udp']]);
  assert.deepEqual(instanceFirewallPorts(cs2).map(p => [p.port, p.protocol]), [[27025, 'udp']]);
  const override = { ...cs2, launch_config: JSON.stringify({ args: '-port {{PORT}} +hostport 27030' }) };
  assert.equal(instanceFirewallPorts(override)[0].port, 27030);
  const bedrock = make('Bedrock', 'bedrock'); write(bedrock, 'server.properties', 'server-port=19140\nserver-portv6=19141\n');
  assert.deepEqual(instanceFirewallPorts(bedrock).map(p => [p.port, p.protocol]), [[19140, 'udp'], [19141, 'udp']]);
  const proxy = make('Velocity', 'java', { loader: 'velocity' }); write(proxy, 'velocity.toml', 'bind = "0.0.0.0:25590"\n');
  assert.equal(instanceFirewallPorts(proxy)[0].port, 25590);
  const beammp = make('BeamMP', 'custom', { launchConfig: JSON.stringify({ executable: 'BeamMP-Server', env: [{ key: 'BEAMMP_PORT', value: '{{PORT}}' }] }), serverPort: 30814 });
  assert.deepEqual(instanceFirewallPorts(beammp).map(p => [p.port, p.protocol]), [[30814, 'tcp'], [30814, 'udp']]);
  const manualBeammp = { ...beammp, launch_config: JSON.stringify({ executable: 'BeamMP-Server' }) };
  write(beammp, 'ServerConfig.toml', '[General]\nPort = 30999\n[Other]\nPort = 12345\n');
  assert.equal(instanceFirewallPorts(manualBeammp)[0].port, 30999);
  const docker = make('Container', 'docker', { dockerConfig: JSON.stringify({ image: 'test', ports: [{ host: 8080, container: 80, protocol: 'tcp' }, { host: 8081, container: 80, protocol: 'udp' }] }) });
  assert.deepEqual(instanceFirewallPorts(docker).map(p => [p.port, p.protocol]), [[8080, 'tcp'], [8081, 'udp']]);
  write(mc, 'server.properties', 'server-port=25565;bad-command\n');
  assert.throws(() => instanceFirewallPorts(mc), /between 1 and 65535/);
  write(mc, 'server.properties', 'server-port=25580\n');
  assert.throws(() => instanceFirewallPorts({ ...mc, launch_config: JSON.stringify({ workingDir: '../outside' }) }), /inside the instance/);

  const ufw = fixture('ufw', { sudo: true });
  ufw.ufw.push('ufw deny 25580/tcp', 'ufw allow 25580/tcp');
  let result = await ufw.allowPorts(instanceFirewallPorts(mc), 'Outpost: Minecraft');
  assert.equal(result.added.length, 1, 'Earlier deny is overridden by inserting the requested allow first');
  assert.equal(parseUfwAdded(ufw.ufw[0]).action, 'allow');
  assert(ufw.commands.some(command => command.join(' ').includes('sudo -n /usr/sbin/ufw insert 1 allow 25580/tcp')));
  const count = ufw.ufw.length;
  const repeated = await Promise.all([ufw.allowPorts(instanceFirewallPorts(mc), 'Outpost'), ufw.allowPorts(instanceFirewallPorts(mc), 'Outpost')]);
  assert(repeated.every(r => r.added.length === 0)); assert.equal(ufw.ufw.length, count, 'Repeated concurrent clicks do not duplicate rules');
  const off = fixture('ufw', { active: false }); await off.allowPorts(instanceFirewallPorts(mc), 'Outpost');
  assert.equal((await off.status()).active, false); assert(!off.commands.some(command => command.includes('enable')));
  const denied = fixture('ufw', { sudo: true, denySudo: true }); await assert.rejects(denied.allowPorts(instanceFirewallPorts(mc), 'Outpost'), /sudoers/);

  const firewalld = fixture('firewalld', { fail: '30814/udp' });
  result = await firewalld.allowPorts(instanceFirewallPorts(beammp), 'Outpost: BeamMP');
  assert.equal(result.added.length, 1); assert.equal(result.failed.length, 1, 'Partial failure is reported honestly');
  assert(firewalld.permanent.has('30814/tcp') && firewalld.runtime.has('30814/tcp'));
  result = await firewalld.allowPorts(instanceFirewallPorts(beammp), 'Outpost');
  assert.equal(result.existing.length, 1); assert.equal(result.added.length, 1); assert.equal(result.failed.length, 0);
  assert(firewalld.runtime.has('30814/udp') && firewalld.permanent.has('30814/udp'));
  assert(!firewalld.commands.some(command => command.includes('--reload')), 'Do not discard unrelated runtime-only firewalld rules');
  assert(!firewalld.commands.some(command => command.some(arg => arg.endsWith('/ufw'))), 'Running firewalld wins when both tools exist');
  const ephemeral = fixture('firewalld'); ephemeral.runtime.add('25580/tcp');
  await ephemeral.allowPorts(instanceFirewallPorts(mc), 'Outpost'); assert(ephemeral.permanent.has('25580/tcp'), 'Existing runtime-only rules become persistent');
  const stopped = fixture('firewalld', { active: false, onlyFirewalld: true });
  await assert.rejects(stopped.allowPorts(instanceFirewallPorts(mc), 'Outpost'), /not running/);
  const blocked = fixture('firewalld', { rich: 'rule family="ipv4" port port="25580" protocol="tcp" reject' });
  result = await blocked.allowPorts(instanceFirewallPorts(mc), 'Outpost');
  assert.equal(result.failed.length, 1); assert.match(result.failed[0].error, /explicit firewalld deny/);
  assert.equal(blocked.runtime.size, 0, 'Conflicting rich rules are reported instead of falsely claiming the port is open');

  firewall.status = ufw.status; firewall.allowPorts = ufw.allowPorts;
  const { firewallRouter } = await import('../dist/routes/firewall.routes.js');
  const admin = users.createUser('firewall-admin', 'fixture-password-123', 'admin');
  const manager = users.createUser('firewall-instance-manager', 'fixture-password-123', 'moderator');
  const viewer = users.createUser('firewall-viewer', 'fixture-password-123', 'viewer');
  const stranger = users.createUser('firewall-stranger', 'fixture-password-123', 'viewer');
  users.setFirewallAccess(manager.id, 'instances'); users.setFirewallAccess(viewer.id, 'view');
  users.setUserServerAccess(manager.id, [{ serverId: mc.id, permissions: ['files.read'] }]);
  users.setUserServerAccess(viewer.id, [{ serverId: mc.id, permissions: ['files.read'] }]);
  const app = express(); app.use(express.json()); app.use('/api/firewall', firewallRouter);
  app.use((error, _q, r, _next) => r.status(error.status ?? 500).json({ error: error.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const request = (url, user = admin, body) => fetch(`http://127.0.0.1:${http.address().port}/api/firewall${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${createToken(user.id, user.username, user.role)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let response = await request(`/instances/${mc.id}`, manager); assert.equal(response.status, 200);
  assert.equal((await response.json()).ports[0].port, 25580);
  write(mc, 'server.properties', 'server-port=25582\n');
  response = await request(`/instances/${mc.id}/allow`, manager, { port: 22, protocol: 'any', command: 'bad command' });
  let data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.added[0].port, 25582, 'Click reads current config and ignores client-supplied commands/ports');
  assert(!ufw.ufw.some(line => line.includes('22/')));
  assert.equal((await request(`/instances/${cs2.id}/allow`, manager, {})).status, 403);
  assert.equal((await request(`/instances/${mc.id}/allow`, viewer, {})).status, 403);
  assert.equal((await request(`/instances/${mc.id}`, stranger)).status, 403);
  response = await request('/'); data = await response.json();
  assert(data.instancePorts.some(p => p.serverId === mc.id && p.port === 25582));
  assert(data.instancePorts.some(p => p.serverId === cs2.id && p.port === 27025));
  write(mc, 'server.properties', 'server-port=not-a-port\n');
  assert.equal((await request(`/instances/${mc.id}/allow`, admin, {})).status, 400);
  console.log('Instance firewall: saved config ports, Minecraft/Bedrock/proxy/CS2/BeamMP/container protocols, UFW/firewalld commands, persistence, idempotency, partial retries, permission scopes and input safety passed. No host firewall was changed.');
} finally {
  firewall.status = originals.status; firewall.allowPorts = originals.allowPorts;
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}
