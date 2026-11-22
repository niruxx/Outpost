import { DatabaseSync } from 'node:sqlite';
import { workerData } from 'node:worker_threads';

// A separate connection in a worker keeps the main event loop free during the SQLite copy and
// reads a consistent database including committed WAL contents. Never archive the live WAL/SHM.
const { source, target, instanceIds, includeFiles, includeSnapshots } = workerData as {
  source: string; target: string; instanceIds: string[] | null; includeFiles: boolean; includeSnapshots: boolean;
};
const live = new DatabaseSync(source, { readOnly: true });
try {
  live.exec('PRAGMA busy_timeout = 5000');
  live.prepare('VACUUM INTO ?').run(target);
} finally { live.close(); }

const copy = new DatabaseSync(target);
try {
  copy.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; BEGIN');
  if (instanceIds !== null) {
    copy.exec('CREATE TEMP TABLE included_instances (id TEXT PRIMARY KEY)');
    const include = copy.prepare('INSERT INTO included_instances VALUES (?)');
    for (const id of instanceIds) include.run(id);
    const excluded = 'SELECT id FROM servers WHERE id NOT IN (SELECT id FROM included_instances)';
    const instanceTables = copy.prepare(`
      SELECT m.name FROM sqlite_schema AS m
      WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'server_id')
    `).all() as { name: string }[];
    for (const { name } of instanceTables) {
      copy.exec(`DELETE FROM "${name.replace(/"/g, '""')}" WHERE server_id IN (${excluded})`);
    }
    copy.exec(`DELETE FROM audit_log WHERE target IN (${excluded}); DELETE FROM servers WHERE id IN (${excluded})`);
  }
  if (!includeFiles) copy.exec("UPDATE servers SET auto_start = 0, status = 'stopped'");
  if (!includeSnapshots && copy.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'snapshot_metadata'").get()) {
    copy.exec('DELETE FROM snapshot_metadata');
  }
  copy.exec('COMMIT');
} finally { copy.close(); }
