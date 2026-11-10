// npm run build --workspace=server && node server/test/mac-temperatures.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseMacTemperature, readMacTemperatures } from '../dist/services/macTemperatureService.js';

assert.equal(parseMacTemperature('64.2\n'), 64.2);
for (const invalid of ['0', '-1', '150', 'NaN', '', 'permission denied', '64.2\n65.1']) assert.equal(parseMacTemperature(invalid), null);
const missing = await readMacTemperatures(async () => { throw new Error('must not run'); }, async () => null);
assert.equal(missing.platform, 'macos');
assert.deepEqual(missing.sensors, []);
assert.match(missing.hint, /smctemp/);
const calls = [];
const readings = await readMacTemperatures(async (file, args) => {
  calls.push([file, ...args]);
  return args[0] === '-c' ? '64.2' : '36.2';
}, async () => '/path with spaces/smctemp');
assert.deepEqual(readings.sensors.map(s => [s.category, s.celsius]), [['cpu', 64.2], ['gpu', 36.2]]);
assert.equal(calls[0][0], '/path with spaces/smctemp');
assert.equal(readings.hint, undefined);
const partial = await readMacTemperatures(async (_, args) => {
  if (args[0] === '-g') throw new Error('timeout');
  return '71';
}, async () => '/smctemp');
assert.equal(partial.sensors.length, 1);
assert.match(partial.hint, /unavailable/);
const failed = await readMacTemperatures(async () => { throw new Error('permission denied'); }, async () => '/smctemp');
assert.deepEqual(failed.sensors, []);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-temperature-test-'));
const previousPath = process.env.OUTPOST_SMCTEMP_PATH;
const previousSysfs = process.env.OUTPOST_SYSFS_ROOT;
try {
  const helper = path.join(fixture, 'smctemp');
  await fs.writeFile(helper, 'fixture', { mode: 0o755 });
  process.env.OUTPOST_SMCTEMP_PATH = helper;
  const discovered = await readMacTemperatures(async file => { assert.equal(file, helper); return '55'; });
  assert.equal(discovered.sensors.length, 2);
  const hwmon = path.join(fixture, 'class/hwmon/hwmon0');
  await fs.mkdir(hwmon, { recursive: true });
  await fs.writeFile(path.join(hwmon, 'name'), 'coretemp');
  await fs.writeFile(path.join(hwmon, 'temp1_input'), '62000');
  process.env.OUTPOST_SYSFS_ROOT = fixture;
  const { getTemperatures } = await import('../dist/services/temperatureService.js');
  const linux = await getTemperatures();
  assert.equal(linux.platform, 'linux');
  assert.equal(linux.sensors[0].celsius, 62);
  assert.equal(linux.sensors[0].category, 'cpu');
} finally {
  if (previousPath === undefined) delete process.env.OUTPOST_SMCTEMP_PATH; else process.env.OUTPOST_SMCTEMP_PATH = previousPath;
  if (previousSysfs === undefined) delete process.env.OUTPOST_SYSFS_ROOT; else process.env.OUTPOST_SYSFS_ROOT = previousSysfs;
  await fs.rm(fixture, { recursive: true, force: true });
}
console.log('macOS sensor parsing, discovery, CPU/GPU readings and failure handling passed.');
