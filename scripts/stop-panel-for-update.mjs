// Used only after systemd has accepted a stop job with KillMode=process.
// Older units use npm as MainPID; signal the actual panel without touching games.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function panelPids(project, cgroup, procRoot = '/proc', io = fs) {
  if (!cgroup || cgroup === '/' || !cgroup.startsWith('/')) throw new Error('A specific service cgroup is required');
  const target = path.join(io.realpathSync(project), 'server', 'dist', 'index.js');
  return io.readdirSync(procRoot).filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const directory = path.join(procRoot, name);
      const groups = io.readFileSync(path.join(directory, 'cgroup'), 'utf8').trim().split('\n').map(line => line.split(':').slice(2).join(':'));
      if (!groups.some(group => group === cgroup || group.startsWith(cgroup + '/'))) return [];
      const executable = path.basename(io.readlinkSync(path.join(directory, 'exe')));
      if (!/^node(?:js)?(?: \(deleted\))?$/.test(executable)) return [];
      const cwd = io.readlinkSync(path.join(directory, 'cwd'));
      const args = io.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      return args.slice(1).some(arg => path.resolve(cwd, arg) === target) ? [Number(name)] : [];
    } catch { return []; } // Processes can exit during enumeration.
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, cgroup] = process.argv.slice(2);
  try {
    if (process.platform !== 'linux') throw new Error('This helper requires Linux /proc');
    for (const pid of panelPids(project, cgroup)) {
      // Recheck identity immediately before signalling; never signal a PID from metadata.
      if (panelPids(project, cgroup).includes(pid)) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    const deadline = Date.now() + 15000;
    while (panelPids(project, cgroup).length) {
      if (Date.now() > deadline) throw new Error('The panel did not stop within 15 seconds; instance supervisors were left untouched');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
