import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { confinedFile, inspectWorldFile, type WorldFileCheck } from './worldHealthParsers.js';
export interface WorldRepair { id: string; target: string; source?: string; kind: 'pad' | 'restore'; targetHash: string; sourceHash?: string; impact: string; sourceTime?: string }
const { root, inputs } = workerData as { root: string; inputs: { file: string; kind: WorldFileCheck['kind'] }[] };
const checks: WorldFileCheck[] = [], repairs: WorldRepair[] = [];
for (const [i, input] of inputs.entries()) {
  let current: WorldFileCheck;
  try { current = inspectWorldFile(root, input.file, input.kind); }
  catch (err) { current = { ...input, hash: fs.existsSync(confinedFile(root, input.file)) ? '' : 'missing', bytes: 0, checked: 0, findings: [{ code: 'file-unreadable', severity: 'error', message: err instanceof Error ? err.message : 'File cannot be read' }] }; }
  checks.push(current);
  if (input.kind === 'terraria') current.companion = fs.existsSync(confinedFile(root, input.file.replace(/\.wld$/i, '.twld'))) || fs.existsSync(confinedFile(root, input.file.replace(/\.wld$/i, '.twld.bak')));
  if (current.padSafe && current.hash) repairs.push({ id: `pad-${i}`, target: input.file, targetHash: current.hash, kind: 'pad', impact: 'Append zero bytes only to finish the unused final sector. No chunk location entries or builds are reset.' });
  if (current.findings.some(f => f.severity === 'error') && current.hash && !current.companion) {
    const source = input.kind === 'level' ? input.file.replace(/level\.dat$/, 'level.dat_old') : `${input.file}.bak`;
    try {
      const backup = inspectWorldFile(root, source, input.kind);
      if (!backup.findings.length && backup.checked > 0 && !backup.externalChunks && !current.externalChunks && (!current.identity || !backup.identity || current.identity === backup.identity)) repairs.push({ id: `restore-${i}`, target: input.file, source, kind: 'restore', targetHash: current.hash, sourceHash: backup.hash, sourceTime: fs.statSync(confinedFile(root, source)).mtime.toISOString(), impact: `Replace only ${input.file} with its structurally checked local backup. Changes saved after that backup may be lost.${!current.identity && input.kind !== 'region' ? ' The damaged original has no readable identity to compare; confirm that this backup belongs to this world.' : ''}` });
    } catch { /* No validated local recovery copy; do not invent a repair. */ }
  }
  parentPort!.postMessage({ type: 'progress', done: i + 1, total: inputs.length });
}
parentPort!.postMessage({ type: 'result', checks, repairs });
