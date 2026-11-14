import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
export async function runBrowser(origin, test, options = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-panel-browser-'));
  const candidates = process.env.OUTPOST_TEST_BROWSER ? [process.env.OUTPOST_TEST_BROWSER] : process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  let binary;
  for (const candidate of candidates) { try { await fs.access(candidate); binary = candidate; break; } catch {} }
  if (!binary) { await fs.rm(profile, { recursive: true, force: true }); throw new Error('Chromium/Chrome was not found. Set OUTPOST_TEST_BROWSER to its executable. Browser checks are required and will not be skipped.'); }
  const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...(process.env.OUTPOST_TEST_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  browser.on('error', error => { spawnError = error; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, description, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(100); } throw new Error(`Timed out: ${description}`); }
  let socket, evaluate, cdp; const pending = new Map(), exceptions = []; let serial = 0;
  try {
    let port; await until(async () => { if (spawnError) throw spawnError; try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'browser startup');
    let target; await until(async () => { const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = targets.find(t => t.type === 'page'); return !!target?.webSocketDebuggerUrl; }, 'browser page target');
    socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
    socket.on('message', bytes => { const data = JSON.parse(bytes); if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text); if (data.id) { const request = pending.get(data.id); if (!request) return; pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); } });
    const rejectPending = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser debugger disconnected')); } pending.clear(); };
    socket.on('close', rejectPending);
    cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, options.commandTimeoutMs ?? 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    const navigate = async route => { await cdp('Page.navigate', { url: origin + route }); };
    const text = label => until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(label)})`), `text: ${label}`);
    const click = label => evaluate(`[...document.querySelectorAll('button,a')].find(e => e.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('outpost_token', 'browser-fixture')" });
    const emulateReducedMotion = reduced => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
    const captureScreenshot = async file => fs.writeFile(file, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const viewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    const pressKey = async (key, code = key, modifiers = 0) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }); };
    const network = async ({ offline = false, latencyMs = 0, downloadBytesPerSecond = -1, uploadBytesPerSecond = -1 } = {}) => { await cdp('Network.enable'); await cdp('Network.emulateNetworkConditions', { offline, latency: latencyMs, downloadThroughput: downloadBytesPerSecond, uploadThroughput: uploadBytesPerSecond }); };
    const browserVersion = (await cdp('Browser.getVersion')).product;
    await options.onBrowserVersion?.(browserVersion);
    await test({ evaluate, navigate, text, click, until, emulateReducedMotion, captureScreenshot, viewport, pressKey, network, browserVersion });
    assert.deepEqual(exceptions, []);
  } catch (error) {
    let page; try { page = await evaluate?.('document.body?.innerText'); } catch {}
    if (options.artifactDirectory) { await fs.mkdir(options.artifactDirectory, { recursive: true }); await fs.writeFile(path.join(options.artifactDirectory, 'browser-failure.json'), JSON.stringify({ error: String(error), page, exceptions }, null, 2)); try { const shot=await cdp?.('Page.captureScreenshot',{format:'png'}); if(shot) await fs.writeFile(path.join(options.artifactDirectory,'browser-failure.png'),Buffer.from(shot.data,'base64')); } catch {} }
    console.error({ page, exceptions }); throw error;
  }
  finally { socket?.close(); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser test ended')); } pending.clear(); browser.kill(); await delay(500); await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
