// Real React hooks with deliberately delayed API/socket transports to exercise navigation races.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { build } from 'esbuild';
import { runBrowser } from './browserHarness.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-ui-state-'));
const root = process.cwd();
let server;
try {
  const result = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ServerDetailProvider, useServerDetail} from './web/src/pages/server/ServerContext.tsx';
      import {useConsoleSocket} from './web/src/hooks/useConsoleSocket.ts';
      import {useEndpoint} from './web/src/hooks/useEndpoint.ts';
      const fixture=window.fixture={reads:[], sockets:[]};
      window.__read=path=>new Promise((resolve,reject)=>fixture.reads.push({path,resolve,reject}));
      class Socket { constructor(url){this.url=url;fixture.sockets.push(this)}close(){this.closed=true} }
      window.WebSocket=Socket;
      function View(){const d=useServerDetail(), c=useConsoleSocket(d.serverId), endpoint=useEndpoint(d.serverId,d.server?.server_port);
        fixture.refresh=d.refresh; fixture.state={id:d.serverId,server:d.server?.id??null,name:d.server?.name??null,permissions:d.permissions,canPower:d.can('power'),canConfig:d.canConfig('setting','name'),runtime:d.runtime,suspended:d.suspendedMessage,error:d.loadError,endpoint,c};
        return <pre id="state">{JSON.stringify(fixture.state)}</pre>}
      function App(){const[id,setId]=useState('a');fixture.navigate=setId;return <ServerDetailProvider serverId={id}><View/></ServerDetailProvider>}
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, plugins: [{ name: 'transport-fixtures', setup(plugin) {
      plugin.onResolve({ filter: /api\/client\.js$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      plugin.onResolve({ filter: /state\/AuthContext\.js$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: 'router', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'api' ? `export class ApiError extends Error { constructor(status,message){super(message);this.status=status} } export const api={get:path=>window.__read(path)}; export const wsUrl=path=>path; window.FixtureApiError=ApiError;` : args.path === 'auth' ? `export const useAuth=()=>({user:{id:'reviewer',role:'moderator'}});` : `export const useParams=()=>({});` }));
    } }] });
  await fs.writeFile(path.join(temp, 'fixture.js'), result.outputFiles[0].contents);
  await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
  const app = express(); app.use(express.static(temp)); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  await runBrowser(`http://127.0.0.1:${server.address().port}`, async ({ navigate, evaluate, until }) => {
    const state = () => evaluate('fixture.state');
    const respond = (index, value) => evaluate(`fixture.reads[${index}].resolve(${JSON.stringify(value)})`);
    const fail = (index, status, message) => evaluate(`fixture.reads[${index}].reject(new FixtureApiError(${status},${JSON.stringify(message)}))`);
    const details = (id, extra = {}) => ({ server: { id, name: `Instance ${id}`, server_port: 25565, suspended: 0 }, runtime: null, running: false, permissions: ['power','settings'], ...extra });
    const reads = () => evaluate('fixture.reads.map(r=>r.path)');
    const message = (socket, data) => evaluate(`fixture.sockets[${socket}].onmessage({data:${JSON.stringify(JSON.stringify(data))}})`);
    await navigate('/'); await until(() => evaluate('!!window.fixture'), 'fixture mounted'); await until(async () => (await reads()).length === 1, 'initial instance read');
    await respond(0, details('a'));
    await until(async () => (await reads()).includes('/servers/a/endpoint'), 'first endpoint read');
    await respond(1, { host: 'old-address', port: 25565 });
    await until(async () => (await state()).endpoint?.host === 'old-address', 'first endpoint');
    await evaluate('fixture.sockets[0].onopen()');
    await message(0, { type: 'hello', status: 'running', history: ['Instance A log'], runtime: { stats: { memoryMb: 777 } } });
    await message(0, { type: 'stats', memoryMb: 777 });
    await message(0, { type: 'install_progress', pct: 44, message: 'Installing A' });
    // A manual refresh deliberately remains pending while navigation loads B.
    await evaluate('fixture.previousRefresh=fixture.refresh;fixture.refresh();fixture.navigate("b")');
    await until(async () => (await reads()).includes('/servers/b'), 'B details request');
    const requests = await reads(), oldRefresh = requests.lastIndexOf('/servers/a'), newRead = requests.lastIndexOf('/servers/b');
    await evaluate('void fixture.previousRefresh()');
    assert.equal((await reads()).length, requests.length, 'Callbacks from a previous page cannot start old refreshes');
    await respond(newRead, details('b', { permissions: [] }));
    await until(async () => (await state()).server === 'b', 'B details');
    await evaluate('fixture.sockets[1].onopen()');
    await message(1, { type: 'hello', status: 'stopped', history: ['Instance B log'], runtime: null });
    await respond(oldRefresh, details('a', { runtime: { pid: 999 } }));
    await message(0, { type: 'log', stream: 'stdout', line: 'Late A log', at: Date.now() });
    await evaluate('fixture.sockets[0].onclose()');
    await until(async () => (await state()).c.lines[0]?.line === 'Instance B log', 'B console');
    const b = await state(); assert.equal(b.server, 'b'); assert.equal(b.canPower, false); assert.equal(b.c.connected, true); assert.equal(b.c.stats.memoryMb, null); assert.equal(b.c.statsHistory.length, 0); assert.equal(b.c.installProgress, null); assert.equal(b.endpoint, null);
    // Changing the port clears the old endpoint synchronously while the new read is delayed.
    const bEndpoint = (await reads()).lastIndexOf('/servers/b/endpoint'); await respond(bEndpoint, { host: 'b-address', port: 25565 });
    await until(async () => (await state()).endpoint?.host === 'b-address', 'B endpoint');
    await evaluate('void fixture.refresh()'); await until(async () => (await reads()).filter(r => r === '/servers/b').length >= 2, 'port refresh');
    await respond((await reads()).lastIndexOf('/servers/b'), { ...details('b'), server: { ...details('b').server, server_port: 25566 } });
    await until(async () => (await reads()).filter(r => r === '/servers/b/endpoint').length === 2, 'new port endpoint request');
    assert.equal((await state()).endpoint, null, 'Old copyable endpoint disappears while new port resolves');
    await respond((await reads()).lastIndexOf('/servers/b/endpoint'), { host: 'b-new-address', port: 25566 });
    // Last explicit refresh wins; delayed older data must never restore old permissions.
    await evaluate('fixture.refresh();void fixture.refresh()');
    const indices = (await reads()).map((p, i) => p === '/servers/b' ? i : -1).filter(i => i >= 0); const newer = indices.at(-1), older = indices.at(-2);
    await respond(newer, details('b', { permissions: [] })); await respond(older, details('b'));
    await until(async () => (await state()).permissions.length === 0, 'newest grants retained');
    assert.equal((await state()).canConfig, false);
    // Broken frames are ignored, and reconnect history replaces pending disconnected output.
    await evaluate('fixture.sockets[1].onmessage({data:"not-json"})');
    await message(1, { type: 'log', stream: 'stdout', line: 'Before reconnect', at: Date.now() }); await evaluate('fixture.sockets[1].onclose()');
    await until(() => evaluate('fixture.sockets.length===3'), 'reconnect socket');
    await evaluate('fixture.sockets[2].onopen()'); await message(2, { type: 'hello', status: 'stopped', history: ['Before reconnect'], runtime: null });
    await until(async () => (await state()).c.lines.length === 1, 'authoritative reconnect history');
    assert.equal((await state()).c.lines[0].line, 'Before reconnect');
    await evaluate('void fixture.refresh()'); const denied = (await reads()).lastIndexOf('/servers/b'); await fail(denied, 403, 'Access revoked');
    await until(async () => (await state()).server === null, 'revoked details cleared');
    const revoked = await state(); assert.equal(revoked.canPower, false); assert.equal(revoked.canConfig, false); assert.equal(revoked.error, 'Access revoked'); assert.equal(revoked.endpoint, null);
  });
  console.log('UI state: delayed instance/permission responses, endpoint changes, socket isolation, reconnect history, malformed frames and revoked access passed.');
} finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await fs.rm(temp, { recursive: true, force: true }); }
