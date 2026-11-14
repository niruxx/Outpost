// npm run build && node server/test/appearance.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-appearance-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const { runMigrations } = await import('../dist/db/migrations.js');
const { authRouter } = await import('../dist/routes/auth.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
let http;
try {
  db.exec('ALTER TABLE users DROP COLUMN wallpaper_preferences');
  runMigrations(db); runMigrations(db);
  const a = users.createUser('first-user', 'test-password-123', 'viewer'), b = users.createUser('second-user', 'test-password-123', 'viewer');
  let browserUser = a;
  const token = (u) => createToken(u.id, u.username, u.role);
  const app = express(); app.use(express.json());
  app.use((q, _r, next) => { if (q.headers.authorization === 'Bearer browser-fixture') q.headers.authorization = `Bearer ${token(browserUser)}`; next(); });
  app.use('/api/auth', authRouter);
  app.use((err, _q, r, _next) => r.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}`;
  const put = (user, wallpaper, extra = {}) => fetch(origin + '/api/auth/appearance', { method: 'PUT', headers: { Authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallpaper, ...extra }) });
  const preferences = { style: 'aurora', animated: true, speed: 'slow', intensity: 'subtle' };
  for (const style of ['theme', 'aurora', 'starfield', 'bubbles', 'fireflies', 'rain', 'waves']) assert.equal((await put(a, { ...preferences, style })).status, 200);
  assert.equal((await put(a, preferences, { userId: b.id })).status, 200);
  assert.equal(users.getUserById(b.id).wallpaper_preferences, null, 'users can change only their own preferences');
  for (const bad of [{ ...preferences, style: 'arbitrary-css' }, { ...preferences, animated: 'yes' }, { ...preferences, speed: 'warp' }, { ...preferences, intensity: 'invisible' }, null]) assert.equal((await put(a, bad)).status, 400);
  assert.deepEqual(JSON.parse(users.getUserById(a.id).wallpaper_preferences), preferences, 'invalid saves do not change the last valid preference');
  const me = await (await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${token(a)}` } })).json();
  assert.deepEqual(JSON.parse(me.user.wallpaper_preferences), preferences);
  assert.equal((await fetch(origin + '/api/auth/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  if (process.env.OUTPOST_TEST_BROWSER_UI === '1') {
    const { runBrowser } = await import('./browserHarness.mjs');
    app.get('/api/servers', (_q, r) => r.json({ servers: [] }));
    app.use('/api', (_q, r) => r.status(503).json({ error: 'Outside fixture scope' }));
    app.use(express.static(path.resolve('web/dist'))); app.get('*', (_q, r) => r.sendFile(path.resolve('web/dist/index.html')));
    await runBrowser(origin, async ({ navigate, text, evaluate, until, emulateReducedMotion, captureScreenshot }) => {
      await emulateReducedMotion(false);
      await navigate('/configuration'); await text('Background animation');
      assert.equal(await evaluate("document.querySelectorAll('input[name=\"wallpaper-style\"]').length"), 7);
      // Ensure the full-motion path is exercised even if the host OS has reduced motion enabled.
      await evaluate("localStorage.setItem('outpost_effects','full')");
      await navigate('/configuration'); await text('Background animation');
      for (const style of ['aurora', 'starfield', 'bubbles', 'fireflies', 'rain', 'waves']) {
        await until(() => evaluate("!document.querySelector('input[name=\"wallpaper-style\"][value=\"" + style + "\"]').disabled"), 'picker available');
        await evaluate(`document.querySelector('input[name="wallpaper-style"][value="${style}"]').click()`);
        await until(() => evaluate(`document.documentElement.dataset.wallpaperStyle === '${style}'`), `style ${style} applied`);
        assert.equal(await evaluate("[...document.querySelector('.ui-wallpaper .wallpaper-scene').children].some(e=>getComputedStyle(e).display!=='none')"), true);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.ui-wallpaper')).pointerEvents"), 'none');
      }
      assert.equal(await evaluate("[...document.querySelector('.ui-wallpaper .wallpaper-scene').children].some(e=>getComputedStyle(e).display!=='none' && getComputedStyle(e).animationName!=='none')"), true, 'selected scene really animates');
      await emulateReducedMotion(true);
      assert.equal(await evaluate("[...document.querySelector('.ui-wallpaper .wallpaper-scene').children].every(e=>getComputedStyle(e).animationName==='none')"), true, 'OS reduced motion overrides full effects');
      await emulateReducedMotion(false);
      await evaluate("[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Reduce effects')).querySelector('input').click()");
      assert.equal(await evaluate("[...document.querySelector('.ui-wallpaper .wallpaper-scene').children].every(e=>getComputedStyle(e).animationName==='none')"), true, 'reduced effects stops custom scenes');
      await evaluate("[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Reduce effects')).querySelector('input').click()");
      if (process.env.OUTPOST_WALLPAPER_SCREENSHOT) {
        await evaluate("const main=document.querySelector('.ui-main'); main.scrollTop += document.querySelector('#wallpaper-heading').getBoundingClientRect().top - main.getBoundingClientRect().top - 16");
        await captureScreenshot(process.env.OUTPOST_WALLPAPER_SCREENSHOT);
      }
      await until(() => evaluate("!document.querySelector('select[aria-label=\"Animation speed\"]').disabled"), 'speed available');
      await evaluate("const s=document.querySelector('select[aria-label=\"Animation speed\"]'); s.value='fast'; s.dispatchEvent(new Event('change',{bubbles:true}))");
      await until(() => evaluate("document.documentElement.dataset.wallpaperSpeed==='fast'"), 'speed saved');
      await navigate('/configuration'); await text('Background animation');
      assert.equal(await evaluate('document.documentElement.dataset.wallpaperStyle'), 'waves');
      assert.equal(await evaluate('document.documentElement.dataset.wallpaperSpeed'), 'fast');
      await until(() => evaluate("!document.querySelector('input[name=\"wallpaper-style\"]:checked').disabled"), 'picker ready');
      await evaluate("[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Animate background')).querySelector('input').click()");
      await until(() => evaluate("document.documentElement.dataset.wallpaper==='static'"), 'static preference applied');
      assert.equal(await evaluate("[...document.querySelector('.ui-wallpaper .wallpaper-scene').children].every(e=>getComputedStyle(e).animationName==='none')"), true);
      browserUser = b;
      await navigate('/configuration'); await text('Background animation');
      assert.equal(await evaluate('document.documentElement.dataset.wallpaperStyle'), 'theme', 'another account never inherits the previous custom style');
      browserUser = a;
      await navigate('/configuration'); await text('Background animation');
      assert.equal(await evaluate('document.documentElement.dataset.wallpaperStyle'), 'waves');
      assert.equal(await evaluate('document.documentElement.dataset.wallpaper'), 'static');
    });
  }
  console.log('Appearance preferences: styles, validation, account isolation, migration and sign-in restore passed');
} finally {
  if (http) { http.closeAllConnections(); await new Promise((r) => http.close(r)); }
  db.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
