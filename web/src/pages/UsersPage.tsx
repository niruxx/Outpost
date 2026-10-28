import { useEffect, useState } from 'react';
import { Layout, PageHeader } from '../components/Layout.js';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Select } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import type { CreatablePlatform, CreationPolicy, FirewallAccess, PublicUser, Role, ServerPermission, ServerRecord } from '../api/types.js';
import { GameTile, gameKindOf } from '../components/GameArt.js';
import { useAuth } from '../state/AuthContext.js';
import { THEMES } from '../lib/theme.js';
import type { StoragePermission } from '../api/types.js';

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<PublicUser | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  async function load() {
    try {
      const [usersRes, serversRes] = await Promise.all([
        api.get<{ users: PublicUser[] }>('/users'),
        api.get<{ servers: ServerRecord[] }>('/servers'),
      ]);
      setUsers(usersRes.users);
      setServers(serversRes.servers);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load users');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deleteUser(user: PublicUser) {
    const ok = await confirm({
      title: 'Delete user',
      message: `Delete user "${user.username}"? This cannot be undone.`,
      confirmLabel: 'Delete user',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/users/${user.id}`);
      toast.success(`Deleted "${user.username}"`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete user');
    }
  }

  async function resetTwoFactor(user: PublicUser) {
    const ok = await confirm({
      title: 'Reset two-factor sign-in',
      message: `Turn off two-factor sign-in for "${user.username}"? They'll sign in with just their password and can set it up again from Configuration.`,
      confirmLabel: 'Reset 2FA',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/users/${user.id}/2fa`);
      toast.success(`Two-factor sign-in reset for "${user.username}"`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reset two-factor sign-in');
    }
  }

  return (
    <Layout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <PageHeader
          title="Users"
          subtitle="Manage panel accounts and per-instance access."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              + New user
            </Button>
          }
        />

        {users === null ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : (
          <Card className="divide-y divide-surface-800">
            {users.map((u, i) => (
              <div
                key={u.id}
                style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}
                className="animate-fade-in-up flex items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink-100">{u.username}</span>
                    <Badge tone={u.role === 'admin' ? 'green' : u.role === 'moderator' ? 'blue' : 'neutral'}>{u.role}</Badge>
                    {u.totp_enabled ? <Badge tone="neutral">2FA</Badge> : null}
                    {u.theme ? <Badge tone="neutral">{THEMES.find((t) => t.id === u.theme)?.label ?? u.theme} theme</Badge> : null}
                  </div>
                  {u.role !== 'admin' && (
                    <p className="mt-0.5 text-xs text-ink-500">
                      {u.serverAccess && u.serverAccess.length > 0
                        ? `Access to ${u.serverAccess.length} instance(s)`
                        : 'No instance access granted'}
                      {' · '}
                      {u.effectiveCreation?.canCreate
                        ? `can create${u.effectiveCreation.maxInstances ? ` (owns ${u.owned ?? 0}/${u.effectiveCreation.maxInstances})` : u.owned ? ` (owns ${u.owned})` : ''}`
                        : 'cannot create instances'}
                    </p>
                  )}
                </div>
                <Button
                  onClick={() => {
                    setEditingUser(u);
                    setEditOpen(true);
                  }}
                >
                  Edit
                </Button>
                {u.totp_enabled && u.id !== me?.id ? (
                  <Button variant="ghost" onClick={() => resetTwoFactor(u)} title="For someone who lost their authenticator and recovery codes">
                    Reset 2FA
                  </Button>
                ) : null}
                {u.id !== me?.id && (
                  <Button variant="danger" onClick={() => deleteUser(u)}>
                    Delete
                  </Button>
                )}
              </div>
            ))}
          </Card>
        )}

      </div>

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={load} />
      <EditUserModal
        open={editOpen}
        user={editingUser}
        servers={servers}
        onClose={() => setEditOpen(false)}
        onSaved={load}
      />
    </Layout>
  );
}

function CreateUserModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError('');
    setSubmitting(true);
    try {
      await api.post('/users', { username, password, role });
      toast.success(`Created user "${username}"`);
      onSaved();
      onClose();
      setUsername('');
      setPassword('');
      setRole('viewer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create user">
      <div className="space-y-4">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin — full access</option>
            <option value="moderator">Moderator — manage assigned instances</option>
            <option value="viewer">Viewer — read-only on assigned instances</option>
          </Select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditUserModal({
  open,
  user,
  servers,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: PublicUser | null;
  servers: ServerRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  // Assigned instances → explicit permission set, or null for the role's defaults.
  const [access, setAccess] = useState<Record<string, ServerPermission[] | null>>({});
  // null = follow the role's default creation policy
  const [configAccess, setConfigAccess] = useState<Record<string, Record<string, boolean>>>({});
  const [creation, setCreation] = useState<CreationPolicy | null>(null);
  const [firewall, setFirewall] = useState<FirewallAccess>('none');
  const [storagePermissions, setStoragePermissions] = useState<StoragePermission[]>([]);
  const [theme, setTheme] = useState<string>('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Re-sync local form state whenever a (possibly different) user is opened for editing.
  useEffect(() => {
    if (!user) return;
    setConfigAccess(user.configAccess ?? {});
    setRole(user.role);
    setFirewall(user.firewall ?? 'none');
    setStoragePermissions(user.storagePermissions ?? []);
    setTheme(user.theme ?? '');
    setPassword('');
    setAccess(Object.fromEntries((user.serverAccess ?? []).map((id) => [id, user.serverPermissions?.[id] ?? null])));
    setCreation(user.creationPolicy ?? null);
    setError('');
  }, [user]);

  async function submit() {
    if (!user) return;
    setError('');
    setSubmitting(true);
    try {
      await api.patch(`/users/${user.id}`, {
        role,
        password: password || undefined,
        serverAccess: Object.entries(access).map(([serverId, permissions]) => ({ serverId, permissions, configAccess: configAccess[serverId] ?? {} })),
        theme: theme || null,
        ...(role === 'admin' ? {} : { creation, firewall, storagePermissions }),
      });
      toast.success(`Updated "${user.username}"`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update user');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={user ? `Edit ${user.username}` : 'Edit user'} size="lg">
      <div className="space-y-4">
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin — full access</option>
            <option value="moderator">Moderator — manage assigned instances</option>
            <option value="viewer">Viewer — read-only on assigned instances</option>
          </Select>
        </Field>
        <Field label="Theme when they sign in">
          <Select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="">Their own choice (whatever their browser last used)</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="New password (leave blank to keep current)">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
        </Field>
        {role !== 'admin' && (
          <Field label="Host firewall">
            <Select value={firewall} onChange={(e) => setFirewall(e.target.value as FirewallAccess)}>
              <option value="none">No access</option>
              <option value="view">View rules</option>
              <option value="instances">Open & close their instances’ ports</option>
              <option value="manage">Manage any port (except SSH and Outpost’s own)</option>
            </Select>
          </Field>
        )}
        {role !== 'admin' && <CreationEditor role={role} value={creation} onChange={setCreation} owned={user?.owned ?? 0} />}
        {role !== 'admin' && <div className="space-y-3 rounded-2xl bg-surface-850 p-4">
          <p className="text-xs font-medium text-ink-300">Host storage permissions</p>
          <p className="text-xs text-ink-500">Host-wide disk access, separate from instance permissions. Administrators have every permission by default. Formatting, wiping and partitioning destroy data.</p>
          <div className="flex flex-wrap gap-3">{([
            ['view', 'View disks'], ['mount', 'Mount / unmount'], ['automount', 'Boot mounts (fstab)'], ['format', 'Format filesystems'], ['wipe', 'Wipe signatures'], ['partition', 'Initialize GPT partitions'], ['encrypt', 'LUKS encryption / passphrases'], ['lvm', 'LVM management'], ['resize', 'Resize storage'],
          ] as [StoragePermission, string][]).map(([permission, label]) => <label key={permission} className="flex items-center gap-2 text-xs text-ink-200">
            <input type="checkbox" checked={storagePermissions.includes(permission)} onChange={(e) => setStoragePermissions((current) => e.target.checked ? [...current, permission] : current.filter((item) => item !== permission))} />{label}
          </label>)}</div>
          <p className="text-xs text-ink-500">Any change permission also grants disk viewing. Grant these only to trusted host operators.</p>
        </div>}
        {role !== 'admin' && <AccessEditor role={role} servers={servers} access={access} onChange={setAccess} configAccess={configAccess} onConfigChange={setConfigAccess} />}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const PERMISSION_GROUPS: { label: string; items: { key: ServerPermission; label: string }[] }[] = [
  {
    label: 'Control',
    items: [
      { key: 'power', label: 'Start / stop' },
      { key: 'console', label: 'Console commands' },
      { key: 'players', label: 'Manage players' },
    ],
  },
  {
    label: 'Files',
    items: [
      { key: 'files.read', label: 'View & download' },
      { key: 'files.write', label: 'Edit & upload' },
      { key: 'plugins', label: 'Plugins / mods' },
    ],
  },
  {
    label: 'Snapshots',
    items: [
      { key: 'backups.create', label: 'Create & schedule' },
      { key: 'backups.restore', label: 'Restore' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { key: 'settings', label: 'Edit configuration' },
      { key: 'update', label: 'Update version' },
      { key: 'launch', label: 'Edit launch command' },
      { key: 'network', label: 'UPnP port forwarding' },
    ],
  },
];

const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

function roleDefaults(role: Role): ServerPermission[] {
  // 'launch' runs any program on the host and 'network' opens router ports to it — never on by default.
  return role === 'viewer' ? ['files.read'] : ALL_PERMISSIONS.filter((p) => p !== 'launch' && p !== 'network');
}

/** Pick any number of instances; each gets the role's defaults or its own permission set. */
function AccessEditor({
  role,
  servers,
  access,
  onChange,
  configAccess,
  onConfigChange,
}: {
  configAccess: Record<string, Record<string, boolean>>;
  onConfigChange: (next: Record<string, Record<string, boolean>>) => void;
  role: Role;
  servers: ServerRecord[];
  access: Record<string, ServerPermission[] | null>;
  onChange: (next: Record<string, ServerPermission[] | null>) => void;
}) {
  const assigned = Object.keys(access).length;

  function toggleAssigned(id: string, on: boolean) {
    const next = { ...access };
    if (on) next[id] = null;
    else delete next[id];
    onChange(next);
  }

  function togglePermission(id: string, perm: ServerPermission) {
    const current = access[id] ?? roleDefaults(role);
    const nextPerms = current.includes(perm) ? current.filter((p) => p !== perm) : [...current, perm];
    onChange({ ...access, [id]: nextPerms });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-300">Instance access</span>
        <span className="text-xs text-ink-500">
          {assigned} of {servers.length} assigned
        </span>
      </div>
      <div className="max-h-[45vh] space-y-2 overflow-y-auto">
        {servers.length === 0 && <p className="text-xs text-ink-500">No instances exist yet.</p>}
        {servers.map((s) => {
          const isAssigned = s.id in access;
          const custom = access[s.id];
          const effective = custom ?? roleDefaults(role);
          return (
            <div key={s.id} className={`rounded-2xl p-3 ${isAssigned ? 'bg-surface-700' : 'bg-surface-850'}`}>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={isAssigned} onChange={(e) => toggleAssigned(s.id, e.target.checked)} />
                <GameTile kind={gameKindOf(s)} className="h-8 w-8 !rounded-xl" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{s.name}</span>
                {isAssigned && (
                  <span className="text-xs text-ink-400">{custom ? 'Custom permissions' : `${role === 'viewer' ? 'Viewer' : 'Moderator'} defaults`}</span>
                )}
              </label>
              {isAssigned && (
                <div className="mt-3 space-y-2 pl-7">
                  {PERMISSION_GROUPS.map((g) => (
                    <div key={g.label} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-20 shrink-0 text-[11px] text-ink-500">{g.label}</span>
                      {g.items.map((item) => {
                        const on = effective.includes(item.key);
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => togglePermission(s.id, item.key)}
                            className={`state-layer rounded-lg border px-2.5 py-1 text-xs font-medium ${
                              on ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-400'
                            }`}
                          >
                            {on ? '✓ ' : ''}
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  <ConfigAccessEditor serverId={s.id} value={configAccess[s.id] ?? {}} onChange={(value) => onConfigChange({ ...configAccess, [s.id]: value })} />
                  {custom && (
                    <button type="button" className="text-xs text-accent-400 hover:underline" onClick={() => onChange({ ...access, [s.id]: null })}>
                      Reset to role defaults
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-500">
        Every assigned user can see the instance's status, console output and player list. Everything else needs the permission.
      </p>
    </div>
  );
}

const PLATFORM_LABEL: Record<CreatablePlatform, string> = { java: '⛏️ Minecraft Java', bedrock: '🪨 Bedrock', steam: '🎮 Steam games' };
const ALL_CREATABLE: CreatablePlatform[] = ['java', 'bedrock', 'steam'];

function roleCreation(role: Role): CreationPolicy {
  return role === 'viewer'
    ? { canCreate: false, platforms: [], maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false }
    : { canCreate: true, platforms: ALL_CREATABLE, maxInstances: 0, maxMemoryMb: 0, containers: 'none', engineSocket: false };
}

const CONTAINER_OPTIONS: { value: CreationPolicy['containers']; label: string; hint: string }[] = [
  { value: 'none', label: 'No containers', hint: '' },
  { value: 'catalog', label: '📦 Catalog apps only', hint: 'Only the templates in New instance → App from the catalog, with their images.' },
  { value: 'any', label: '🐳 Any image', hint: 'Any container image. Containers still only see their own folder and can’t use host ports below 1024.' },
];

/** May this user create instances — which kinds, how many, how big. New instances are owned by them. */
function CreationEditor({
  role,
  value,
  onChange,
  owned,
}: {
  role: Role;
  value: CreationPolicy | null;
  onChange: (v: CreationPolicy | null) => void;
  owned: number;
}) {
  const custom = value !== null;
  const effective = value ?? roleCreation(role);
  const set = (patch: Partial<CreationPolicy>) => onChange({ ...effective, ...patch });
  const summary = effective.canCreate
    ? `${effective.platforms.map((p) => PLATFORM_LABEL[p].split(' ').slice(1).join(' ')).join(', ') || 'nothing'}${
        effective.containers === 'any' ? ', any container' : effective.containers === 'catalog' ? ', catalog apps' : ''
      }${effective.maxInstances ? ` · up to ${effective.maxInstances}` : ' · no limit'}`
    : 'cannot create instances';

  return (
    <div className="rounded-2xl bg-surface-850 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-300">Instance creation</span>
        <span className="text-xs text-ink-500">Owns {owned} instance{owned === 1 ? '' : 's'}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <label className="flex items-center gap-2 text-ink-200">
          <input type="radio" checked={!custom} onChange={() => onChange(null)} />
          {role === 'viewer' ? 'Viewer' : 'Moderator'} default <span className="text-xs text-ink-500">({summary})</span>
        </label>
        <label className="flex items-center gap-2 text-ink-200">
          <input type="radio" checked={custom} onChange={() => onChange({ ...effective })} />
          Custom for this user
        </label>
      </div>
      {custom && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={effective.canCreate} onChange={(e) => set({ canCreate: e.target.checked, platforms: e.target.checked && !effective.platforms.length ? ALL_CREATABLE : effective.platforms })} />
            Can create new instances (they'll own them)
          </label>
          {effective.canCreate && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {ALL_CREATABLE.map((p) => {
                  const on = effective.platforms.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => set({ platforms: on ? effective.platforms.filter((x) => x !== p) : [...effective.platforms, p] })}
                      className={`state-layer rounded-lg border px-2.5 py-1 text-xs font-medium ${on ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-400'}`}
                    >
                      {on ? '✓ ' : ''}
                      {PLATFORM_LABEL[p]}
                    </button>
                  );
                })}
              </div>
              <div className="space-y-2">
                <span className="text-xs font-medium text-ink-300">Containers</span>
                <div className="flex flex-wrap gap-1.5">
                  {CONTAINER_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => set({ containers: o.value, engineSocket: o.value === 'none' ? false : effective.engineSocket })}
                      className={`state-layer rounded-lg border px-2.5 py-1 text-xs font-medium ${
                        effective.containers === o.value ? 'border-transparent bg-secondary-container text-secondary-on-container' : 'border-surface-500 text-ink-400'
                      }`}
                    >
                      {effective.containers === o.value ? '✓ ' : ''}
                      {o.label}
                    </button>
                  ))}
                </div>
                {CONTAINER_OPTIONS.find((o) => o.value === effective.containers)?.hint && (
                  <p className="text-xs text-ink-500">{CONTAINER_OPTIONS.find((o) => o.value === effective.containers)!.hint}</p>
                )}
                {effective.containers !== 'none' && (
                  <label
                    className={`flex items-start gap-2 rounded-xl p-2.5 text-sm ${effective.engineSocket ? 'bg-error-container text-error-on-container' : 'text-ink-200'}`}
                  >
                    <input type="checkbox" className="mt-1" checked={effective.engineSocket} onChange={(e) => set({ engineSocket: e.target.checked })} />
                    <span>
                      🧭 Portainer &amp; engine access
                      <span className="block text-xs opacity-80">
                        Lets them run Portainer (or any container manager) with the engine socket — control over every container on this host, and
                        with rootful Docker effectively the host itself. Only for people you'd trust with admin.
                      </span>
                    </span>
                  </label>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max instances (0 = no limit)">
                  <Input type="number" min={0} value={effective.maxInstances} onChange={(e) => set({ maxInstances: Math.max(0, Number(e.target.value)) })} />
                </Field>
                <Field label="Max memory per instance, MB (0 = no limit)">
                  <Input type="number" min={0} step={256} value={effective.maxMemoryMb} onChange={(e) => set({ maxMemoryMb: Math.max(0, Number(e.target.value)) })} />
                </Field>
              </div>
            </>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">
        Owners get full control of their own instances except editing the launch command and UPnP (grant those per instance below). Custom
        processes can only be created by admins.
      </p>
    </div>
  );
}

const CONFIG_FIELDS = ['name', 'minMemoryMb', 'maxMemoryMb', 'serverPort', 'extraJavaArgs', 'extraArgs', 'autoStart', 'steamLogin', 'steamExtraFlags', 'restartPolicy', 'restartDelaySec', 'restartMaxAttempts', 'isolation'];
function ConfigAccessEditor({ serverId, value, onChange }: { serverId: string; value: Record<string, boolean>; onChange: (next: Record<string, boolean>) => void }) {
  const [properties, setProperties] = useState<string[]>([]);
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<{ properties: { key: string }[] }>(`/servers/${serverId}/properties`)
      .then((res) => setProperties(res.properties.map((p) => `property.${p.key}`)))
      .catch(() => setError('Could not load properties. You can still add a property key below.'));
  }, [serverId]);
  const keys = [...new Set([...CONFIG_FIELDS.map((key) => `setting.${key}`), ...properties, ...Object.keys(value)])];
  return <details className="rounded-xl bg-surface-900 p-3">
    <summary className="cursor-pointer text-xs text-ink-200">Individual configuration items ({Object.keys(value).length} overrides)</summary>
    <p className="my-2 text-xs text-ink-400">Inherit follows Edit configuration. Allow grants this item even without that permission. Deny locks it. Admins retain full access.</p>
    <p className="my-2 text-xs text-ink-400">Any denied item also blocks file writes (including SFTP), console commands, restores, launch edits, plugins, updates, player actions and other configuration editors that could overwrite protected settings.</p>
    <div className="max-h-64 space-y-2 overflow-y-auto">{keys.map((key) => <label key={key} className="flex items-center justify-between gap-2 text-xs text-ink-300">
      <span className="break-all font-mono">{key}</span>
      <Select aria-label={`Permission for ${key}`} value={key in value ? String(value[key]) : ''} onChange={(e) => {
        const next = { ...value };
        if (!e.target.value) delete next[key]; else next[key] = e.target.value === 'true';
        onChange(next);
      }}><option value="">Inherit</option><option value="true">Allow</option><option value="false">Deny</option></Select>
    </label>)}</div>
    <div className="mt-3 flex gap-2"><Input aria-label="Property key" placeholder="Property key, e.g. motd" value={newKey} onChange={(e) => setNewKey(e.target.value)} /><Button type="button" disabled={!/^[a-zA-Z0-9_.-]+$/.test(newKey)} onClick={() => { onChange({ ...value, [`property.${newKey}`]: false }); setNewKey(''); }}>Add</Button></div>
    <ErrorText>{error}</ErrorText>
  </details>;
}
