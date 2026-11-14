import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { prep } from '../db/db.js';
import { instanceDir } from '../utils/paths.js';
import { HttpError } from '../utils/asyncHandler.js';
import { getServer } from './serverService.js';
import { isRunning } from './processManager.js';
import { isProxyLoader, type ServerRecord } from '../types/index.js';
import { worldDirs } from './rewindService.js';
import { createBackup } from './backupService.js';
import { readServerProperties } from './propertiesService.js';
import { beginJob, finishJob, progressJob } from './jobService.js';
import { scanUploadBuffers } from './antivirusService.js';
import { confinedFile, digest, readWorldBytes, type WorldFileCheck } from './worldHealthParsers.js';
import type { WorldRepair } from './worldHealth.worker.js';

interface Report { id: string; serverId: string; status: string; at: number; done: number; total: number; checks: WorldFileCheck[]; repairs: WorldRepair[]; error?: string; recoveryBackup?: string }
const active = new Map<string, { worker?: Worker; cancelled?: boolean; repair?: boolean }>();
export function worldHealthCapable(server: ServerRecord) { return (server.platform === 'java' && !isProxyLoader(server.loader)) || (server.platform === 'steam' && (server.steam_preset === 'terraria' || server.steam_app_id === '105600')); }
export function assertWorldHealthIdle(serverId: string) { if (active.has(serverId)) throw new HttpError(409, 'World Health is scanning or repairing this instance; wait before starting it'); }
function stopped(serverId: string) { const server = getServer(serverId); if (!server) throw new HttpError(404, 'Instance not found'); if (!worldHealthCapable(server)) throw new HttpError(400, 'World Health supports Minecraft Java and Terraria desktop worlds'); if (isRunning(serverId) || !['stopped', 'crashed', 'install_failed'].includes(server.status)) throw new HttpError(409, 'Stop the instance before checking or repairing world files'); return server; }
export function worldHealthReport(serverId: string): Report | null { const row = prep('SELECT report FROM world_health WHERE server_id=?').get(serverId) as { report: string } | undefined; return row ? JSON.parse(row.report) : null; }
function save(report: Report) { prep('INSERT INTO world_health(server_id,report) VALUES (?,?) ON CONFLICT(server_id) DO UPDATE SET report=excluded.report').run(report.serverId, JSON.stringify(report)); }
async function inventory(server: ServerRecord) {
  const root = instanceDir(server.id), inputs: { file: string; kind: WorldFileCheck['kind'] }[] = []; let visited = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 12 || ++visited > 20000) throw new HttpError(413, 'World discovery limit reached; inspect a smaller instance offline');
    const dir = confinedFile(root, relative); if (!fs.existsSync(dir)) return;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (++visited > 20000) throw new HttpError(413, 'World discovery limit reached');
      if (entry.isSymbolicLink()) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (server.platform === 'java' && ['playerdata', 'stats', 'advancements', 'datapacks'].includes(entry.name)) continue; await walk(file, depth + 1); }
      else if (server.platform === 'java' && /^r\.-?\d+\.-?\d+\.mca$/.test(entry.name) && ['region', 'entities', 'poi'].includes(path.posix.basename(relative))) inputs.push({ file, kind: 'region' });
      else if (server.platform !== 'java' && /\.wld$/i.test(entry.name)) inputs.push({ file, kind: 'terraria' });
      else if (server.platform !== 'java' && /\.wld\.bak$/i.test(entry.name) && !fs.existsSync(confinedFile(root, file.slice(0, -4)))) inputs.push({ file: file.slice(0, -4), kind: 'terraria' });
      if (inputs.length > 2000) throw new HttpError(413, 'This scan supports at most 2,000 world files');
    }
  };
  if (server.platform === 'java') { const level = readServerProperties(server.id, server.platform).find(p => p.key === 'level-name')?.value.trim() || 'world'; for (const world of worldDirs(server)) { confinedFile(root, world); if (fs.existsSync(confinedFile(root, `${world}/level.dat`)) || world === level) inputs.push({ file: `${world}/level.dat`, kind: 'level' }); await walk(world, 0); } }
  else await walk('worlds', 0);
  return inputs;
}
export function startWorldHealth(serverId: string) {
  const server = stopped(serverId); assertWorldHealthIdle(serverId);
  if (active.size >= 2) throw new HttpError(429, 'Two World Health tasks are already active');
  const entry: { worker?: Worker; cancelled?: boolean } = {}; active.set(serverId, entry);
  const report: Report = { id: crypto.randomUUID(), serverId, at: Date.now(), status: 'scanning', done: 0, total: 0, checks: [], repairs: [] }; save(report);
  const job = beginJob('world-health', serverId, 'Discovering world files');
  void (async () => {
    const inputs = await inventory(server); report.total = inputs.length;
    if (entry.cancelled) throw new Error('World check cancelled');
    if (!inputs.length) throw new Error('No supported world files found in the configured Minecraft world folders or Terraria worlds/');
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./worldHealth.worker.js', import.meta.url), { workerData: { root: instanceDir(serverId), inputs }, resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 } }); entry.worker = worker;
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('World check exceeded its ten-minute limit; no files were changed')); }, 600000);
      let result = false;
      worker.on('message', message => {
        if (message.type === 'progress') { report.done = message.done; save(report); progressJob(job, `Checking world files (${message.done}/${message.total})`, 100 * message.done / message.total); }
        if (message.type === 'result') { result = true; report.checks = message.checks; report.repairs = message.repairs; report.status = 'complete'; clearTimeout(timer); resolve(); }
      });
      worker.once('error', err => { clearTimeout(timer); reject(err); }); worker.once('exit', () => { clearTimeout(timer); if (!result) reject(new Error(entry.cancelled ? 'World check cancelled' : 'World checker stopped before returning a complete report')); });
    });
    save(report); finishJob(job);
  })().catch(err => { report.status = entry.cancelled ? 'cancelled' : 'error'; report.error = err instanceof Error ? err.message : 'World check failed'; report.repairs = []; save(report); finishJob(job, err); }).finally(() => active.delete(serverId));
  return report;
}
export function cancelWorldHealth(serverId: string) { const entry = active.get(serverId); if (!entry || entry.repair) return; entry.cancelled = true; void entry.worker?.terminate(); }
export async function repairWorldHealth(serverId: string, reportId: unknown, repairId: unknown) {
  stopped(serverId); assertWorldHealthIdle(serverId);
  const report = worldHealthReport(serverId); if (!report || report.id !== reportId || report.status !== 'complete') throw new HttpError(409, 'Run a fresh complete world check before repairing');
  const repair = report.repairs.find(r => r.id === repairId); if (!repair) throw new HttpError(400, 'Choose a repair from the report');
  if (active.size >= 2) throw new HttpError(429, 'Two World Health tasks are already active');
  active.set(serverId, { repair: true }); const job = beginJob('world-repair', serverId, 'Verifying repair proposal');
  try {
    const root = instanceDir(serverId), target = confinedFile(root, repair.target);
    const checkCompanion = () => { if (/\.wld$/i.test(repair.target) && ['.twld', '.twld.bak'].some(ext => fs.existsSync(confinedFile(root, repair.target.replace(/\.wld$/i, ext))))) throw new HttpError(409, 'A tModLoader companion exists; use a paired world backup instead of replacing only the .wld file'); };
    checkCompanion();
    const currentHash = () => fs.existsSync(target) ? digest(readWorldBytes(root, repair.target)) : 'missing';
    if (currentHash() !== repair.targetHash) throw new HttpError(409, 'World file changed since the check; scan again');
    let bytes: Buffer;
    if (repair.kind === 'restore') { bytes = readWorldBytes(root, repair.source!); if (digest(bytes) !== repair.sourceHash) throw new HttpError(409, 'Recovery copy changed since the check; scan again'); }
    else { const original = readWorldBytes(root, repair.target); bytes = Buffer.concat([original, Buffer.alloc((4096 - original.length % 4096) % 4096)]); }
    await scanUploadBuffers([{ name: repair.target, buffer: bytes }], serverId);
    progressJob(job, 'Creating mandatory full recovery backup', null);
    const backup = await createBackup(serverId, 'before-world-repair'); report.recoveryBackup = backup.fileName; save(report);
    stopped(serverId);
    checkCompanion();
    if (currentHash() !== repair.targetHash || (repair.source && digest(readWorldBytes(root, repair.source)) !== repair.sourceHash)) throw new HttpError(409, 'World or recovery copy changed during backup; no repair applied');
    const temp = confinedFile(root, `${repair.target}.repair-${crypto.randomUUID()}.tmp`);
    try { const fd = fs.openSync(temp, 'wx', fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, confinedFile(root, repair.target)); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    report.status = 'repaired'; report.repairs = []; save(report); finishJob(job); return { backup: backup.fileName, file: repair.target, message: 'Repair applied. Run another check before starting the game.' };
  } catch (err) { finishJob(job, err); throw err; } finally { active.delete(serverId); }
}
export function initWorldHealth() { for (const row of prep('SELECT server_id,report FROM world_health').all() as unknown as { server_id: string; report: string }[]) { const report: Report = JSON.parse(row.report); if (report.status === 'scanning') { report.status = 'interrupted'; report.repairs = []; save(report); } } }
export function stopWorldHealth() { for (const serverId of active.keys()) cancelWorldHealth(serverId); }
