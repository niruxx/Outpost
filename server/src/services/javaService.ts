import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedJavaPath: string | null | undefined;
let cachedJavacPath: string | null | undefined;
export function resetJavaDetection() { cachedJavaPath = undefined; cachedJavacPath = undefined; }

/** Resolves a usable `java` executable: $JAVA_HOME first, then whatever is on PATH. Cached after first success. */
export async function findJava(): Promise<string | null> {
  if (cachedJavaPath !== undefined) return cachedJavaPath;

  const candidates: string[] = [];
  if (process.env.JAVA_HOME) {
    candidates.push(
      process.platform === 'win32'
        ? `${process.env.JAVA_HOME}\\bin\\java.exe`
        : `${process.env.JAVA_HOME}/bin/java`
    );
  }
  candidates.push('java');

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-version']);
      cachedJavaPath = candidate;
      return candidate;
    } catch {
      // try next candidate
    }
  }
  cachedJavaPath = null;
  return null;
}

/** Resolves a usable `javac` executable — needed only for building Spigot from source via BuildTools. */
export async function findJavac(): Promise<string | null> {
  if (cachedJavacPath !== undefined) return cachedJavacPath;

  const candidates: string[] = [];
  if (process.env.JAVA_HOME) {
    candidates.push(
      process.platform === 'win32'
        ? `${process.env.JAVA_HOME}\\bin\\javac.exe`
        : `${process.env.JAVA_HOME}/bin/javac`
    );
  }
  candidates.push('javac');

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-version']);
      cachedJavacPath = candidate;
      return candidate;
    } catch {
      // try next candidate
    }
  }
  cachedJavacPath = null;
  return null;
}

export async function getJavaVersion(): Promise<string | null> {
  const java = await findJava();
  if (!java) return null;
  try {
    const { stderr, stdout } = await execFileAsync(java, ['-version']);
    const text = (stderr || stdout).split('\n')[0];
    return text.trim();
  } catch {
    return null;
  }
}
