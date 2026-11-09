import os from 'node:os';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { terminalIdentity } from '../services/hostTerminalService.js';
import { logAudit } from '../services/userService.js';
import { getSetting, setSetting } from '../services/systemSettingsService.js';
import { disableAdminMode, enableAdminMode, hostFilesStatus, isAdminModeActive, runHostSystemOp } from '../services/hostFilesService.js';
import { systemLogs } from '../services/systemLogsService.js';
import { UNIT_ACTIONS, UNIT_TYPES, sanitizeTimer, validUnitName, type UnitAction, type UnitType } from '../services/hostSystemOps.js';
import { checkCalendar, listUnits, ownUnit, protectionFor, servicesAvailability, unitDetails } from '../services/hostServicesService.js';
import {
  autoUpdatesStatus,
  catalog,
  detectManager,
  getJob,
  installedPackages,
  listUpdates,
  rebootRequired,
  searchPackages,
  startJob,
  validateTransaction,
} from '../services/hostPackagesService.js';
import { accountsOverview } from '../services/hostAccountsService.js';
import { connectionDetails, networkAvailability, networkOverview } from '../services/hostNetworkService.js';
import type { NetChange } from '../services/hostNetworkOps.js';
import { hostOverview, listTimezones } from '../services/hostSettingsService.js';
import { securityOverview } from '../services/hostSecurityService.js';
import { TLS_DIR, generateSelfSigned, markAcme, saveCustomCertificate, setTlsOptions, applyTlsSettings, tlsStatus } from '../services/tlsService.js';
import { DIAG_DIR, deleteReport, diagnosticsOverview, reportPath } from '../services/hostDiagnosticsService.js';
import { getHostJob, startHostJob } from '../services/hostJobs.js';
import { RANGES, metricsHistory } from '../services/hostMetricsHistoryService.js';

/**
 * Host administration in the style of Cockpit: overview & settings, metrics, services, software,
 * accounts, networking, security and diagnostics.
 *
 * The same router serves two callers:
 *  - this panel's administrators (mounted at /api/host behind a normal sign-in; no API keys);
 *  - a linked Outpost panel administering this host (mounted under /api/node-link/host behind the
 *    node key, and only when "Allow linked panels to administer this host" is on).
 * Reads run as the Outpost service account. Every change needs Admin Mode for the caller's session
 * and is audited.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      hostCtx?: HostContext;
    }
  }
}

export interface HostContext {
  /** Admin Mode is keyed by this (a browser session, or a remote panel's session id). */
  token: string;
  actorId: string | null;
  actorName: string;
  identity: { id: string; username: string };
  remote: boolean;
}

export const REMOTE_ADMIN_SETTING = 'remote_host_admin';

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : '';
}

/** For this panel's own administrators (after requireAuth + requireRole('admin')). */
export function localHostContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    const identity = terminalIdentity(token); // real sign-in only: API keys are refused
    req.hostCtx = { token, actorId: req.auth!.sub, actorName: req.auth!.username, identity: { id: identity.id, username: identity.username }, remote: false };
    next();
  } catch (error) {
    next(error);
  }
}

/** For a linked panel (after requireNodeKey). */
export function remoteHostContext(req: Request, _res: Response, next: NextFunction) {
  try {
    if (getSetting(REMOTE_ADMIN_SETTING) !== '1') throw new HttpError(403, `${os.hostname()} doesn’t allow linked panels to administer it. Turn it on under Host → Overview on that host.`);
    const session = req.headers['x-outpost-host-session'];
    const user = req.headers['x-outpost-acting-user'];
    const origin = req.headers['x-outpost-origin'];
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(session)) throw new HttpError(400, 'Missing host session');
    const who = `${typeof user === 'string' ? user.replace(/[^\w.@-]/g, '').slice(0, 64) : 'unknown'}@${typeof origin === 'string' ? origin.replace(/[^\w.-]/g, '').slice(0, 64) : 'linked-panel'}`;
    req.hostCtx = { token: `node:${session}`, actorId: null, actorName: who, identity: { id: `node:${session}`, username: who }, remote: true };
    next();
  } catch (error) {
    next(error);
  }
}

const ctx = (req: Request) => req.hostCtx!;
const audit = (req: Request, action: string, detail: string) => logAudit(ctx(req).actorId, ctx(req).actorName, action, undefined, detail);
const run: typeof runHostSystemOp = (token, op, args, opts) => runHostSystemOp(token, op, args, opts);

function requireAdminMode(req: Request) {
  if (!isAdminModeActive(ctx(req).token)) throw new HttpError(403, 'Turn on Admin Mode to make changes to the host');
}

const linuxOnly = () => {
  if (process.platform !== 'linux') throw new HttpError(409, 'Only available on Linux hosts');
};

export const hostAdminApi = Router();

// ---------------------------------------------------------------------------
// Admin Mode for this caller
// ---------------------------------------------------------------------------

hostAdminApi.get('/admin-mode', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...hostFilesStatus(ctx(req).token), hostname: os.hostname(), remote: ctx(req).remote });
});

hostAdminApi.post(
  '/admin-mode',
  asyncHandler(async (req, res) => {
    try {
      const status = await enableAdminMode(ctx(req).token, ctx(req).identity, req.body?.password);
      audit(req, 'host.admin.enable', 'Administrative access turned on');
      res.set('Cache-Control', 'no-store').json({ ...status, hostname: os.hostname(), remote: ctx(req).remote });
    } catch (err) {
      audit(req, 'host.admin.denied', err instanceof Error ? err.message : 'Failed');
      throw err;
    }
  })
);

hostAdminApi.delete('/admin-mode', (req, res) => {
  const status = disableAdminMode(ctx(req).token);
  audit(req, 'host.admin.disable', 'Administrative access turned off');
  res.set('Cache-Control', 'no-store').json({ ...status, hostname: os.hostname(), remote: ctx(req).remote });
});

// ---------------------------------------------------------------------------
// Overview & settings
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ...(await hostOverview()), remoteAdmin: getSetting(REMOTE_ADMIN_SETTING) === '1' });
  })
);

hostAdminApi.get(
  '/settings/timezones',
  asyncHandler(async (_req, res) => {
    res.json({ timezones: await listTimezones() });
  })
);

const settingsChange = (path: string, op: Parameters<typeof runHostSystemOp>[1], action: string, describe: (body: Record<string, unknown>) => string) =>
  hostAdminApi.post(
    path,
    asyncHandler(async (req, res) => {
      linuxOnly();
      requireAdminMode(req);
      const result = await run(ctx(req).token, op, (req.body ?? {}) as never);
      audit(req, action, describe(req.body ?? {}));
      res.json({ result, overview: await hostOverview() });
    })
  );

settingsChange('/settings/hostname', 'settings.hostname', 'host.settings.hostname', (b) => String(b.hostname));
settingsChange('/settings/timezone', 'settings.timezone', 'host.settings.timezone', (b) => String(b.timezone));
settingsChange('/settings/ntp', 'settings.ntp', 'host.settings.ntp', (b) => (b.enabled ? 'on' : 'off'));
settingsChange('/settings/ntp-servers', 'settings.ntpServers', 'host.settings.ntpServers', (b) => (Array.isArray(b.servers) ? b.servers.join(' ') : ''));
settingsChange('/settings/time', 'settings.time', 'host.settings.time', (b) => String(b.time));
settingsChange('/settings/tuned', 'tuned.profile', 'host.settings.tuned', (b) => String(b.profile ?? 'off'));
settingsChange('/settings/power', 'power.schedule', 'host.power', (b) => `${b.action}${b.delayMinutes ? ` in ${b.delayMinutes} min` : ' now'}`);

hostAdminApi.delete(
  '/settings/power',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'power.cancel', {});
    audit(req, 'host.power.cancel', 'Scheduled shutdown cancelled');
    res.json({ overview: await hostOverview() });
  })
);

// ---------------------------------------------------------------------------
// Metrics history
// ---------------------------------------------------------------------------

hostAdminApi.get('/metrics', (req, res) => {
  const range = typeof req.query.range === 'string' && RANGES[req.query.range] ? req.query.range : '6h';
  res.set('Cache-Control', 'no-store').json(metricsHistory(range));
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/services',
  asyncHandler(async (req, res) => {
    const availability = servicesAvailability();
    const type = (typeof req.query.type === 'string' ? req.query.type : 'service') as UnitType;
    if (!UNIT_TYPES.includes(type)) throw new HttpError(400, 'Unknown unit type');
    const units = availability.available ? await listUnits(type) : [];
    res.set('Cache-Control', 'no-store').json({ ...availability, type, units, ownUnit: ownUnit() });
  })
);

hostAdminApi.get(
  '/services/units/:unit',
  asyncHandler(async (req, res) => {
    if (!servicesAvailability().available) throw new HttpError(409, 'Service management is unavailable on this host');
    res.set('Cache-Control', 'no-store').json(await unitDetails(req.params.unit));
  })
);

hostAdminApi.get(
  '/services/units/:unit/logs',
  asyncHandler(async (req, res) => {
    const unit = req.params.unit;
    if (!validUnitName(unit)) throw new HttpError(400, 'Invalid unit name');
    const priority = typeof req.query.priority === 'string' && req.query.priority !== '' ? Number(req.query.priority) : undefined;
    const lines = Number(req.query.lines) || 200;
    res.set('Cache-Control', 'no-store').json(await systemLogs.journal({ unit, priority, lines, since: typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined }));
  })
);

hostAdminApi.post(
  '/services/units/:unit/action',
  asyncHandler(async (req, res) => {
    const unit = req.params.unit;
    const action = req.body?.action as UnitAction;
    if (!validUnitName(unit)) throw new HttpError(400, 'Invalid unit name');
    if (!UNIT_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown action');
    requireAdminMode(req);
    const risk = protectionFor(unit, action);
    if (risk && req.body?.force !== true) throw new HttpError(409, risk);
    audit(req, `host.service.${action}`, unit);
    // Restarting Outpost itself: answer first, then let systemd restart us.
    if (unit === ownUnit() && (action === 'restart' || action === 'stop')) {
      res.json({ ok: true, deferred: true });
      const token = ctx(req).token;
      setTimeout(() => void run(token, 'unit.action', { unit, action }).catch(() => undefined), 500);
      return;
    }
    const result = await run(ctx(req).token, 'unit.action', { unit, action });
    res.json({ ok: true, output: result.output, details: await unitDetails(unit) });
  })
);

hostAdminApi.post(
  '/services/calendar',
  asyncHandler(async (req, res) => {
    res.json(await checkCalendar(req.body?.expression));
  })
);

hostAdminApi.post(
  '/services/timers',
  asyncHandler(async (req, res) => {
    let definition;
    try {
      definition = sanitizeTimer(req.body?.definition);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (definition.onCalendar) {
      const check = await checkCalendar(definition.onCalendar);
      if (!check.valid) throw new HttpError(400, `Schedule: ${check.error}`);
    }
    requireAdminMode(req);
    const replace = req.body?.replace === true;
    await run(ctx(req).token, 'timer.write', { definition, enable: req.body?.enable !== false, replace });
    audit(req, replace ? 'host.timer.update' : 'host.timer.create', JSON.stringify({ name: definition.name, schedule: definition.onCalendar || definition.onUnitActiveSec || definition.onBootSec, command: definition.command, user: definition.user || 'root' }));
    res.status(replace ? 200 : 201).json({ unit: `${definition.name}.timer` });
  })
);

hostAdminApi.delete(
  '/services/timers/:name',
  asyncHandler(async (req, res) => {
    requireAdminMode(req);
    const { name } = await run(ctx(req).token, 'timer.delete', { name: req.params.name });
    audit(req, 'host.timer.delete', name);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Software
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/packages',
  asyncHandler(async (_req, res) => {
    const { manager, distro } = detectManager();
    const reason = manager ? null : process.platform !== 'linux' ? 'Software management is only available on Linux hosts.' : 'No supported package manager (apt, dnf or pacman) was found on this host.';
    const [reboot, auto] = manager ? await Promise.all([rebootRequired(), autoUpdatesStatus()]) : [{ required: null, packages: [] }, null];
    res.set('Cache-Control', 'no-store').json({ available: !!manager, reason, manager, distro, reboot, autoUpdates: auto, job: getJob() });
  })
);

hostAdminApi.get(
  '/packages/updates',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await listUpdates(req.query.recheck === '1'));
  })
);

hostAdminApi.get(
  '/packages/catalog',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await catalog());
  })
);

hostAdminApi.get(
  '/packages/search',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await searchPackages(req.query.q));
  })
);

hostAdminApi.get(
  '/packages/installed',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ packages: await installedPackages() });
  })
);

/** Simulates a transaction and returns the package manager's own summary of what would change. */
hostAdminApi.post(
  '/packages/preview',
  asyncHandler(async (req, res) => {
    const t = validateTransaction(req.body?.verb, req.body?.packages);
    if (t.verb === 'refresh') throw new HttpError(400, 'Nothing to preview');
    requireAdminMode(req);
    const r = await run(ctx(req).token, 'pkg.run', { ...t, preview: true }, { timeoutMs: 6 * 60_000 });
    res.json({ output: r.output });
  })
);

hostAdminApi.post(
  '/packages/jobs',
  asyncHandler(async (req, res) => {
    const t = validateTransaction(req.body?.verb, req.body?.packages);
    requireAdminMode(req);
    const { token, actorId, actorName } = ctx(req);
    const job = startJob(
      (args, onProgress) => run(token, 'pkg.run', args, { timeoutMs: 65 * 60_000, onProgress }),
      t,
      actorName,
      (done) => logAudit(actorId, actorName, `host.package.${t.verb}${done.state === 'failed' ? '.failed' : ''}`, undefined, t.packages.join(' ') || t.manager)
    );
    res.status(202).json({ job });
  })
);

hostAdminApi.get('/packages/jobs/current', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ job: getJob() });
});

hostAdminApi.post(
  '/packages/auto-updates',
  asyncHandler(async (req, res) => {
    const { manager } = detectManager();
    if (!manager) throw new HttpError(409, 'No supported package manager');
    requireAdminMode(req);
    const enabled = req.body?.enabled === true;
    await run(ctx(req).token, 'pkg.autoUpdates', { manager, enabled });
    audit(req, enabled ? 'host.updates.auto.enable' : 'host.updates.auto.disable', manager);
    res.json({ autoUpdates: await autoUpdatesStatus() });
  })
);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** The account Outpost runs as can't be changed here: it would cut the panel off. */
function notServiceAccount(name: unknown) {
  if (name === os.userInfo().username) throw new HttpError(403, `${String(name)} is the account Outpost runs as and can’t be changed here`);
}

hostAdminApi.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    const overview = await accountsOverview();
    let shadow: Awaited<ReturnType<typeof runHostSystemOp<'account.shadow'>>> | null = null;
    if (overview.available && isAdminModeActive(ctx(req).token)) shadow = await run(ctx(req).token, 'account.shadow', {}).catch(() => null);
    const byName = new Map((shadow ?? []).map((s) => [s.name, s]));
    res.set('Cache-Control', 'no-store').json(
      overview.available ? { ...overview, passwordInfo: !!shadow, users: overview.users.map((u) => ({ ...u, password: byName.get(u.name) ?? null })) } : overview
    );
  })
);

hostAdminApi.post(
  '/accounts/users',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const b = req.body ?? {};
    const r = await run(ctx(req).token, 'account.create', { username: b.username, fullName: b.fullName, shell: b.shell, groups: Array.isArray(b.groups) ? b.groups : [], password: b.password || undefined, admin: b.admin === true, forceChange: b.forceChange === true });
    audit(req, 'host.account.create', `${r.username}${b.admin ? ' (administrator)' : ''}`);
    res.status(201).json(r);
  })
);

hostAdminApi.patch(
  '/accounts/users/:name',
  asyncHandler(async (req, res) => {
    linuxOnly();
    notServiceAccount(req.params.name);
    requireAdminMode(req);
    const b = req.body ?? {};
    const changes = {
      username: req.params.name,
      ...(b.fullName !== undefined ? { fullName: b.fullName } : {}),
      ...(b.shell !== undefined ? { shell: b.shell } : {}),
      ...(Array.isArray(b.groups) ? { groups: b.groups } : {}),
      ...(typeof b.admin === 'boolean' ? { admin: b.admin } : {}),
      ...(typeof b.locked === 'boolean' ? { locked: b.locked } : {}),
      ...(typeof b.password === 'string' && b.password ? { password: b.password } : {}),
      ...(b.forceChange === true ? { forceChange: true } : {}),
      ...(b.expireDate !== undefined ? { expireDate: b.expireDate } : {}),
      ...(b.maxDays !== undefined ? { maxDays: b.maxDays } : {}),
    };
    await run(ctx(req).token, 'account.modify', changes);
    const what = Object.keys(changes).filter((k) => k !== 'username').map((k) => (k === 'password' ? 'password' : k === 'locked' ? (b.locked ? 'locked' : 'unlocked') : k));
    audit(req, 'host.account.modify', `${req.params.name}: ${what.join(', ')}`);
    res.json({ ok: true });
  })
);

hostAdminApi.delete(
  '/accounts/users/:name',
  asyncHandler(async (req, res) => {
    linuxOnly();
    notServiceAccount(req.params.name);
    requireAdminMode(req);
    const removeHome = req.query.removeHome === '1';
    await run(ctx(req).token, 'account.delete', { username: req.params.name, removeHome });
    audit(req, 'host.account.delete', `${req.params.name}${removeHome ? ' (home removed)' : ''}`);
    res.status(204).end();
  })
);

hostAdminApi.get(
  '/accounts/users/:name/keys',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    res.set('Cache-Control', 'no-store').json(await run(ctx(req).token, 'account.keys.read', { username: req.params.name }));
  })
);

hostAdminApi.put(
  '/accounts/users/:name/keys',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const r = await run(ctx(req).token, 'account.keys.write', { username: req.params.name, content: String(req.body?.content ?? '') });
    audit(req, 'host.account.keys', `${req.params.name}: ${r.keys} key(s)`);
    res.json(r);
  })
);

hostAdminApi.post(
  '/accounts/groups',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const r = await run(ctx(req).token, 'group.create', { name: req.body?.name });
    audit(req, 'host.group.create', r.name);
    res.status(201).json(r);
  })
);

hostAdminApi.delete(
  '/accounts/groups/:name',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'group.delete', { name: req.params.name });
    audit(req, 'host.group.delete', req.params.name);
    res.status(204).end();
  })
);

hostAdminApi.post(
  '/accounts/groups/:name/members',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const add = Array.isArray(req.body?.add) ? req.body.add : [];
    const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
    for (const u of [...add, ...remove]) notServiceAccount(u);
    await run(ctx(req).token, 'group.members', { name: req.params.name, add, remove });
    audit(req, 'host.group.members', `${req.params.name}: ${[...add.map((u: string) => `+${u}`), ...remove.map((u: string) => `-${u}`)].join(' ')}`);
    res.json({ ok: true });
  })
);

hostAdminApi.delete(
  '/accounts/sessions/:id',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'session.terminate', { id: req.params.id });
    audit(req, 'host.session.terminate', req.params.id);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Networking (every change is a NetworkManager checkpoint the browser must confirm)
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/network',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await networkOverview());
  })
);

hostAdminApi.get(
  '/network/connections/:uuid',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await connectionDetails(req.params.uuid));
  })
);

hostAdminApi.post(
  '/network/changes',
  asyncHandler(async (req, res) => {
    const availability = await networkAvailability();
    if (!availability.available) throw new HttpError(409, availability.reason ?? 'NetworkManager unavailable');
    requireAdminMode(req);
    const change = req.body?.change as NetChange;
    const result = await run(ctx(req).token, 'net.apply', { change, rollbackSec: Number(req.body?.rollbackSec) || 60 });
    audit(req, `host.network.${String(change?.kind)}`, JSON.stringify({ ...change, checkpoint: result.checkpoint }));
    res.json(result);
  })
);

hostAdminApi.post(
  '/network/changes/confirm',
  asyncHandler(async (req, res) => {
    requireAdminMode(req);
    await run(ctx(req).token, 'net.confirm', { checkpoint: req.body?.checkpoint });
    audit(req, 'host.network.confirm', String(req.body?.checkpoint));
    res.json({ ok: true });
  })
);

hostAdminApi.post(
  '/network/changes/rollback',
  asyncHandler(async (req, res) => {
    requireAdminMode(req);
    await run(ctx(req).token, 'net.rollback', { checkpoint: req.body?.checkpoint });
    audit(req, 'host.network.rollback', String(req.body?.checkpoint));
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/security',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await securityOverview());
  })
);

hostAdminApi.get(
  '/security/selinux/denials',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    res.set('Cache-Control', 'no-store').json({ denials: await run(ctx(req).token, 'selinux.denials', { since: typeof req.query.since === 'string' ? req.query.since : 'today' }) });
  })
);

hostAdminApi.post(
  '/security/selinux/explain',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    res.json(await run(ctx(req).token, 'selinux.explain', { raw: String(req.body?.raw ?? '') }));
  })
);

hostAdminApi.post(
  '/security/selinux/mode',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'selinux.mode', { mode: req.body?.mode, persistent: req.body?.persistent === true });
    audit(req, 'host.selinux.mode', `${req.body?.mode}${req.body?.persistent ? ' (persistent)' : ''}`);
    res.json(await securityOverview());
  })
);

hostAdminApi.get(
  '/security/apparmor',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const [status, denials] = await Promise.all([run(ctx(req).token, 'apparmor.status', {}), run(ctx(req).token, 'apparmor.denials', {})]);
    res.set('Cache-Control', 'no-store').json({ ...status, denials });
  })
);

hostAdminApi.post(
  '/security/apparmor/mode',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'apparmor.mode', { profile: req.body?.profile, mode: req.body?.mode });
    audit(req, 'host.apparmor.mode', `${req.body?.profile}: ${req.body?.mode}`);
    res.json({ ok: true });
  })
);

hostAdminApi.post(
  '/security/crypto-policy',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    await run(ctx(req).token, 'crypto.policy', { policy: req.body?.policy });
    audit(req, 'host.crypto.policy', String(req.body?.policy));
    res.json(await securityOverview());
  })
);

// The panel's own HTTPS certificate. Uploads and self-signed certificates need no root.
hostAdminApi.post(
  '/security/tls/custom',
  asyncHandler(async (req, res) => {
    const info = saveCustomCertificate(String(req.body?.cert ?? ''), String(req.body?.key ?? ''));
    audit(req, 'panel.tls.custom', `${info.subject} until ${info.validTo}`);
    res.json(tlsStatus());
  })
);

hostAdminApi.post(
  '/security/tls/self-signed',
  asyncHandler(async (req, res) => {
    const names = Array.isArray(req.body?.names) ? req.body.names.filter((n: unknown) => typeof n === 'string') : [];
    const info = await generateSelfSigned(names);
    audit(req, 'panel.tls.selfSigned', info.names.join(', '));
    res.json(tlsStatus());
  })
);

hostAdminApi.post(
  '/security/tls/options',
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    setTlsOptions({ enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, port: b.port !== undefined ? Number(b.port) : undefined, redirect: typeof b.redirect === 'boolean' ? b.redirect : undefined });
    await applyTlsSettings();
    audit(req, 'panel.tls.options', JSON.stringify(b));
    res.json(tlsStatus());
  })
);

hostAdminApi.post(
  '/security/tls/acme',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const { token, actorId, actorName } = ctx(req);
    const domain = String(req.body?.domain ?? '');
    const job = startHostJob(
      'tls',
      `Requesting a Let’s Encrypt certificate for ${domain}`,
      actorName,
      async (onProgress) => {
        const r = await run(token, 'tls.certbot', { domain, email: String(req.body?.email ?? ''), staging: req.body?.staging === true, targetDir: TLS_DIR, owner: os.userInfo().username }, { timeoutMs: 6 * 60_000, onProgress });
        markAcme(r.domain);
        return r;
      },
      (done) => logAudit(actorId, actorName, `panel.tls.acme${done.state === 'failed' ? '.failed' : ''}`, undefined, domain)
    );
    res.status(202).json({ job });
  })
);

hostAdminApi.get('/security/tls', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...tlsStatus(), job: getHostJob('tls') });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

hostAdminApi.get(
  '/diagnostics',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ...(await diagnosticsOverview()), job: getHostJob('sos') });
  })
);

hostAdminApi.post(
  '/diagnostics/sos',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    const { token, actorId, actorName } = ctx(req);
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const job = startHostJob(
      'sos',
      'Collecting a diagnostic report',
      actorName,
      (onProgress) => run(token, 'sos.report', { targetDir: DIAG_DIR, owner: os.userInfo().username, label }, { timeoutMs: 65 * 60_000, onProgress }),
      (done) => logAudit(actorId, actorName, `host.sos.report${done.state === 'failed' ? '.failed' : ''}`, undefined, (done.result as { file?: string } | null)?.file ?? '')
    );
    res.status(202).json({ job });
  })
);

hostAdminApi.get('/diagnostics/job', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ job: getHostJob('sos') });
});

hostAdminApi.get('/diagnostics/reports/:name', (req, res, next) => {
  try {
    const file = reportPath(req.params.name);
    audit(req, 'host.sos.download', req.params.name);
    res.download(file, req.params.name);
  } catch (err) {
    next(err);
  }
});

hostAdminApi.delete('/diagnostics/reports/:name', (req, res, next) => {
  try {
    deleteReport(req.params.name);
    audit(req, 'host.sos.delete', req.params.name);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const kdumpChange = (path: string, op: Parameters<typeof runHostSystemOp>[1], action: string) =>
  hostAdminApi.post(
    path,
    asyncHandler(async (req, res) => {
      linuxOnly();
      requireAdminMode(req);
      const result = await run(ctx(req).token, op, (req.body ?? {}) as never);
      audit(req, action, JSON.stringify(req.body ?? {}));
      res.json({ result, overview: await diagnosticsOverview() });
    })
  );

kdumpChange('/diagnostics/kdump/service', 'kdump.service', 'host.kdump.service');
kdumpChange('/diagnostics/kdump/path', 'kdump.config', 'host.kdump.path');
kdumpChange('/diagnostics/kdump/reserve', 'kdump.reserve', 'host.kdump.reserve');

hostAdminApi.post(
  '/diagnostics/kdump/test',
  asyncHandler(async (req, res) => {
    linuxOnly();
    requireAdminMode(req);
    if (req.body?.confirm !== os.hostname()) throw new HttpError(400, `Type the host name (${os.hostname()}) to confirm`);
    audit(req, 'host.kdump.test', 'Kernel crash triggered to test kdump');
    await run(ctx(req).token, 'kdump.test', {});
    res.json({ crashing: true });
  })
);

// ---------------------------------------------------------------------------
// Local-only: whether linked panels may administer this host
// ---------------------------------------------------------------------------

export const hostLocalOnly = Router();

hostLocalOnly.get('/remote-access', (_req, res) => {
  res.json({ enabled: getSetting(REMOTE_ADMIN_SETTING) === '1' });
});

hostLocalOnly.put('/remote-access', (req, res) => {
  const enabled = req.body?.enabled === true;
  setSetting(REMOTE_ADMIN_SETTING, enabled ? '1' : '0');
  logAudit(req.auth!.sub, req.auth!.username, enabled ? 'host.remote.allow' : 'host.remote.deny', undefined, 'Linked panels administering this host');
  res.json({ enabled });
});
