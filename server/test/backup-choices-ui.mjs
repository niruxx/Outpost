import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { runBrowser } from './browserHarness.mjs';

const artifacts = path.resolve('artifacts/backup-choices');
await fs.mkdir(artifacts, { recursive: true });
const server = {
  id: 'core-keeper', name: 'Core Keeper with a long instance name', platform: 'steam', steam_preset: 'core_keeper',
  steam_app_id: '1963720', loader: 'vanilla', version: 'latest', server_port: 27015, status: 'running',
};
let deduplicated = 0, zip = 0;
const snapshot = {
  fileName: 'backup-2026-11-22T12-00-00-000Z-auto.zip',
  sizeBytes: 1024, createdAt: '2026-11-22T12:00:00Z', name: null, label: null, scheduled: true,
};
const verified = { id: 'c03444b7-a979-4a8f-87d4-3800a399345b', at: Date.now(), fileCount: 1, logicalBytes: 1024, addedBytes: 1024, name: null, label: null };
const app = express();
app.use(express.json());
app.get('/api/auth/status', (_req, res) => res.json({ setupRequired: false }));
app.get('/api/auth/me', (_req, res) => res.json({ user: { id: 'admin', username: 'Backup tester', role: 'admin' } }));
app.get('/api/servers', (_req, res) => res.json({ servers: [server], metrics: {} }));
app.get('/api/servers/:id', (_req, res) => res.json({ server, running: server.status === 'running', permissions: ['files.read', 'backups.create', 'backups.restore'] }));
let submitted;
app.post('/api/environment/export/preview', (req, res) => res.json({
  blockers: req.body.includeFiles && server.status === 'running' ? ['Stop Core Keeper and wait for it to finish saving.'] : [],
  instances: [{ id: server.id, name: server.name }, { id: 'other', name: 'Second instance' }],
}));
app.post('/api/environment/export', express.urlencoded({ extended: false }), (req, res) => {
  submitted = JSON.parse(req.body.options);
  res.attachment('test.zip').type('application/zip').send(Buffer.from([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
});
app.get('/api/servers/:id/backups', (_req, res) => res.json({ backups: [snapshot] }));
app.patch('/api/servers/:id/backups/:fileName/metadata', (req, res) => {
  assert.equal(req.params.fileName, snapshot.fileName);
  Object.assign(snapshot, req.body);
  res.json({ backup: snapshot });
});
app.get('/api/servers/:id/reliability', (_req, res) => res.json({
  health: {}, alerts: [], maintenance: [], verification: [], recovery: null, preflight: null,
  backups: {
    storedBytes: 1024, logicalBytes: 1024, savedBytes: 0, manifests: [verified],
    policy: { daily: 7, weekly: 4, monthly: 6 },
  },
}));
app.patch('/api/servers/:id/reliability/deduplicated/:snapshot/metadata', (req, res) => {
  assert.equal(req.params.snapshot, verified.id);
  Object.assign(verified, req.body);
  res.json(verified);
});
app.get('/api/servers/:id/backups/schedule', (_req, res) => res.json({ schedule: null }));
app.get('/api/servers/:id/backups/storage', (_req, res) => res.json({ directory: null, snapshots: 'backups/core-keeper', rewind: 'rewind/core-keeper', available: true, changing: false }));
app.post('/api/servers/:id/backups', (_req, res) => { zip++; res.status(201).json({}); });
app.post('/api/servers/:id/reliability/deduplicated', (_req, res) => { deduplicated++; res.status(201).json({}); });
app.use('/api', (_req, res) => res.status(503).json({ error: 'Outside backup fixture scope' }));
const html = (await fs.readFile('web/dist/index.html', 'utf8')).replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
app.use(express.static(path.resolve('web/dist'), { index: false }));
app.get('*', (_req, res) => res.type('html').send(html));
const http = app.listen(0, '127.0.0.1');
await once(http, 'listening');
try {
  await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, viewport, text, evaluate, click, until, captureScreenshot, pressKey }) => {
    const option = (title) => evaluate(`[...document.querySelectorAll('label')].find(e => e.textContent.includes(${JSON.stringify(title)})).querySelector('input').click()`);
    const verifyWidth = async () => {
      for (const width of [320, 390, 768, 1280]) {
        await viewport(width, 900);
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `Backup controls fit ${width}px`);
      }
      await viewport(390, 900);
    };
    await viewport(390, 900);
    await navigate('/configuration?section=data');
    await text('Stop Core Keeper and wait for it to finish saving.');
    assert(await evaluate(`document.querySelector('form[action*="/environment/export"] button[type="submit"]').disabled`));
    server.status = 'stopped';
    await click('Check again');
    await until(() => evaluate(`!document.querySelector('form[action*="/environment/export"] button[type="submit"]').disabled`), 'Environment ZIP ready');
    await option('Existing snapshots');
    await evaluate(`(() => { const select = document.querySelector('form[action*="/environment/export"] select'); select.value = 'selected'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await text('Selected instances (2)');
    await option('Second instance');
    await option('Panel database');
    await text('This creates a files-only ZIP.');
    await until(() => evaluate(`!document.querySelector('form[action*="/environment/export"] button[type="submit"]').disabled`), 'Files ZIP ready');
    await evaluate(`document.querySelector('form[action*="/environment/export"] button[type="submit"]').focus()`);
    await pressKey('Enter');
    await until(() => !!submitted, 'Browser posted native download');
    assert.equal(submitted.includeDatabase, false);
    assert.equal(submitted.includeSnapshots, false);
    assert.equal(submitted.includeRestorePoints, true);
    assert.deepEqual(submitted.instanceIds, ['core-keeper']);
    await verifyWidth();
    await captureScreenshot(path.join(artifacts, 'environment-mobile.png'));
    await option('Single instance');
    await evaluate(`(() => { const select = [...document.querySelectorAll('select')].find(e => [...e.options].some(o => o.value === 'core-keeper')); select.value = 'core-keeper'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await text('Open instance backups');
    await click('Open instance backups');
    await text('Instance ZIP backups');
    await text('Backup storage');
    await verifyWidth();
    await captureScreenshot(path.join(artifacts, 'instance-mobile.png'));
    await click('Create ZIP backup');
    await text('Full instance ZIP created');
    assert.equal(zip, 1);
    await until(() => evaluate(`!document.querySelector('input[name="instance-backup-format"]').disabled && !document.querySelector('input[name="instance-backup-format"]').closest('fieldset').disabled`), 'ZIP refresh finished');
    await option('Deduplicated backup');
    await text('Create deduplicated backup');
    await click('Create deduplicated backup');
    await text('Deduplicated backup created');
    assert.equal(deduplicated, 1);

    const edit = async (button, name, label) => {
      await click(button);
      await text('Edit snapshot details');
      for (const [index, value] of [name, label].entries()) {
        await evaluate(`(() => {
          const input = document.querySelectorAll('[role="dialog"] input')[${index}];
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      }
      await click('Save details');
      await until(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'Snapshot editor closed');
    };
    const newName = 'W'.repeat(80);
    const newLabel = 'M'.repeat(40);
    await edit('Edit', newName, newLabel);
    await text(newName);
    await text(newLabel);
    await text('Scheduled');
    await verifyWidth();
    await edit('Edit', newName, '');
    assert.equal(snapshot.label, null);
    await navigate('/instances/core-keeper/reliability');
    await text('Verified and deduplicated backups');
    await edit('Edit details', 'Before testing', 'Stable');
    await text('Before testing');
    await text('Stable');
  }, { artifactDirectory: artifacts });
  console.log('Backup scope, both instance formats, snapshot naming, label clearing, and responsive widths passed.');
} finally {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
