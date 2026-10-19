import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import type { PublicUser } from '../api/types.js';
import { THEMES } from '../lib/theme.js';
import { Button, Select, Spinner } from './ui.js';
import { useToast } from './Toast.js';

const OWN_CHOICE = '';

/** Admin: give accounts a theme. It's applied on their next page load or sign-in; they can still switch after. */
export function UserThemesPanel() {
  const toast = useToast();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(OWN_CHOICE);

  useEffect(() => {
    api
      .get<{ users: PublicUser[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch((err) => toast.error(err instanceof ApiError ? err.message : 'Failed to load users'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function assign(user: PublicUser, theme: string) {
    setSavingId(user.id);
    try {
      await api.patch(`/users/${user.id}`, { theme: theme || null });
      setUsers((list) => list?.map((u) => (u.id === user.id ? { ...u, theme: theme || null } : u)) ?? null);
      toast.success(theme ? `${user.username} gets ${THEMES.find((t) => t.id === theme)?.label}` : `${user.username} picks their own theme`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
    }
  }

  async function assignAll() {
    if (!users) return;
    setSavingId('*');
    try {
      for (const u of users) await api.patch(`/users/${u.id}`, { theme: everyone || null });
      setUsers(users.map((u) => ({ ...u, theme: everyone || null })));
      toast.success(everyone ? `Everyone gets ${THEMES.find((t) => t.id === everyone)?.label}` : 'Everyone picks their own theme');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
    }
  }

  const options = (
    <>
      <option value={OWN_CHOICE}>Their own choice</option>
      {THEMES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </>
  );

  return (
    <div className="mt-6 border-t border-surface-700 pt-5">
      <p className="text-sm font-medium text-ink-100">Themes for other users</p>
      <p className="mb-3 text-xs text-ink-400">Applied on their next page load or sign-in. They can still switch afterwards, until you change it again.</p>
      {!users ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
            {users.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-100">
                  {u.username} <span className="text-xs text-ink-500">· {u.role}</span>
                </span>
                <div className="w-full sm:w-64">
                  <Select value={u.theme ?? OWN_CHOICE} disabled={savingId !== null} onChange={(e) => assign(u, e.target.value)} aria-label={`Theme for ${u.username}`}>
                    {options}
                  </Select>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-400">Set everyone to</span>
            <div className="w-full sm:w-56">
              <Select value={everyone} onChange={(e) => setEveryone(e.target.value)} aria-label="Theme for everyone">
                {options}
              </Select>
            </div>
            <Button disabled={savingId !== null} onClick={assignAll}>
              {savingId === '*' ? 'Applying…' : 'Apply to all'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
