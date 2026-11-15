// Disposable browser fixtures for responsive page toolbars and player actions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { runBrowser } from './browserHarness.mjs';

const artifacts = path.resolve('artifacts/page-layout-review');
await fs.mkdir(artifacts, { recursive: true });
for (const name of ['browser-failure.json', 'browser-failure.png']) await fs.rm(path.join(artifacts, name), { force: true });
const server = { id: 'ui-review', name: 'Review instance', platform: 'java', loader: 'fabric', version: '1.21.1', build: null, server_port: 25565, status: 'running', created_at: '2026-10-01T12:00:00Z', auto_start: 0, restart_policy: 'never', min_memory_mb: 1024, max_memory_mb: 4096, suspended: 0 };
const player = { name: 'PlayerWithAnUnusuallyLongNameWithoutSpacesForWrapping', online: true, op: true, whitelisted: true, banned: false };
const job = { id: 'host-job', server_id: null, kind: 'antivirus', status: 'completed', stage: 'LongStageWithoutSpaces'.repeat(12), progress: 100, logs: [], created_at: 0, updated_at: 0 };
let fail = true, calls = 0, release;
const app = express(); app.use(express.json());
app.get('/api/auth/status', (_q, r) => r.json({ setupRequired: false }));
app.get('/api/auth/me', (_q, r) => r.json({ user: { id: 'reviewer', username: 'Reviewer', role: 'admin', theme: null }, creation: { canCreate: true, platforms: [], allowedPlatforms: [], maxInstances: 0, maxMemoryMb: 0, owned: 1 } }));
app.get('/api/servers', (_q, r) => r.json({ servers: [server], metrics: {} }));
app.get('/api/servers/:id', (_q, r) => r.json({ server, runtime: null, running: true, permissions: ['console', 'settings', 'power', 'players', 'files.read', 'files.write', 'backups.create', 'backups.restore', 'tasks', 'plugins'] }));
app.get('/api/servers/:id/players', (_q, r) => r.json({ players: [player] }));
app.get('/api/servers/:id/playerdata', (_q, r) => r.json({ players: [] }));
app.post('/api/servers/:id/players/:name/:action', async (_q, r) => { calls++; if (fail) return r.status(422).json({ error: 'Fixture action rejected' }); await new Promise(resolve => { release = resolve; }); r.json({ ok: true }); });
app.get('/api/workspace/jobs', (_q, r) => r.json({ jobs: [job] }));
app.get('/api/workspace/preferences/:kind', (_q, r) => r.json({ value: null }));
app.get('/api/system/public-address', (_q, r) => r.json({ address: null, source: null, behindNat: false }));
app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
// External font CDNs are optional product styling, not a prerequisite for an offline UI fixture.
const html = (await fs.readFile(path.resolve('web/dist/index.html'), 'utf8')).replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
app.use(express.static(path.resolve('web/dist'), { index: false })); app.get('*', (_q, r) => r.type('html').send(html));
const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
try {
  await runBrowser(`http://127.0.0.1:${http.address().port}`, async ({ navigate, text, click, evaluate, until, viewport, captureScreenshot, pressKey }) => {
    const setInput = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await viewport(1280, 900); await navigate('/instances/ui-review/players'); await text(player.name);
    assert(await evaluate(`(()=>{const input=document.querySelector('input[placeholder="Notch"]').getBoundingClientRect(),add=[...document.querySelectorAll('button')].find(b=>b.textContent==='Add').getBoundingClientRect();return Math.abs(input.bottom-add.bottom)<2;})()`), 'Whitelist action aligns with input without a hard-coded label offset');
    await setInput('input[placeholder="Notch"]', 'TypedPlayer'); await click('Add'); await text('Fixture action rejected');
    assert.equal(await evaluate(`document.querySelector('input[placeholder="Notch"]').value`), 'TypedPlayer', 'A rejected whitelist action preserves the typed name');
    fail = false;
    await until(() => evaluate(`!document.querySelector('input[placeholder="Notch"]').disabled`), 'Failed player action releases input');
    await evaluate(`document.querySelector('input[placeholder="Notch"]').focus()`);
    assert(await evaluate(`document.activeElement===document.querySelector('input[placeholder="Notch"]') && !!document.activeElement.form?.querySelector('button[type="submit"]')`), 'Whitelist input is focused inside a native submit form');
    await pressKey('Enter'); await until(() => !!release, 'Pending player action');
    assert(await evaluate(`document.querySelector('input[placeholder="Notch"]').disabled`), 'Pending success cannot clear newly typed input');
    assert(await evaluate(`[...document.querySelectorAll('main button')].filter(b=>['Add','De-op','Unwhitelist','Kick','Ban'].includes(b.textContent)).every(b=>b.disabled)`), 'Pending player actions cannot be submitted again');
    await click('Add'); assert.equal(calls, 2); release(); release = undefined;
    await until(() => evaluate(`document.querySelector('input[placeholder="Notch"]').value===''`), 'Successful whitelist action clears name');
    for (const width of [320, 390, 768]) {
      await viewport(width, 900);
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'), `Player page fits ${width}px`);
      assert(await evaluate(`[...document.querySelectorAll('main button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})`), `Player controls stay inside ${width}px viewport`);
    }
    await viewport(390, 900); await evaluate(`[...document.querySelectorAll('[aria-label="Operation queue"] button')].find(b=>b.textContent==='Clear finished')?.click()`);
    await captureScreenshot(path.join(artifacts, 'players-mobile.png'));
    await navigate('/jobs'); await text('Host operation');
    assert(!await evaluate(`document.querySelector('main').innerText.includes('Removed instance')`), 'Host jobs are not mislabeled as deleted instances');
    await setInput('input[aria-label="Search jobs"]', 'No such job'); await text('No jobs match these filters.'); await click('Clear filters'); await text('Host operation');
    for (const width of [320, 390, 768]) { await viewport(width, 900); assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'), `Job filters and long stage fit ${width}px`); }
    await viewport(390, 900); await captureScreenshot(path.join(artifacts, 'jobs-mobile.png'));
  }, { artifactDirectory: artifacts });
  console.log('Page layout review: responsive player/job toolbars, long content wrapping, whitelist error retention, pending action locks, host job labels and filter reset passed.');
} finally { release?.(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
