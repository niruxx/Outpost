import assert from 'node:assert/strict';
import path from 'node:path';
import { panelPids } from './stop-panel-for-update.mjs';

const project = path.resolve('fixture-outpost');
const target = path.join(project, 'server', 'dist', 'index.js');
const group = '/system.slice/outpost.service';
const processes = {
  101: { executable: '/usr/bin/node', args: ['node', 'dist/index.js'], cwd: path.join(project, 'server'), group },
  102: { executable: '/usr/bin/node', args: ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'start'], cwd: project, group },
  103: { executable: '/usr/bin/node', args: ['node', 'game.cjs'], cwd: path.join(project, 'server', 'data', 'servers', 'custom'), group },
  104: { executable: '/usr/bin/node', args: ['node', 'worker-abc.mjs'], cwd: project, group },
  105: { executable: '/usr/bin/java', args: ['java', '-jar', 'server.jar'], cwd: project, group },
  106: { executable: '/usr/bin/node', args: ['node', target], cwd: project, group: '/user.slice/another.service' },
  107: { executable: '/usr/bin/node', args: ['node', target], cwd: project, group: group + '/nested' },
  108: { executable: '/usr/bin/node', args: ['node', target], cwd: project, group: group + '-different' },
};
const io = {
  realpathSync: value => value,
  readdirSync: () => [...Object.keys(processes), 'not-a-pid', '999'],
  readlinkSync: name => { const pid = path.basename(path.dirname(name)), item = processes[pid]; if (!item) throw new Error('exited'); return path.basename(name) === 'exe' ? item.executable : item.cwd; },
  readFileSync: name => { const pid = path.basename(path.dirname(name)), item = processes[pid]; if (!item) throw new Error('exited'); return path.basename(name) === 'cgroup' ? '0::' + item.group + '\n' : item.args.join('\0') + '\0'; },
};
assert.deepEqual(panelPids(project, group, '/proc', io), [101, 107]);
assert.throws(() => panelPids(project, '/', '/proc', io), /specific service cgroup/);
assert.throws(() => panelPids(project, '', '/proc', io), /specific service cgroup/);
console.log('Update stop targeting: panel identity, npm wrapper, games, supervisors, unrelated services, nested cgroups and exiting processes passed.');
