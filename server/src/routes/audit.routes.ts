import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { prep } from '../db/db.js';

/** The audit log: who did what, newest first, with filters and "load more" paging. Admin only. */
export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('admin'));

interface AuditRow {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
  server_name: string | null;
  target_username: string | null;
  webhook_name: string | null;
}

const MAX_PAGE = 200;

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query;
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.limit) || 100));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (typeof q.before === 'string' && Number(q.before) > 0) {
      where.push('a.id < ?');
      params.push(Number(q.before));
    }
    if (typeof q.user === 'string' && q.user) {
      where.push('a.username = ?');
      params.push(q.user);
    }
    if (typeof q.action === 'string' && q.action) {
      // "backup" matches backup.create, backup.restore… ; a full name matches exactly.
      where.push("(a.action = ? OR a.action LIKE ? ESCAPE '\\')");
      params.push(q.action, `${q.action.replace(/[\\%_]/g, '\\$&')}.%`);
    }
    if (typeof q.server === 'string' && q.server) {
      where.push('a.target = ?');
      params.push(q.server);
    }
    if (typeof q.search === 'string' && q.search.trim()) {
      const like = `%${q.search.trim().replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(a.detail LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    const rows = prep(
      `SELECT a.*, s.name AS server_name, u.username AS target_username, w.name AS webhook_name
       FROM audit_log a
       LEFT JOIN servers s ON s.id = a.target
       LEFT JOIN users u ON u.id = a.target
       LEFT JOIN webhooks w ON w.id = a.target
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.id DESC
       LIMIT ?`
    ).all(...params, limit + 1) as unknown as AuditRow[];

    const page = rows.slice(0, limit);
    res.json({
      entries: page.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        action: r.action,
        target: r.target,
        targetLabel: r.server_name ?? r.target_username ?? r.webhook_name ?? null,
        targetKind: r.server_name ? 'server' : r.target_username ? 'user' : r.webhook_name ? 'webhook' : null,
        detail: r.detail,
        // SQLite's datetime('now') is UTC without a zone marker.
        at: `${r.created_at.replace(' ', 'T')}Z`,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    });
  })
);

/** Values for the filter dropdowns. */
auditRouter.get(
  '/facets',
  asyncHandler(async (_req, res) => {
    const actions = (prep('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[]).map((r) => r.action);
    const users = (prep('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY username').all() as { username: string }[]).map(
      (r) => r.username
    );
    res.json({ actions, users });
  })
);
