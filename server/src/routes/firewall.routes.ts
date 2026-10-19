import { Router, type Request } from 'express';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { effectiveFirewallAccess, getUserServerAccess, logAudit } from '../services/userService.js';
import { listServers } from '../services/serverService.js';
import { instancePortProtocol } from '../services/portProtocol.js';
import { firewall, ruleOpens, sanitizeNewRule, type FirewallRule, type FirewallStatus, type NewRule } from '../services/firewallService.js';
import type { FirewallAccess } from '../types/index.js';

/**
 * Host firewall (UFW or firewalld). Access is per account: view, open/close only the ports of the
 * instances you can reach, or manage any port. Admins can always manage, and only admins can
 * switch the firewall on or off. Nobody can quietly cut off SSH or this panel: non-admins can't
 * touch those ports at all, and admins have to confirm.
 */
export const firewallRouter = Router();
firewallRouter.use(requireAuth);

function accessOf(req: Request): FirewallAccess {
  return effectiveFirewallAccess(req.auth!.sub, req.auth!.role);
}

function requireAccess(req: Request, needed: 'view' | 'change'): FirewallAccess {
  const access = accessOf(req);
  if (access === 'none') throw new HttpError(403, 'You don’t have access to the firewall');
  if (needed === 'change' && access === 'view') throw new HttpError(403, 'You can view the firewall but not change it');
  return access;
}

/** Instances this user can reach, with their main port. */
function instancePorts(req: Request) {
  const allowed = req.auth!.role === 'admin' ? null : new Set(getUserServerAccess(req.auth!.sub));
  return listServers()
    .filter((s) => !allowed || allowed.has(s.id))
    .map((s) => ({ serverId: s.id, name: s.name, port: s.server_port, protocol: instancePortProtocol(s) }));
}

const covers = (port: string, p: number) => {
  const [a, b] = port.split('-').map(Number);
  return p >= a && p <= (b ?? a);
};

/** "Instance ports only": the rule must be exactly one of the user's instance ports. */
function checkInstanceScope(req: Request, port: string | null) {
  const ok = !!port && !port.includes('-') && instancePorts(req).some((i) => String(i.port) === port);
  if (!ok) throw new HttpError(403, 'Your firewall access only covers the ports of instances you can manage');
}

function protectedHit(status: FirewallStatus, port: string | null, protocol: string) {
  if (!port || protocol === 'udp') return null;
  return status.protectedPorts.find((p) => covers(port, p.port)) ?? null;
}

firewallRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const access = requireAccess(req, 'view');
    const status = await firewall.status();
    const ports = instancePorts(req).map((i) => ({
      ...i,
      // An inactive firewall (or a default-allow policy) lets everything through.
      open: !status.active || /allow \(incoming\)/.test(status.defaults ?? '') || status.rules.some((r) => ruleOpens(r, i.port, i.protocol)),
    }));
    res.json({ status, access, isAdmin: req.auth!.role === 'admin', instancePorts: ports });
  })
);

firewallRouter.post(
  '/rules',
  asyncHandler(async (req, res) => {
    const access = requireAccess(req, 'change');
    const rule: NewRule = sanitizeNewRule(req.body);
    if (access === 'instances') checkInstanceScope(req, rule.port);
    if (rule.action === 'deny') {
      const status = await firewall.status();
      const hit = protectedHit(status, rule.port, rule.protocol);
      if (hit) {
        if (req.auth!.role !== 'admin') throw new HttpError(403, `Port ${hit.port} keeps ${hit.why} reachable — only an admin can block it`);
        if (req.body?.force !== true) throw new HttpError(409, `Blocking port ${hit.port} can cut off ${hit.why}. Confirm to do it anyway.`);
      }
    }
    await firewall.addRule(rule);
    logAudit(
      req.auth!.sub,
      req.auth!.username,
      `firewall.${rule.action}`,
      undefined,
      `${rule.port}/${rule.protocol}${rule.source ? ` from ${rule.source}` : ''}${rule.comment ? ` (${rule.comment})` : ''}`
    );
    res.status(201).json({ status: await firewall.status() });
  })
);

firewallRouter.post(
  '/rules/delete',
  asyncHandler(async (req, res) => {
    const access = requireAccess(req, 'change');
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const status = await firewall.status();
    const rule = status.rules.find((r) => r.id === id);
    if (!rule) throw new HttpError(404, 'That rule no longer exists — refresh the list');
    if (access === 'instances') checkInstanceScope(req, rule.port);

    // Removing the last rule that keeps SSH or the panel open would lock people out.
    const lockout = status.active
      ? status.protectedPorts.find(
          (p) =>
            (ruleOpens(rule, p.port, 'tcp') || (p.why === 'SSH' && /OpenSSH|service ssh/.test(rule.label ?? ''))) &&
            !status.rules.some((other) => other.id !== rule.id && ruleOpens(other, p.port, 'tcp'))
        )
      : undefined;
    if (lockout) {
      if (req.auth!.role !== 'admin') throw new HttpError(403, `This rule keeps ${lockout.why} (port ${lockout.port}) reachable — only an admin can remove it`);
      if (req.body?.force !== true) throw new HttpError(409, `This is the only rule keeping ${lockout.why} (port ${lockout.port}) reachable. Confirm to remove it anyway.`);
    }
    await firewall.deleteRule(id);
    logAudit(req.auth!.sub, req.auth!.username, 'firewall.delete', undefined, describe(rule));
    res.json({ status: await firewall.status() });
  })
);

firewallRouter.post(
  '/enabled',
  asyncHandler(async (req, res) => {
    if (req.auth!.role !== 'admin') throw new HttpError(403, 'Only admins can switch the firewall on or off');
    const enabled = req.body?.enabled === true;
    const added = await firewall.setEnabled(enabled);
    logAudit(req.auth!.sub, req.auth!.username, enabled ? 'firewall.enable' : 'firewall.disable', undefined, added.length ? `also allowed ${added.join(', ')}` : undefined);
    res.json({ status: await firewall.status(), added });
  })
);

function describe(rule: FirewallRule): string {
  const what = rule.port ? `${rule.port}/${rule.protocol}` : rule.label ?? 'rule';
  return `${rule.action} ${what}${rule.source ? ` from ${rule.source}` : ''}`;
}
