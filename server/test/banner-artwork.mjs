// npm run build --workspace=server && node server/test/banner-artwork.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { PNG } from 'pngjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-banners-'));
process.env.OUTPOST_DATA_DIR = temp;
const { db } = await import('../dist/db/db.js');
const banners = await import('../dist/services/bannerService.js');
const { instanceDir } = await import('../dist/utils/paths.js');
const { getServer, listServers } = await import('../dist/services/serverService.js');
const { bannerRouter } = await import('../dist/routes/banner.routes.js');
const users = await import('../dist/services/userService.js');
const { createToken } = await import('../dist/auth/tokens.js');
let http;
try {
  for (const id of ['first', 'second']) {
    db.prepare('INSERT INTO servers (id,name,platform,loader,version,status) VALUES (?,?,?,?,?,?)').run(id, id, 'custom', 'vanilla', 'latest', 'stopped');
    fs.mkdirSync(instanceDir(id), { recursive: true });
  }
  const png = new PNG({ width: 120, height: 30 }); png.data.fill(180);
  const bytes = PNG.sync.write(png);
  assert.deepEqual(banners.bannerImageInfo(bytes), { mime: 'image/png', width: 120, height: 30 });
  for (const invalid of [Buffer.from('<svg/>'), Buffer.from('not an image'), bytes.subarray(0, 40), Buffer.alloc(8 * 1048576 + 1)]) assert.throws(() => banners.bannerImageInfo(invalid), { status: 400 });
  const admin = users.createUser('banner-admin', 'test-password-123', 'admin');
  const viewer = users.createUser('banner-viewer', 'test-password-123', 'viewer');
  const outsider = users.createUser('banner-outsider', 'test-password-123', 'viewer');
  db.prepare('INSERT INTO user_server_access (user_id,server_id,permissions) VALUES (?,?,?)').run(viewer.id, 'first', '[]');
  const app = express(); app.use(express.json()); app.use('/api/servers/:serverId/banner', bannerRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${http.address().port}/api/servers/first/banner`;
  const request = (user, method = 'GET', body, suffix = '') => fetch(origin + suffix, { method, headers: { ...(user ? { Authorization: `Bearer ${createToken(user.id, user.username, user.role)}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const upload = () => { const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'banner.png'); return form; };
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(outsider)).status, 403);
  assert.equal((await request(viewer, 'POST', upload())).status, 403);
  const uploaded = await request(admin, 'POST', upload()); assert.equal(uploaded.status, 200);
  const { banner } = await uploaded.json();
  assert.deepEqual(getServer('first').banner, banner);
  assert.deepEqual(listServers().find(s => s.id === 'first').banner, banner);
  assert.equal(getServer('second').banner, null);
  const image = await request(viewer, 'GET', undefined, `?v=${banner.version}`);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await request(viewer, 'PATCH', { version: banner.version, positionX: 20, positionY: 80 })).status, 403);
  assert.equal((await request(admin, 'PATCH', { version: 'stale', positionX: 20, positionY: 80 })).status, 409);
  assert.equal((await request(admin, 'PATCH', { version: banner.version, positionX: -1, positionY: 80 })).status, 400);
  assert.equal((await request(admin, 'PATCH', { version: banner.version, positionX: 20, positionY: 80 })).status, 200);
  assert.equal(banners.readBannerArtwork('first').positionY, 80);
  fs.cpSync(path.join(instanceDir('first'), '.outpost'), path.join(instanceDir('second'), '.outpost'), { recursive: true });
  assert.equal(banners.readBannerArtwork('second').positionX, 20, 'artwork travels with instance files');
  const replacement = banners.saveBannerArtwork('first', bytes);
  assert.equal(fs.existsSync(path.join(instanceDir('first'), '.outpost', `banner-${banner.version}.img`)), false);
  assert.equal((await request(admin, 'GET', undefined, `?v=${banner.version}`)).status, 404);
  assert.equal((await request(viewer, 'DELETE', { version: replacement.version })).status, 403);
  assert.equal((await request(admin, 'DELETE', { version: banner.version })).status, 409);
  assert.equal((await request(admin, 'DELETE', { version: replacement.version })).status, 200);
  assert.equal(getServer('first').banner, null);
  assert.equal((await request(admin)).status, 404);
  fs.unlinkSync(banners.bannerFile('second').file);
  assert.equal(getServer('second').banner, null, 'missing artwork falls back gracefully');
  console.log('Banner artwork: validation, upload, access, crop, replacement, copy and reset passed');
} finally {
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
}
