import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminNotice, HostLayout, fmtTime } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import { hostApi, useHostAdmin } from '../state/hostTarget.js';

interface PasswordInfo {
  locked: boolean;
  hasPassword: boolean;
  lastChange: string | null;
  maxDays: number | null;
  expires: string | null;
  mustChange: boolean;
}

interface HostUser {
  name: string;
  uid: number;
  gecos: string;
  home: string;
  shell: string;
  system: boolean;
  root: boolean;
  primaryGroup: string;
  groups: string[];
  admin: boolean;
  canLogin: boolean;
  lastLogin: { at: string; from: string | null } | null;
  sessions: number;
  password: PasswordInfo | null;
}

interface HostGroup {
  name: string;
  gid: number;
  members: string[];
  system: boolean;
}

interface Session {
  id: string;
  user: string;
  tty: string | null;
  remoteHost: string | null;
  service: string | null;
  since: string | null;
  state: string | null;
  type: string | null;
}

interface AccountsData {
  available: boolean;
  reason: string | null;
  serviceUser?: string;
  uidMin?: number;
  adminGroup?: string | null;
  shells?: string[];
  policy?: { maxDays: number | null; minDays: number | null; warnAge: number | null; minLength: number | null };
  users?: HostUser[];
  groups?: HostGroup[];
  sessions?: Session[];
  passwordInfo?: boolean;
}

export function HostAccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const adminMode = useHostAdmin().active;
  const [data, setData] = useState<AccountsData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'users' | 'groups' | 'sessions'>('users');
  const [showSystem, setShowSystem] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<HostUser | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<AccountsData>(hostApi('/accounts')));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load accounts');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, adminMode]);

  const users = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.users ?? []).filter((u) => (showSystem || !u.system) && (!q || u.name.includes(q) || u.gecos.toLowerCase().includes(q)));
  }, [data, showSystem, query]);

  async function terminate(s: Session) {
    const ok = await confirm({ title: 'End session', message: `Log ${s.user} out of session ${s.id}${s.remoteHost ? ` from ${s.remoteHost}` : ''}? Their programs in that session are stopped.`, confirmLabel: 'End session', tone: 'danger' });
    if (!ok) return;
    try {
      await api.delete(hostApi(`/accounts/sessions/${encodeURIComponent(s.id)}`));
      toast.success('Session ended');
      void load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t end the session');
    }
  }

  const dis = !adminMode;
  const title = adminMode ? undefined : 'Turn on Admin Mode first';

  return (
    <HostLayout
      action={
        data?.available &&
        tab === 'users' && (
          <Button variant="primary" onClick={() => setCreating(true)} disabled={dis} title={title}>
            <Icon name="plus" className="h-4 w-4" /> New account
          </Button>
        )
      }
    >
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : !data.available ? (
        <Notice tone="warning">{data.reason}</Notice>
      ) : (
        <>
          <AdminNotice active={adminMode} what="create, lock or change accounts and see password status" />
          <div className="inline-flex gap-1 rounded-full border border-surface-700 bg-surface-900 p-1">
            {(
              [
                ['users', `Users (${data.users!.filter((u) => !u.system).length})`],
                ['groups', `Groups`],
                ['sessions', `Sessions (${data.sessions!.length})`],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-full px-4 py-1.5 text-sm font-medium ${tab === id ? 'bg-secondary-container text-secondary-on-container' : 'text-ink-400 hover:text-ink-100'}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'users' && (
            <Card className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <Input className="max-w-xs" placeholder="Filter accounts…" value={query} onChange={(e) => setQuery(e.target.value)} />
                <label className="flex items-center gap-2 text-sm text-ink-300">
                  <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Show system accounts
                </label>
              </div>
              <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                {users.map((u) => (
                  <button key={u.name} type="button" onClick={() => setSelected(u)} className="state-layer flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-100">
                        <span className="font-mono">{u.name}</span>
                        {u.gecos && <span className="text-ink-400">{u.gecos}</span>}
                      </p>
                      <p className="text-xs text-ink-500">
                        uid {u.uid} · {u.shell}
                        {u.lastLogin ? ` · last login ${fmtTime(u.lastLogin.at)}${u.lastLogin.from ? ` from ${u.lastLogin.from}` : ''}` : ''}
                      </p>
                    </div>
                    {u.name === data.serviceUser && <Badge tone="blue">Outpost</Badge>}
                    {u.root && <Badge tone="red">root</Badge>}
                    {u.admin && <Badge tone="yellow">Administrator</Badge>}
                    {u.system && !u.root && <Badge tone="neutral">System</Badge>}
                    {u.password?.locked && <Badge tone="red">Locked</Badge>}
                    {u.password?.mustChange && <Badge tone="yellow">Must change password</Badge>}
                    {u.sessions > 0 && <Badge tone="green">Logged in</Badge>}
                  </button>
                ))}
              </div>
              {data.policy && (
                <p className="text-xs text-ink-500">
                  Defaults from /etc/login.defs: passwords expire after {data.policy.maxDays && data.policy.maxDays < 99999 ? `${data.policy.maxDays} days` : 'never'}
                  {data.policy.minLength ? `, minimum length ${data.policy.minLength}` : ''}. Administrators are members of “{data.adminGroup ?? 'sudo/wheel'}”.
                </p>
              )}
            </Card>
          )}

          {tab === 'groups' && <GroupsTab data={data} adminMode={adminMode} onChanged={load} />}

          {tab === 'sessions' && (
            <Card className="p-5">
              <CardTitle>Login sessions</CardTitle>
              {data.sessions!.length === 0 ? (
                <p className="text-sm text-ink-500">Nobody is logged in.</p>
              ) : (
                <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
                  {data.sessions!.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink-100">
                          <span className="font-mono">{s.user}</span> <span className="text-ink-500">session {s.id}</span>
                        </p>
                        <p className="text-xs text-ink-500">{[s.service, s.tty, s.remoteHost && `from ${s.remoteHost}`, s.since && `since ${fmtTime(s.since)}`].filter(Boolean).join(' · ')}</p>
                      </div>
                      {s.state && <Badge tone={s.state === 'active' ? 'green' : 'neutral'}>{s.state}</Badge>}
                      <Button variant="danger" onClick={() => void terminate(s)} disabled={dis || s.user === data.serviceUser} title={title}>
                        End
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {selected && data?.available && (
        <UserModal
          user={data.users!.find((u) => u.name === selected.name) ?? selected}
          data={data}
          adminMode={adminMode}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
      {creating && data?.available && <CreateUserModal data={data} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
    </HostLayout>
  );
}

function CreateUserModal({ data, onClose, onCreated }: { data: AccountsData; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ username: '', fullName: '', shell: data.shells?.includes('/bin/bash') ? '/bin/bash' : data.shells?.[0] ?? '/bin/sh', password: '', confirm: '', admin: false, forceChange: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onClose} title="New account">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (form.password !== form.confirm) return setError('The passwords don’t match');
          setBusy(true);
          setError('');
          try {
            await api.post(hostApi('/accounts/users'), { username: form.username, fullName: form.fullName, shell: form.shell, password: form.password || undefined, admin: form.admin, forceChange: form.forceChange && !!form.password });
            toast.success(`Created ${form.username}`);
            onCreated();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Couldn’t create the account');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="User name">
            <Input value={form.username} onChange={(e) => set('username', e.target.value.toLowerCase())} autoFocus required pattern="[a-z_][a-z0-9_.\-]*" />
          </Field>
          <Field label="Full name">
            <Input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
          </Field>
        </div>
        <Field label="Shell">
          <Select value={form.shell} onChange={(e) => set('shell', e.target.value)}>
            {[...new Set([...(data.shells ?? []), '/usr/sbin/nologin'])].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password (empty = key-only login)">
            <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} />
          </Field>
          <Field label="Confirm password">
            <Input type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={form.admin} onChange={(e) => set('admin', e.target.checked)} /> Server administrator (member of {data.adminGroup ?? 'sudo/wheel'})
        </label>
        {form.password && (
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" checked={form.forceChange} onChange={(e) => set('forceChange', e.target.checked)} /> Must change the password at first login
          </label>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !form.username}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function UserModal({ user, data, adminMode, onClose, onChanged }: { user: HostUser; data: AccountsData; adminMode: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const editable = !user.system && !user.root && user.name !== data.serviceUser;
  const [fullName, setFullName] = useState(user.gecos);
  const [shell, setShell] = useState(user.shell);
  const [groups, setGroups] = useState(user.groups.filter((g) => g !== data.adminGroup).join(' '));
  const [password, setPassword] = useState('');
  const [expireDate, setExpireDate] = useState(user.password?.expires ?? '');
  const [maxDays, setMaxDays] = useState(user.password?.maxDays?.toString() ?? '');
  const [keys, setKeys] = useState<string | null>(null);
  const [keysError, setKeysError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!adminMode || user.root) return;
    api
      .get<{ content: string }>(hostApi(`/accounts/users/${encodeURIComponent(user.name)}/keys`))
      .then((r) => setKeys(r.content))
      .catch((err) => setKeysError(err instanceof ApiError ? err.message : 'Couldn’t read the keys'));
  }, [adminMode, user.name, user.root]);

  async function patch(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      await api.patch(hostApi(`/accounts/users/${encodeURIComponent(user.name)}`), body);
      toast.success(done);
      await onChanged();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    let removeHome = false;
    const ok = await confirm({
      title: `Delete ${user.name}?`,
      message: (
        <div className="space-y-3">
          <p>The account is deleted and its running programs are stopped.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" onChange={(e) => (removeHome = e.target.checked)} /> Also delete {user.home} and the mail spool
          </label>
        </div>
      ),
      confirmLabel: 'Delete account',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(hostApi(`/accounts/users/${encodeURIComponent(user.name)}${removeHome ? '?removeHome=1' : ''}`));
      toast.success(`Deleted ${user.name}`);
      await onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t delete the account');
    }
  }

  async function saveKeys() {
    setBusy(true);
    setKeysError('');
    try {
      const r = await api.put<{ keys: number }>(hostApi(`/accounts/users/${encodeURIComponent(user.name)}/keys`), { content: keys ?? '' });
      toast.success(`Saved ${r.keys} key${r.keys === 1 ? '' : 's'}`);
    } catch (err) {
      setKeysError(err instanceof ApiError ? err.message : 'Couldn’t save the keys');
    } finally {
      setBusy(false);
    }
  }

  const dis = !adminMode || busy || !editable;
  return (
    <Modal open onClose={onClose} title={user.name} size="lg">
      <div className="space-y-5">
        {!editable && (
          <Notice tone="info">
            {user.name === data.serviceUser ? 'This is the account Outpost runs as; changing it here could cut the panel off.' : user.root ? 'root can’t be changed here.' : 'System accounts belong to installed software and can’t be changed here.'}
          </Notice>
        )}
        {user.password && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone={user.password.locked ? 'red' : 'green'}>{user.password.locked ? 'Locked' : 'Active'}</Badge>
            <Badge tone="neutral">{user.password.hasPassword ? `Password set${user.password.lastChange ? ` ${user.password.lastChange}` : ''}` : 'No password (key-only)'}</Badge>
            {user.password.expires && <Badge tone="yellow">Account expires {user.password.expires}</Badge>}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={!editable} />
          </Field>
          <Field label="Shell">
            <Select value={shell} onChange={(e) => setShell(e.target.value)} disabled={!editable}>
              {[...new Set([...(data.shells ?? []), '/usr/sbin/nologin', user.shell])].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Other groups (space-separated)">
          <Input value={groups} onChange={(e) => setGroups(e.target.value)} disabled={!editable} list="host-groups" />
        </Field>
        <datalist id="host-groups">
          {(data.groups ?? []).map((g) => (
            <option key={g.name} value={g.name} />
          ))}
        </datalist>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={dis}
            onClick={() => void patch({ fullName, shell, groups: groups.split(/[\s,]+/).filter(Boolean), admin: user.admin }, 'Saved')}
          >
            Save
          </Button>
          <Button variant="outlined" disabled={dis || !data.adminGroup} onClick={() => void patch({ admin: !user.admin }, user.admin ? 'Administrator rights removed' : 'Now an administrator')}>
            {user.admin ? 'Remove administrator' : 'Make administrator'}
          </Button>
          <Button variant="outlined" disabled={dis} onClick={() => void patch({ locked: !user.password?.locked }, user.password?.locked ? 'Unlocked' : 'Locked')}>
            {user.password?.locked ? 'Unlock' : 'Lock account'}
          </Button>
          <Button variant="danger" disabled={dis} onClick={() => void remove()}>
            Delete
          </Button>
        </div>

        <div className="space-y-3 rounded-2xl bg-surface-900 p-4">
          <p className="text-sm font-medium text-ink-200">Password</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New password">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!editable} />
            </Field>
            <Button disabled={dis || !password} onClick={async () => { if (await patch({ password }, 'Password changed')) setPassword(''); }}>
              Set
            </Button>
            <Button variant="ghost" disabled={dis} onClick={() => void patch({ forceChange: true }, 'Must change at next login')}>
              Require change at next login
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Password expires after (days, empty = never)">
              <Input type="number" min={1} value={maxDays} onChange={(e) => setMaxDays(e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Account expires on (empty = never)">
              <Input type="date" value={expireDate} onChange={(e) => setExpireDate(e.target.value)} disabled={!editable} />
            </Field>
            <Button disabled={dis} onClick={() => void patch({ maxDays: maxDays ? Number(maxDays) : null, expireDate: expireDate || null }, 'Expiry saved')}>
              Save expiry
            </Button>
          </div>
        </div>

        {!user.root && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-200">SSH authorized keys</p>
            {!adminMode ? (
              <p className="text-xs text-ink-500">Turn on Admin Mode to view and edit {user.name}’s keys.</p>
            ) : keys === null && !keysError ? (
              <Spinner />
            ) : (
              <>
                <textarea
                  className="ui-input h-40 w-full rounded-lg border border-surface-500 bg-transparent px-3 py-2 font-mono text-xs text-ink-100"
                  value={keys ?? ''}
                  onChange={(e) => setKeys(e.target.value)}
                  placeholder="ssh-ed25519 AAAA… user@laptop"
                  spellCheck={false}
                />
                <ErrorText>{keysError}</ErrorText>
                <Button disabled={busy || keys === null} onClick={() => void saveKeys()}>
                  Save keys
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function GroupsTab({ data, adminMode, onChanged }: { data: AccountsData; adminMode: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [showSystem, setShowSystem] = useState(false);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState<Record<string, string>>({});

  async function call(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
    }
  }

  const groups = (data.groups ?? []).filter((g) => showSystem || !g.system || g.name === data.adminGroup);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="New group">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="gameservers" />
        </Field>
        <Button disabled={!adminMode || !name} onClick={() => void call(() => api.post(hostApi('/accounts/groups'), { name }), `Created ${name}`).then(() => setName(''))}>
          Create
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Show system groups
        </label>
      </div>
      <div className="divide-y divide-surface-700 overflow-hidden rounded-2xl bg-surface-900">
        {groups.map((g) => (
          <div key={g.name} className="flex flex-wrap items-center gap-2 px-4 py-3">
            <span className="w-40 truncate font-mono text-sm text-ink-100">{g.name}</span>
            <span className="text-xs text-ink-500">gid {g.gid}</span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {g.members.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={!adminMode || m === data.serviceUser}
                  onClick={async () => {
                    if (await confirm({ title: 'Remove member', message: `Remove ${m} from ${g.name}?`, confirmLabel: 'Remove', tone: 'danger' }))
                      void call(() => api.post(hostApi(`/accounts/groups/${encodeURIComponent(g.name)}/members`), { remove: [m] }), `Removed ${m}`);
                  }}
                  className="rounded-lg bg-surface-700 px-2 py-0.5 text-xs text-ink-200 enabled:hover:bg-red-500/20"
                  title={adminMode ? `Remove ${m}` : undefined}
                >
                  {m}
                </button>
              ))}
            </div>
            {adminMode && (
              <>
                <Input className="w-32" placeholder="add user" value={adding[g.name] ?? ''} onChange={(e) => setAdding((a) => ({ ...a, [g.name]: e.target.value }))} list="host-users" />
                <Button
                  variant="ghost"
                  disabled={!adding[g.name]}
                  onClick={() => void call(() => api.post(hostApi(`/accounts/groups/${encodeURIComponent(g.name)}/members`), { add: [adding[g.name]] }), `Added ${adding[g.name]}`).then(() => setAdding((a) => ({ ...a, [g.name]: '' })))}
                >
                  Add
                </Button>
                {!g.system && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: 'Delete group', message: `Delete the group ${g.name}?`, confirmLabel: 'Delete', tone: 'danger' }))
                        void call(() => api.delete(hostApi(`/accounts/groups/${encodeURIComponent(g.name)}`)), `Deleted ${g.name}`);
                    }}
                  >
                    <Icon name="trash" className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <datalist id="host-users">
        {(data.users ?? []).filter((u) => !u.system).map((u) => (
          <option key={u.name} value={u.name} />
        ))}
      </datalist>
    </Card>
  );
}
