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
const app = express();
app.use(express.json());
app.get('/api/auth/status', (_req, res) => res.json({ setupRequired: false }));
app.get('/api/auth/me', (_req, res) => res.json({ user: { id: 'admin', username: 'Backup tester', role: 'admin' } }));
app.get('/api/servers', (_req, res) => res.json({ servers: [server], metrics: {} }));
app.get('/api/servers/:id', (_req, res) => res.json({ server, running: server.status === 'running', permissions: ['files.read', 'backups.create', 'backups.restore'] }));
app.get('/api/environment/export/preview', (_req, res) => res.json({
  blockers: server.status === 'running' ? ['Stop Core Keeper and wait for it to finish saving.'] : [],
  instances: [{ id: server.id, name: server.name }],
}));
app.get('/api/servers/:id/backups', (_req, res) => res.json({ backups: [{
  fileName: 'backup-2026-11-22T12-00-00-000Z-with-a-max-length-backup-label-here.zip',
  sizeBytes: 1024, createdAt: '2026-11-22T12:00:00Z',
}] }));
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
  await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, viewport, text, evaluate, click, until, captureScreenshot }) => {
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
    assert(!await evaluate(`document.querySelector('a[download][href*="/environment/export"]')`));
    server.status = 'stopped';
    await click('Check again');
    await text('Download environment ZIP');
    await option('Include existing snapshots');
    await until(() => evaluate(`!!document.querySelector('a[href*="history=exclude"]')`), 'History setting included in download link');
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
  }, { artifactDirectory: artifacts });
  console.log('Backup scope, blocked environment export, history selection, both instance formats and responsive widths passed.');
} finally {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
