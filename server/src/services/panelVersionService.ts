import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SERVER_ROOT } from '../utils/paths.js';
import { envVar } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const run = promisify(execFile);

/**
 * Which commit this panel runs, and whether its Git remote has newer ones — so admins get a nudge
 * to run ./update.sh. The remote is fetched every 6 hours (and on request), never pulled: updating
 * stays the admin's call.
 */

/** The Outpost checkout (OUTPOST_REPO_DIR overrides it, for tests or unusual layouts). */
const REPO = envVar('REPO_DIR') ? path.resolve(envVar('REPO_DIR')!) : path.resolve(SERVER_ROOT, '..');

export interface PanelVersion {
  version: string;
  isGit: boolean;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  /** Commits on the upstream branch this checkout doesn't have yet. */
  behind: number;
  newCommits: { hash: string; subject: string; date: string }[];
  /** Files changed locally since the install/last update (kept by update.sh's stash). */
  localChanges: number;
  upstream: string | null;
  checkedAt: string | null;
  checkError: string | null;
}

async function git(args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await run('git', ['-C', REPO, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

let state: PanelVersion = {
  version: packageVersion(),
  isGit: false,
  commit: null,
  commitDate: null,
  branch: null,
  behind: 0,
  newCommits: [],
  localChanges: 0,
  upstream: null,
  checkedAt: null,
  checkError: null,
};

export const panelVersion = () => state;

/** Reads the local checkout (cheap — no network). */
async function readLocal() {
  try {
    if (!fs.existsSync(path.join(REPO, '.git'))) {
      state = { ...state, isGit: false };
      return;
    }
    const [commit, date, branch, status] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD']),
      git(['log', '-1', '--format=%cI']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['status', '--porcelain', '--untracked-files=no']),
    ]);
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
    state = { ...state, isGit: true, commit, commitDate: date, branch, upstream, localChanges: status ? status.split('\n').length : 0 };
  } catch (err) {
    state = { ...state, isGit: false, checkError: err instanceof Error ? err.message : String(err) };
  }
}

/** Fetches the upstream branch and counts the commits we're missing. */
export async function checkForPanelUpdate(): Promise<PanelVersion> {
  await readLocal();
  if (!state.isGit) return state;
  if (!state.upstream) {
    state = { ...state, checkedAt: new Date().toISOString(), checkError: 'This checkout has no upstream branch to compare with' };
    return state;
  }
  try {
    const remote = state.upstream.split('/')[0];
    await git(['fetch', '--quiet', remote], 60_000);
    const behind = Number(await git(['rev-list', '--count', `HEAD..${state.upstream}`])) || 0;
    const log = behind ? await git(['log', '--format=%h%x09%cI%x09%s', '-n', '20', `HEAD..${state.upstream}`]) : '';
    state = {
      ...state,
      behind,
      newCommits: log
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [hash, date, ...subject] = l.split('\t');
          return { hash, date, subject: subject.join('\t') };
        }),
      checkedAt: new Date().toISOString(),
      checkError: null,
    };
    if (behind) logger.info(`Outpost update available: ${behind} new commit(s) on ${state.upstream} — run ./update.sh`);
  } catch (err) {
    state = { ...state, checkedAt: new Date().toISOString(), checkError: `Couldn’t reach the Git remote: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
  return state;
}

export function initPanelVersion() {
  void readLocal().then(() => checkForPanelUpdate());
  setInterval(() => void checkForPanelUpdate(), 6 * 3600_000).unref();
}
