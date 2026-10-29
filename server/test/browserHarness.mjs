import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
export async function runBrowser(origin, test) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-panel-browser-'));
  const binary = process.env.OUTPOST_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(100); } throw new Error(`Timed out: ${description}`); }
  let socket, evaluate; const pending = new Map(), exceptions = []; let serial = 0;
  try {
    let port; await until(async () => { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'browser startup');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await once(socket, 'open');
    socket.on('message', bytes => { const data = JSON.parse(bytes); if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text); if (data.id) { const request = pending.get(data.id); pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); } });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    const navigate = async route => { await cdp('Page.navigate', { url: origin + route }); };
    const text = label => until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(label)})`), `text: ${label}`);
    const click = label => evaluate(`[...document.querySelectorAll('button,a')].find(e => e.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('outpost_token', 'browser-fixture')" });
    await test({ evaluate, navigate, text, click, until });
    assert.deepEqual(exceptions, []);
  } catch (error) { console.error({ page: await evaluate?.('document.body?.innerText'), exceptions }); throw error; }
  finally { socket?.close(); browser.kill(); await delay(500); await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
