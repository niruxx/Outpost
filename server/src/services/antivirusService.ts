import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import cron, { type ScheduledTask } from 'node-cron';
import { prep } from '../db/db.js';
import { DATA_DIR, instanceDir, safeJoinReal } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getSetting, setSetting } from './systemSettingsService.js';
import { getServer, listServers } from './serverService.js';
import { beginJob, finishJob, progressJob } from './jobService.js';
import { recordEvent } from './eventLogService.js';

export interface AntivirusConfig { enabled: boolean; executable: string; updater: string; database: string; stopOnDetection: boolean; realtime: boolean }
const DEFAULT: AntivirusConfig = { enabled: false, executable: 'clamscan', updater: 'freshclam', database: '', stopOnDetection: false, realtime: false };
export function antivirusConfig(): AntivirusConfig { try { return { ...DEFAULT, ...JSON.parse(getSetting('antivirus') ?? '{}') }; } catch { return { ...DEFAULT }; } }
export const protectionEnabled = () => antivirusConfig().enabled;
export function validateAntivirusConfig(input: unknown): AntivirusConfig {
  const v = input as AntivirusConfig;
  if (!v || typeof v.enabled !== 'boolean' || typeof v.stopOnDetection !== 'boolean') throw new HttpError(400, 'Choose upload protection and detection response');
  for (const key of ['executable', 'updater', 'database'] as const) if (typeof v[key] !== 'string' || v[key].length > 1024 || /[\r\n\0]/.test(v[key])) throw new HttpError(400, `Invalid ${key}`);
  if ((v.executable !== 'clamscan' && !path.isAbsolute(v.executable)) || (v.updater !== 'freshclam' && !path.isAbsolute(v.updater)) || (v.database && !path.isAbsolute(v.database))) throw new HttpError(400, 'Use default command names or absolute paths, without arguments');
  if (v.realtime !== undefined && typeof v.realtime !== 'boolean') throw new HttpError(400, 'Live monitoring must be boolean');
  if (v.realtime && !v.enabled) throw new HttpError(400, 'Enable upload protection before enabling live mod monitoring');
  return { enabled: v.enabled, executable: v.executable.trim(), updater: v.updater.trim(), database: v.database.trim(), stopOnDetection: v.stopOnDetection, realtime: v.realtime ?? false };
}
const privateRoot = () => { const dir = path.join(DATA_DIR, 'antivirus'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink()) throw new HttpError(503, 'Antivirus storage cannot be a symbolic link'); fs.chmodSync(dir, 0o700); return fs.realpathSync(dir); };
export function stageFile(buffer: Buffer) {
  const dir = fs.mkdtempSync(path.join(privateRoot(), 'incoming-')); fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'payload'); fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' }); return { dir, file };
}
export function discardStage(dir: string) {
  const root = privateRoot(), resolved = path.resolve(dir);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('incoming-')) throw new Error('Invalid antivirus staging directory');
  fs.rmSync(resolved, { recursive: true, force: true });
}
interface CommandResult { code: number | null; output: string }
function command(executable: string, args: string[], timeout: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Scan cancelled'));
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure: Error | null = null;
    const stop = (why: string) => { failure = new Error(why); child.kill('SIGKILL'); };
    const abort = () => stop('Scan cancelled'); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Scanner timed out; result is incomplete'), timeout);
    const read = (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1048576) { stop('Scanner output limit exceeded; result is incomplete'); return; } output += data.toString(); };
    child.stdout!.on('data', read); child.stderr!.on('data', read);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', err => { cleanup(); reject(new Error(`Cannot run scanner: ${err.message}`)); });
    child.once('close', code => { cleanup(); failure ? reject(failure) : resolve({ code, output }); });
  });
}
export function scanVerdict(result: CommandResult) {
  const findings = result.output.split(/\r?\n/).filter(l => / FOUND\s*$/.test(l)).map(l => l.slice(0, 1000));
  if (findings.length) return { status: 'detected' as const, findings, incomplete: result.code !== 1 || /\b(?:ERROR|WARNING):|\bERROR\s*$/im.test(result.output) };
  if (result.code !== 0 || /\b(?:ERROR|WARNING):|\bERROR\s*$/im.test(result.output) || findings.length) throw new HttpError(503, `Scan could not confirm safety: ${result.output.slice(-1500) || `exit ${result.code}`}`);
  return { status: 'clean' as const, findings: [] as string[], incomplete: false };
}
function scanArgs(config: AntivirusConfig, target: string, recursive: boolean) {
  return ['--stdout', '--no-summary', '--infected', `--tempdir=${privateRoot()}`, '--scan-archive=yes', '--alert-encrypted=yes', '--alert-exceeds-max=yes', '--fail-if-cvd-older-than=7', '--max-filesize=1024M', '--max-scansize=2048M', '--max-recursion=30', '--max-files=10000', '--follow-dir-symlinks=0', '--follow-file-symlinks=0', ...(config.database ? [`--database=${config.database}`] : []), ...(recursive ? ['--recursive'] : []), target];
}
let pending = 0, tail = Promise.resolve();
async function queued<T>(fn: () => Promise<T>): Promise<T> {
  if (pending >= 8) throw new HttpError(503, 'Antivirus queue is full; retry later');
  pending++; const before = tail; let release!: () => void; tail = new Promise<void>(r => { release = r; });
  try { await before; return await fn(); } finally { pending--; release(); }
}
export async function antivirusHealth(config = antivirusConfig()) {
  return queued(async () => {
    try {
      const version = await command(config.executable, ['--version'], 15000);
      if (version.code !== 0 || !/ClamAV/i.test(version.output)) throw new Error('ClamAV executable not available');
      const stage = stageFile(Buffer.from('Outpost scanner readiness check\n'));
      try { const result = scanVerdict(await command(config.executable, scanArgs(config, stage.file, false), 120000)); if (result.status !== 'clean') throw new Error('Readiness probe was not clean'); }
      finally { discardStage(stage.dir); }
      return { ready: true, version: version.output.trim().slice(0, 500), error: null, pending };
    } catch (err) { return { ready: false, version: null, error: err instanceof Error ? err.message : 'Scanner unavailable', pending }; }
  });
}
export async function saveAntivirusConfig(input: unknown) {
  const config = validateAntivirusConfig(input), previous = antivirusConfig();
  const needsCheck = config.enabled && (!previous.enabled || (config.realtime && !previous.realtime) || ['executable', 'updater', 'database'].some(k => config[k as keyof AntivirusConfig] !== previous[k as keyof AntivirusConfig]));
  if (needsCheck) { const health = await antivirusHealth(config); if (!health.ready) throw new HttpError(503, health.error!); }
  setSetting('antivirus', JSON.stringify(config)); configureRealtime(); return config;
}
function retainBlocked(buffer: Buffer, name: string, serverId: string | null, signature: string) {
  const id = crypto.randomUUID(), root = privateRoot();
  const total = (prep('SELECT COALESCE(SUM(bytes),0) AS bytes FROM antivirus_quarantine WHERE retained=1').get() as { bytes: number }).bytes;
  const retained = total + buffer.length <= 2 * 1024 ** 3;
  if (retained) fs.writeFileSync(path.join(root, `${id}.bin`), buffer, { mode: 0o600, flag: 'wx' });
  prep('INSERT INTO antivirus_quarantine(id,server_id,name,signature,sha256,bytes,retained,at) VALUES (?,?,?,?,?,?,?,?)').run(id, serverId, path.basename(name.replace(/\\/g, '/')).slice(0, 255), signature.slice(0, 1000), crypto.createHash('sha256').update(buffer).digest('hex'), buffer.length, retained ? 1 : 0, Date.now());
  return id;
}
export async function scanUploadBuffers(files: { buffer: Buffer; name: string }[], serverId: string | null = null) {
  if (!protectionEnabled() || !files.length) return;
  await queued(async () => {
    const config = antivirusConfig();
    // Never release an earlier file in a multipart batch before the entire batch passes.
    for (const file of files) {
      const stage = stageFile(file.buffer);
      try {
        const result = scanVerdict(await command(config.executable, scanArgs(config, stage.file, false), 600000));
        if (result.status === 'detected') {
          const signature = result.findings.map(f => f.replace(stage.file + ': ', '')).join('; ');
          const id = retainBlocked(file.buffer, file.name, serverId, signature);
          recordEvent('security.upload.blocked', serverId ? { id: serverId, name: getServer(serverId)?.name ?? serverId } : null, `Blocked upload ${file.name.slice(0, 200)}: ${signature.slice(0, 500)}`);
          throw new HttpError(422, `Upload blocked by antivirus: ${file.name.slice(0, 100)} — ${signature.slice(0, 200)} (report ${id})`);
        }
      } finally { discardStage(stage.dir); }
    }
  });
}
export async function scanIngestedPath(target: string, recursive = false) {
  if (!protectionEnabled()) return;
  await queued(async () => { const config = antivirusConfig(); const result = scanVerdict(await command(config.executable, scanArgs(config, target, recursive), 1800000)); if (result.status !== 'clean') throw new HttpError(422, 'Antivirus blocked imported content: ' + result.findings.slice(0, 5).map(f => f.replace(target, 'import')).join('; ')); });
}
export async function downloadScannedMod(url: string, target: string, serverId: string | null = null) {
  const { downloadFile } = await import('../utils/download.js');
  if (!protectionEnabled()) return downloadFile(url, target);
  const stage = stageFile(Buffer.alloc(0));
  const temp = `${target}.av-${crypto.randomUUID()}.tmp`;
  try {
    await downloadFile(url, stage.file);
    if (fs.statSync(stage.file).size > 1024 ** 3) throw new HttpError(413, 'Protected mod download exceeds 1 GiB');
    await scanUploadBuffers([{ name: path.basename(target), buffer: fs.readFileSync(stage.file) }], serverId);
    await fs.promises.copyFile(stage.file, temp, fs.constants.COPYFILE_EXCL); fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); discardStage(stage.dir); }
}
export const antivirusQueue = () => pending;
export function quarantineRows() { return prep('SELECT * FROM antivirus_quarantine ORDER BY at DESC LIMIT 200').all(); }
export function deleteQuarantine(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid quarantine ID');
  const file = path.join(privateRoot(), `${id}.bin`); if (fs.existsSync(file)) fs.unlinkSync(file);
  prep('DELETE FROM antivirus_quarantine WHERE id=?').run(id);
}
export const scanRows = (serverId?: string) => (serverId ? prep('SELECT * FROM antivirus_scans WHERE server_id=? ORDER BY started_at DESC LIMIT 100').all(serverId) : prep('SELECT * FROM antivirus_scans ORDER BY started_at DESC LIMIT 200').all()).map(r => ({ ...r, report: JSON.parse(r.report as string) }));
export const securityHold = (serverId: string) => !!prep('SELECT 1 FROM antivirus_holds WHERE server_id=?').get(serverId);
export function assertNoSecurityHold(serverId: string) { if (securityHold(serverId)) throw new HttpError(423, 'Antivirus security hold: resolve findings and complete a clean instance scan before starting'); }
const active = new Map<string, AbortController>();
export function startInstanceScan(serverId: string, source = 'manual') {
  const server = getServer(serverId); if (!server) throw new HttpError(404, 'Instance not found');
  if (active.has(serverId)) throw new HttpError(409, 'An instance scan is already queued or running');
  if (pending >= 8) throw new HttpError(503, 'Antivirus queue is full');
  const id = crypto.randomUUID(), controller = new AbortController(); active.set(serverId, controller);
  prep('INSERT INTO antivirus_scans(id,server_id,source,status,started_at) VALUES (?,?,?,?,?)').run(id, serverId, source, 'queued', Date.now());
  const job = beginJob('antivirus', serverId, 'Queued for malware scan');
  void queued(async () => {
    if (controller.signal.aborted) throw new Error('Scan cancelled');
    const root = instanceDir(serverId); if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink() || safeJoinReal(root, '') !== fs.realpathSync(root)) throw new Error('Instance scan root is unavailable or unsafe');
    prep("UPDATE antivirus_scans SET status='running' WHERE id=?").run(id); progressJob(job, 'Scanning instance files and supported archives', null);
    const result = scanVerdict(await command(antivirusConfig().executable, scanArgs(antivirusConfig(), root, true), 1800000, controller.signal));
    const report = { findings: result.findings.map(f => f.replaceAll(root + path.sep, '').replaceAll(root + '/', '')), note: (result.incomplete ? 'Scanner also reported an incomplete scan. ' : '') + 'Non-destructive live filesystem scan. Symlinks are not followed. Files changing during scanning are not a consistent snapshot.' };
    prep('UPDATE antivirus_scans SET status=?,report=?,finished_at=? WHERE id=?').run(result.status, JSON.stringify(report), Date.now(), id);
    if (result.status === 'detected') {
      prep('INSERT INTO antivirus_holds(server_id,scan_id,at) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET scan_id=excluded.scan_id,at=excluded.at').run(serverId, id, Date.now());
      recordEvent('security.scan.detected', { id: serverId, name: server.name }, `Malware or unscannable-content alert: ${report.findings.slice(0, 5).join('; ').slice(0, 1000)}. New starts blocked until a clean scan.`);
      if (antivirusConfig().stopOnDetection) { try { const { isRunning, stopServer } = await import('./processManager.js'); if (isRunning(serverId)) stopServer(serverId); } catch (err) { recordEvent('security.scan.failed', { id: serverId, name: server.name }, `Findings remain on security hold; stop request failed: ${err instanceof Error ? err.message : 'unknown error'}`); } }
      finishJob(job, new Error('Antivirus findings require review'));
    } else { prep('DELETE FROM antivirus_holds WHERE server_id=?').run(serverId); finishJob(job); }
  }).catch(err => {
    prep('UPDATE antivirus_scans SET status=?,report=?,finished_at=? WHERE id=?').run(controller.signal.aborted ? 'cancelled' : 'error', JSON.stringify({ error: err instanceof Error ? err.message : 'Scan failed' }), Date.now(), id);
    finishJob(job, err); recordEvent('security.scan.failed', { id: serverId, name: server.name }, err instanceof Error ? err.message : 'Scan failed');
  }).finally(() => active.delete(serverId));
  return { id };
}
export function cancelInstanceScan(serverId: string) { active.get(serverId)?.abort(); }
const schedules = new Map<string, ScheduledTask>();
export function antivirusSchedules() { return prep('SELECT * FROM antivirus_schedules').all() as unknown as { server_id: string; expression: string; enabled: number }[]; }
function register(serverId: string, expression: string, enabled: boolean) {
  schedules.get(serverId)?.stop(); schedules.delete(serverId);
  if (enabled) schedules.set(serverId, cron.schedule(expression, () => { try { startInstanceScan(serverId, 'scheduled'); } catch (err) { recordEvent('security.scan.failed', { id: serverId, name: getServer(serverId)?.name ?? serverId }, err instanceof Error ? err.message : 'Scheduled scan failed'); } }));
}
export function saveAntivirusSchedule(serverId: string, expression: unknown, enabled: unknown) {
  if (!getServer(serverId)) throw new HttpError(404, 'Instance not found');
  if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5 || !cron.validate(expression) || typeof enabled !== 'boolean') throw new HttpError(400, 'Use a valid five-field cron expression and enabled flag');
  prep('INSERT INTO antivirus_schedules(server_id,expression,enabled) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET expression=excluded.expression,enabled=excluded.enabled').run(serverId, expression, enabled ? 1 : 0);
  register(serverId, expression, enabled);
}
let updating = false;
export async function updateAntivirusSignatures() {
  if (updating) throw new HttpError(409, 'Signature update already running'); updating = true;
  try { const config = antivirusConfig(); const result = await command(config.updater, [...(config.database ? [`--datadir=${config.database}`] : [])], 600000); if (result.code !== 0) throw new HttpError(503, result.output.slice(-2000) || 'Signature update failed'); return { output: result.output.slice(-2000) }; } finally { updating = false; }
}
export function initAntivirus() {
  const root = privateRoot(); for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('incoming-')) discardStage(path.join(root, entry.name));
  prep("UPDATE antivirus_scans SET status='interrupted',finished_at=? WHERE status IN ('queued','running')").run(Date.now());
  for (const s of antivirusSchedules()) register(s.server_id, s.expression, !!s.enabled);
  configureRealtime();
}
export function stopAntivirus() { stopRealtime(); for (const controller of active.values()) controller.abort(); for (const schedule of schedules.values()) schedule.stop(); schedules.clear(); }

// The upload gate prevents publication. This separate monitor detects changes made outside
// that gate; it intentionally does not claim kernel-level on-access prevention.
const MOD_ROOTS = ['mods', 'plugins', 'addons', 'BepInEx', 'kubejs', 'scripts', 'datapacks', 'behavior_packs', 'resource_packs', 'world/datapacks', 'tf/addons', 'tf/custom', 'game/csgo/addons', 'csgo/addons', 'garrysmod/addons', 'Pal/Content/Paks', 'Pal/Binaries/Win64/Mods', 'Pal/Binaries/Win64/ue4ss/Mods', 'ConanSandbox/Mods', 'ShooterGame/Content/Mods', 'SquadGame/Plugins/Mods', 'steamapps/workshop/content'];
interface ModFile { serverId: string; relative: string; file: string; fingerprint: string; size: number }
const observed = new Map<string, { fingerprint: string; stableSince: number; handled: boolean }>();
const watchers = new Map<string, fs.FSWatcher>();
let liveTimer: ReturnType<typeof setInterval> | null = null, liveDebounce: ReturnType<typeof setTimeout> | null = null;
let liveGeneration = 0, liveBusy = false, liveAbort: AbortController | null = null, liveRetryAt = 0;
let liveState = { enabled: false, trackedFiles: 0, watchedDirectories: 0, scanning: false, lastScanAt: null as number | null, error: null as string | null };
export const realtimeAntivirusStatus = () => ({ ...liveState });
function stopRealtime() {
  liveGeneration++; liveAbort?.abort();
  if (liveTimer) clearInterval(liveTimer); if (liveDebounce) clearTimeout(liveDebounce);
  liveTimer = null; liveDebounce = null; for (const watcher of watchers.values()) watcher.close(); watchers.clear(); observed.clear();
  liveState = { ...liveState, enabled: false, scanning: false, trackedFiles: 0, watchedDirectories: 0 };
}
function nudgeRealtime() { if (!liveState.enabled || liveDebounce) return; liveDebounce = setTimeout(() => { liveDebounce = null; void reconcileRealtime(); }, 1500); liveDebounce.unref(); }
function configureRealtime() {
  stopRealtime(); liveRetryAt = 0;
  if (!antivirusConfig().enabled || !antivirusConfig().realtime) return;
  liveState = { ...liveState, enabled: true, error: null, lastScanAt: null };
  liveTimer = setInterval(() => void reconcileRealtime(), 5000); liveTimer.unref(); void reconcileRealtime();
}
function fingerprint(stat: fs.Stats) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function regularPath(root: string, relative: string) {
  const file = safeJoinReal(root, relative); let cursor = root;
  for (const part of relative.split(/[\\/]/).filter(Boolean)) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink excluded from live monitoring'); }
  return file;
}
async function modInventory(generation: number) {
  const files: ModFile[] = [], directories = new Set<string>(); let entries = 0;
  const { getAddonSupport } = await import('./pluginService.js');
  for (const server of listServers()) {
    if (generation !== liveGeneration) break;
    const root = instanceDir(server.id); if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
    directories.add(root); const support = getAddonSupport(server);
    const candidates = [...new Set([...MOD_ROOTS, ...(support.supported ? [support.profile.folder] : [])])];
    const visited = new Set<string>();
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (generation !== liveGeneration) return;
      if (depth > 30 || ++entries > 30000) throw new Error('Live mod inventory limit exceeded; run a full scan and reduce monitored content');
      let dir: string; try { dir = regularPath(root, relative); if (!fs.lstatSync(dir).isDirectory()) return; } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT' || /symlink/i.test((err as Error).message)) return; throw err; }
      if (visited.has(dir)) return; visited.add(dir);
      let list: fs.Dirent[]; try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
      directories.add(dir);
      for (const entry of list) {
        if (entry.isSymbolicLink()) continue;
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel, depth + 1);
        else if (entry.isFile()) {
          if (++entries > 30000) throw new Error('Live mod inventory limit exceeded');
          let file: string, stat: fs.Stats; try { file = regularPath(root, rel); stat = await fs.promises.stat(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
          files.push({ serverId: server.id, relative: rel, file, fingerprint: fingerprint(stat), size: stat.size });
        }
      }
    };
    for (const relative of candidates) { try { if (fs.existsSync(safeJoinReal(root, relative))) await walk(relative, 0); } catch (err) { if ((err as Error).message.includes('Symlink')) continue; throw err; } }
  }
  return { files, directories };
}
async function scanLiveBatch(serverId: string, files: ModFile[], generation: number) {
  const server = getServer(serverId); if (!server) return;
  const stage = stageFile(Buffer.alloc(0)); fs.unlinkSync(stage.file);
  const snapshots: { file: ModFile; name: string }[] = [];
  const id = crypto.randomUUID(), controller = new AbortController(); liveAbort = controller;
  prep('INSERT INTO antivirus_scans(id,server_id,source,status,started_at) VALUES (?,?,?,?,?)').run(id, serverId, 'realtime', 'queued', Date.now());
  const job = beginJob('antivirus', serverId, 'Queued live mod scan');
  try {
    for (const file of files) {
      if (generation !== liveGeneration) throw new Error('Live monitoring stopped');
      let source: string, before: fs.Stats; try { source = regularPath(instanceDir(serverId), file.relative); before = fs.statSync(source); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      if (!before.isFile() || fingerprint(before) !== file.fingerprint) continue;
      if (before.size > 1024 ** 3) throw new Error(`Live mod scan cannot inspect files above 1 GiB: ${file.relative}`);
      if (snapshots.length && snapshots.reduce((sum, s) => sum + s.file.size, 0) + before.size > 128 * 1048576) break;
      const name = `mod-${snapshots.length}`;
      try { await fs.promises.copyFile(source, path.join(stage.dir, name), fs.constants.COPYFILE_EXCL); if (fingerprint(fs.statSync(source)) !== file.fingerprint) { fs.unlinkSync(path.join(stage.dir, name)); continue; } }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') { if (fs.existsSync(path.join(stage.dir, name))) fs.unlinkSync(path.join(stage.dir, name)); continue; } throw err; }
      snapshots.push({ file, name });
    }
    if (!snapshots.length) { prep("UPDATE antivirus_scans SET status='cancelled',finished_at=? WHERE id=?").run(Date.now(), id); finishJob(job, 'Files changed before scan; waiting for stable content'); return; }
    await queued(async () => {
      if (generation !== liveGeneration) throw new Error('Live monitoring stopped');
      prep("UPDATE antivirus_scans SET status='running' WHERE id=?").run(id); progressJob(job, `Scanning ${snapshots.length} new or changed mod files`, null);
      const config = antivirusConfig(); const result = scanVerdict(await command(config.executable, scanArgs(config, stage.dir, true), 600000, controller.signal));
      if (generation !== liveGeneration) throw new Error('Live monitoring stopped');
      const findings = result.findings.map(line => { for (const snapshot of snapshots) { const prefix = path.join(stage.dir, snapshot.name); if (line.startsWith(prefix + ':')) return snapshot.file.relative + line.slice(prefix.length); } return line.replaceAll(stage.dir, '[staged mod]'); });
      prep('UPDATE antivirus_scans SET status=?,report=?,finished_at=? WHERE id=?').run(result.status, JSON.stringify({ findings, files: snapshots.map(s => s.file.relative), note: 'Live mod-file detection after writes settle. Originals were not deleted. This scan does not clear an existing security hold.' }), Date.now(), id);
      if (result.status === 'detected') {
        prep('INSERT INTO antivirus_holds(server_id,scan_id,at) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET scan_id=excluded.scan_id,at=excluded.at').run(serverId, id, Date.now());
        recordEvent('security.scan.detected', { id: serverId, name: server.name }, `Live mod monitor: ${findings.slice(0, 5).join('; ').slice(0, 1000)}. New starts blocked.`);
        if (config.stopOnDetection) { try { const { isRunning, stopServer } = await import('./processManager.js'); if (isRunning(serverId)) stopServer(serverId); } catch (err) { recordEvent('security.scan.failed', { id: serverId, name: server.name }, `Live detection stop failed: ${err instanceof Error ? err.message : 'unknown error'}`); } }
        finishJob(job, 'Live mod scan detected suspicious content');
      } else finishJob(job);
      if (result.incomplete) { liveState.error = 'Live mod scan was incomplete; findings are on hold and unconfirmed files will be retried.'; liveRetryAt = Date.now() + 30000; }
      else for (const snapshot of snapshots) { const entry = observed.get(snapshot.file.file); if (entry?.fingerprint === snapshot.file.fingerprint) entry.handled = true; }
      liveState.lastScanAt = Date.now();
    });
  } catch (err) {
    prep('UPDATE antivirus_scans SET status=?,report=?,finished_at=? WHERE id=?').run(controller.signal.aborted ? 'cancelled' : 'error', JSON.stringify({ error: err instanceof Error ? err.message : 'Live scan failed' }), Date.now(), id); finishJob(job, err); throw err;
  } finally { discardStage(stage.dir); if (liveAbort === controller) liveAbort = null; }
}
export async function reconcileRealtime() {
  if (!liveState.enabled || liveBusy || Date.now() < liveRetryAt) return;
  const generation = liveGeneration; liveBusy = true; liveState.scanning = true;
  try {
    const { files, directories } = await modInventory(generation); if (generation !== liveGeneration) return;
    for (const [dir, watcher] of watchers) if (!directories.has(dir)) { watcher.close(); watchers.delete(dir); }
    let watcherError = false;
    for (const dir of directories) if (!watchers.has(dir) && watchers.size < 256) { try { const watcher = fs.watch(dir, { persistent: false }, nudgeRealtime); watcher.on('error', () => { watcher.close(); watchers.delete(dir); }); watchers.set(dir, watcher); } catch { watcherError = true; } }
    liveState.watchedDirectories = watchers.size; liveState.trackedFiles = files.length;
    const seen = new Set(files.map(f => f.file)); for (const key of observed.keys()) if (!seen.has(key)) observed.delete(key);
    const ready: ModFile[] = [];
    for (const file of files) { const old = observed.get(file.file); if (!old || old.fingerprint !== file.fingerprint) { observed.set(file.file, { fingerprint: file.fingerprint, stableSince: Date.now(), handled: false }); nudgeRealtime(); } else if (!old.handled && Date.now() - old.stableSince >= 1500) ready.push(file); }
    const batch = ready.slice(0, 16); if (batch.length) await scanLiveBatch(batch[0].serverId, batch.filter(f => f.serverId === batch[0].serverId), generation);
    if (generation !== liveGeneration) return;
    if (Date.now() >= liveRetryAt) liveState.error = watcherError || directories.size > 256 ? 'Some native watchers unavailable; five-second reconciliation remains active.' : null;
    if (ready.length > batch.length) nudgeRealtime();
  } catch (err) {
    if (generation === liveGeneration) { const message = err instanceof Error ? err.message : 'Live monitoring failed'; if (liveState.error !== message) recordEvent('security.scan.failed', null, message); liveState.error = message; liveRetryAt = Date.now() + 30000; }
  } finally { liveBusy = false; if (generation === liveGeneration) liveState.scanning = false; }
}
