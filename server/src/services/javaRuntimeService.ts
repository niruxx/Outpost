import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { JAVA_RUNTIMES_DIR } from '../utils/paths.js';
import { downloadFile, fetchJson, type LogFn } from '../utils/download.js';
import { findJava } from './javaService.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Java version manager. Minecraft versions need different Java releases (1.16 and older: 8;
 * 1.17: 16; 1.18–1.20.4: 17; 1.20.5+: 21; newer: whatever Mojang's metadata says). Outpost finds
 * Javas already on the host and can download Eclipse Temurin runtimes into data/runtimes/<major>,
 * then picks the right one per instance (or the one the instance's launch settings name).
 */

export interface JavaRuntime {
  /** Stable id: "managed-21" for Outpost's downloads, "system-<path>" for found ones. */
  id: string;
  path: string;
  major: number;
  version: string;
  vendor: string | null;
  managed: boolean;
}

const ADOPTIUM = 'https://api.adoptium.net/v3';
const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';

/** Parses `java -version` output: "17.0.9" → 17, "1.8.0_392" → 8. */
export function parseJavaVersion(output: string): { major: number; version: string; vendor: string | null } | null {
  const m = output.match(/version "([^"]+)"/);
  if (!m) return null;
  const version = m[1];
  const parts = version.split(/[._+-]/).map(Number);
  const major = parts[0] === 1 ? parts[1] : parts[0];
  if (!Number.isFinite(major)) return null;
  const vendor = /Temurin|AdoptOpenJDK/i.test(output)
    ? 'Eclipse Temurin'
    : /Zulu/i.test(output)
      ? 'Azul Zulu'
      : /Microsoft/i.test(output)
        ? 'Microsoft'
        : /Corretto/i.test(output)
          ? 'Amazon Corretto'
          : /GraalVM/i.test(output)
            ? 'GraalVM'
            : /OpenJDK/i.test(output)
              ? 'OpenJDK'
              : /Java\(TM\)/.test(output)
                ? 'Oracle'
                : null;
  return { major, version, vendor };
}

async function probe(javaPath: string): Promise<{ major: number; version: string; vendor: string | null } | null> {
  try {
    const { stderr, stdout } = await execFileAsync(javaPath, ['-version'], { timeout: 15_000 });
    return parseJavaVersion(`${stderr}\n${stdout}`);
  } catch {
    return null;
  }
}

/** Folders where distro packages and installers put JDKs/JREs. */
function systemCandidates(): string[] {
  const out = new Set<string>();
  const addHomes = (root: string, binSuffix = 'bin') => {
    try {
      for (const d of fs.readdirSync(root)) out.add(path.join(root, d, binSuffix, JAVA_EXE));
    } catch {
      // root missing
    }
  };
  if (process.env.JAVA_HOME) out.add(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft']) addHomes(path.join(pf, vendor));
    }
  } else if (process.platform === 'darwin') {
    addHomes('/Library/Java/JavaVirtualMachines', 'Contents/Home/bin');
  } else {
    for (const root of ['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/usr/local/lib/jvm']) addHomes(root);
  }
  return [...out].filter((p) => fs.existsSync(p));
}

/** The java binary inside an extracted runtime folder (Temurin archives nest one level; macOS adds Contents/Home). */
function javaIn(dir: string): string | null {
  for (const p of [path.join(dir, 'bin', JAVA_EXE), path.join(dir, 'Contents', 'Home', 'bin', JAVA_EXE)]) if (fs.existsSync(p)) return p;
  return null;
}

let cache: { at: number; list: JavaRuntime[] } | null = null;

export async function listRuntimes(fresh = false): Promise<JavaRuntime[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.list;
  const list: JavaRuntime[] = [];
  const seen = new Set<string>();
  const add = async (p: string, managed: boolean) => {
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      // keep as is
    }
    if (seen.has(real)) return;
    seen.add(real);
    const info = await probe(p);
    if (!info) return;
    list.push({ id: managed ? `managed-${info.major}` : `system-${real}`, path: p, ...info, managed });
  };
  if (fs.existsSync(JAVA_RUNTIMES_DIR)) {
    for (const d of fs.readdirSync(JAVA_RUNTIMES_DIR)) {
      if (!/^\d+$/.test(d)) continue;
      const exe = javaIn(path.join(JAVA_RUNTIMES_DIR, d));
      if (exe) await add(exe, true);
    }
  }
  for (const p of systemCandidates()) await add(p, false);
  // Whatever plain `java` on PATH is (may be one of the above).
  const onPath = await findJava();
  if (onPath) {
    const resolved = onPath === 'java' ? await whichJava() : onPath;
    if (resolved) await add(resolved, false);
  }
  list.sort((a, b) => Number(b.managed) - Number(a.managed) || b.major - a.major);
  cache = { at: Date.now(), list };
  return list;
}

async function whichJava(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['java']);
    return stdout.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which Java a Minecraft version needs
// ---------------------------------------------------------------------------

const requiredCache = new Map<string, number>();

/** Rule of thumb when Mojang's metadata isn't reachable (or the version isn't a vanilla id). */
export function requiredJavaFallback(mcVersion: string): number {
  const m = mcVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (major >= 26) return 25; // year-numbered releases (26.1+) moved to Java 25
  if (major !== 1) return 21;
  if (minor <= 16) return 8;
  if (minor === 17) return 16;
  if (minor < 20 || (minor === 20 && patch <= 4)) return 17;
  return 21;
}

/** The Java major a Minecraft version needs — from Mojang's version metadata, cached. */
export async function requiredJava(mcVersion: string): Promise<number> {
  const hit = requiredCache.get(mcVersion);
  if (hit) return hit;
  let major = requiredJavaFallback(mcVersion);
  try {
    const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(MOJANG_MANIFEST);
    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (entry) {
      const detail = await fetchJson<{ javaVersion?: { majorVersion?: number } }>(entry.url);
      if (detail.javaVersion?.majorVersion) major = detail.javaVersion.majorVersion;
    }
  } catch {
    // offline — keep the rule of thumb
  }
  requiredCache.set(mcVersion, major);
  return major;
}

/**
 * Picks the runtime for an instance. `wanted` is a major from its launch settings; without one,
 * the major its Minecraft version needs. Prefers Outpost's managed runtimes, then the newest
 * system match. Falls back to plain `java` (with a note) when nothing matches.
 */
export async function pickRuntime(mcVersion: string | null, wanted?: number): Promise<{ path: string | null; major: number | null; note: string | null }> {
  const need = wanted ?? (mcVersion ? await requiredJava(mcVersion) : null);
  const runtimes = await listRuntimes();
  if (need) {
    const match = runtimes.find((r) => r.major === need);
    if (match) return { path: match.path, major: match.major, note: null };
    // Newer Java usually runs newer Minecraft fine — but never pick a newer one for old (Java 8) versions,
    // which break on modern Java.
    if (!wanted && need >= 17) {
      const newer = runtimes.filter((r) => r.major > need).sort((a, b) => a.major - b.major)[0];
      if (newer) return { path: newer.path, major: newer.major, note: `Java ${need} isn’t installed — using Java ${newer.major}. Install Java ${need} under Configuration → Java runtimes for the best fit.` };
    }
  }
  const fallback = await findJava();
  const fbInfo = fallback ? runtimes.find((r) => r.path === fallback) ?? null : null;
  return {
    path: fallback,
    major: fbInfo?.major ?? null,
    note: need ? `Java ${need} isn’t installed${fallback ? ' — using the system default java' : ''}. Install it under Configuration → Java runtimes.` : null,
  };
}

// ---------------------------------------------------------------------------
// Installing Temurin runtimes
// ---------------------------------------------------------------------------

export interface InstallJob {
  major: number;
  status: 'downloading' | 'extracting' | 'done' | 'failed';
  progress: number;
  error: string | null;
}
const jobs = new Map<number, InstallJob>();
export const installJobs = () => [...jobs.values()];

function adoptiumOs(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  // musl-based distros (Alpine) need their own builds
  try {
    if (fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl'))) return 'alpine-linux';
  } catch {
    // ignore
  }
  return 'linux';
}

function adoptiumArch(): string {
  return ({ x64: 'x64', arm64: 'aarch64', arm: 'arm', ia32: 'x32', ppc64: 'ppc64le', s390x: 's390x' } as Record<string, string>)[process.arch] ?? process.arch;
}

let releasesCache: { at: number; value: { available: number[]; lts: number[] } } | null = null;

/** Majors Temurin publishes (LTS marked), for the "install" menu. */
export async function availableMajors(): Promise<{ available: number[]; lts: number[] }> {
  if (releasesCache && Date.now() - releasesCache.at < 6 * 3600_000) return releasesCache.value;
  let value = { available: [8, 11, 17, 21, 25], lts: [8, 11, 17, 21, 25] };
  try {
    const r = await fetchJson<{ available_lts_releases: number[]; available_releases: number[] }>(`${ADOPTIUM}/info/available_releases`);
    // Minecraft only ever needed 8, 16, 17, 21 and newer LTS — don't list every short-lived release.
    const lts = r.available_lts_releases.filter((v) => v >= 8);
    value = { available: [...new Set([...lts, 16])].sort((a, b) => a - b), lts };
  } catch {
    // offline — the static list
  }
  releasesCache = { at: Date.now(), value };
  return value;
}

function runTar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
  });
}

/** Downloads Temurin <major> (JRE, or JDK where no JRE is published) into data/runtimes/<major>. Runs in the background. */
export function installRuntime(major: number, onLog: LogFn = (l) => logger.info(l)): InstallJob {
  const running = jobs.get(major);
  if (running && (running.status === 'downloading' || running.status === 'extracting')) return running;
  const job: InstallJob = { major, status: 'downloading', progress: 0, error: null };
  jobs.set(major, job);
  void (async () => {
    const target = path.join(JAVA_RUNTIMES_DIR, String(major));
    const staging = `${target}.partial`;
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const archive = path.join(JAVA_RUNTIMES_DIR, `_temurin-${major}.${ext}`);
    try {
      fs.mkdirSync(JAVA_RUNTIMES_DIR, { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true });
      let url = '';
      for (const imageType of ['jre', 'jdk']) {
        const candidate = `${ADOPTIUM}/binary/latest/${major}/ga/${adoptiumOs()}/${adoptiumArch()}/${imageType}/hotspot/normal/eclipse`;
        const head = await fetch(candidate, { method: 'HEAD', redirect: 'manual' }).catch(() => null);
        if (head && (head.status === 302 || head.status === 307 || head.ok)) {
          url = candidate;
          break;
        }
      }
      if (!url) throw new Error(`Temurin ${major} isn’t published for ${adoptiumOs()}/${adoptiumArch()}`);
      await downloadFile(url, archive, (pct) => (job.progress = Math.round(pct * 0.9)), onLog);
      job.status = 'extracting';
      fs.mkdirSync(staging, { recursive: true });
      if (ext === 'zip') {
        new AdmZip(archive).extractAllTo(staging, true);
        // zips keep the top folder (jdk-21.0.x+y-jre); flatten it
        const entries = fs.readdirSync(staging);
        if (entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()) {
          const inner = path.join(staging, entries[0]);
          for (const e of fs.readdirSync(inner)) fs.renameSync(path.join(inner, e), path.join(staging, e));
          fs.rmdirSync(inner);
        }
      } else {
        await runTar(archive, staging);
      }
      const exe = javaIn(staging);
      if (!exe) throw new Error('the download has no bin/java in it');
      const info = await probe(exe);
      if (!info) throw new Error('the downloaded Java doesn’t run on this machine');
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      job.status = 'done';
      job.progress = 100;
      onLog(`Installed Java ${info.version} (Temurin) into ${target}`);
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      fs.rmSync(staging, { recursive: true, force: true });
      onLog(`Java ${major} install failed: ${job.error}`);
    } finally {
      fs.rmSync(archive, { force: true });
      cache = null;
    }
  })();
  return job;
}

export function removeRuntime(major: number): boolean {
  const target = path.join(JAVA_RUNTIMES_DIR, String(major));
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  jobs.delete(major);
  cache = null;
  return true;
}
