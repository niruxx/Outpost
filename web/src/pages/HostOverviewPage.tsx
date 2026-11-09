import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminNotice, HostLayout, fmtTime } from '../components/HostLayout.js';
import { Badge, Button, Card, CardTitle, ErrorText, Field, Input, Modal, Notice, Select, Spinner } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { api, ApiError } from '../api/client.js';
import { hostApi, useHostAdmin, useHostTarget } from '../state/hostTarget.js';

interface Overview {
  linux: boolean;
  hostname: string;
  prettyHostname: string | null;
  os: string;
  kernel: string;
  arch: string;
  hardware: { vendor: string | null; product: string | null; cpu: string | null; cores: number; memoryMb: number; machineId: string | null };
  bootedAt: string;
  time: {
    now: string;
    timezone: string;
    ntpEnabled: boolean;
    synchronized: boolean;
    canNtp: boolean;
    ntp: { client: 'chrony' | 'timesyncd' | null; servers: string[]; managed: boolean };
  };
  power: { scheduled: { at: string; mode: string; message: string | null } | null };
  tuned: { installed: boolean; profiles: Array<{ name: string; description: string }>; active: string | null; recommended: string | null };
  remoteAdmin: boolean;
}

function uptime(bootedAt: string) {
  const s = Math.max(0, (Date.now() - new Date(bootedAt).getTime()) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function HostOverviewPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const target = useHostTarget();
  const adminMode = useHostAdmin().active;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editHost, setEditHost] = useState(false);
  const [timezones, setTimezones] = useState<string[]>([]);
  const [tz, setTz] = useState('');
  const [ntpServers, setNtpServers] = useState('');
  const [manualTime, setManualTime] = useState('');
  const [powerDelay, setPowerDelay] = useState('0');
  const [powerMessage, setPowerMessage] = useState('');
  const [profile, setProfile] = useState('');
  const [remoteAccess, setRemoteAccess] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Overview>(hostApi('/settings'));
      setData(d);
      setTz(d.time.timezone);
      setNtpServers(d.time.ntp.servers.join(' '));
      setProfile(d.tuned.active ?? '');
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the host');
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ timezones: string[] }>(hostApi('/settings/timezones'))
      .then((r) => setTimezones(r.timezones))
      .catch(() => undefined);
    if (!target.nodeId) {
      api
        .get<{ enabled: boolean }>('/host/remote-access')
        .then((r) => setRemoteAccess(r.enabled))
        .catch(() => setRemoteAccess(null));
    }
  }, [load, target.nodeId]);

  async function change(key: string, path: string, body: unknown, done: string) {
    setBusy(key);
    try {
      const r = await api.post<{ overview?: Overview }>(hostApi(path), body);
      if (r.overview) {
        setData({ ...r.overview, remoteAdmin: data?.remoteAdmin ?? false });
      } else await load();
      toast.success(done);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The change failed');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function power(action: 'reboot' | 'poweroff') {
    const delay = Number(powerDelay);
    const ok = await confirm({
      title: action === 'reboot' ? 'Restart host' : 'Shut down host',
      message:
        delay === 0
          ? `${action === 'reboot' ? 'Restart' : 'Shut down'} ${data?.hostname} now? Every instance, VM and container on it stops${action === 'poweroff' ? ', and it stays off until someone powers it on' : ''}. This panel will be unreachable${action === 'reboot' ? ' until the host is back' : ''}.`
          : `${action === 'reboot' ? 'Restart' : 'Shut down'} ${data?.hostname} in ${delay} minutes? Logged-in users are warned.`,
      confirmLabel: action === 'reboot' ? 'Restart' : 'Shut down',
      tone: 'danger',
    });
    if (!ok) return;
    await change(action, '/settings/power', { action, delayMinutes: delay, message: powerMessage }, delay === 0 ? `${action === 'reboot' ? 'Restarting' : 'Shutting down'}…` : 'Scheduled');
  }

  async function cancelPower() {
    setBusy('cancel');
    try {
      const r = await api.delete<{ overview: Overview }>(hostApi('/settings/power'));
      setData({ ...r.overview, remoteAdmin: data?.remoteAdmin ?? false });
      toast.success('Cancelled');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t cancel');
    } finally {
      setBusy(null);
    }
  }

  async function setRemote(enabled: boolean) {
    if (enabled) {
      const ok = await confirm({
        title: 'Allow linked panels to administer this host?',
        message:
          'Administrators of panels this host trusts with its node key will be able to use the Host pages here. Changes still need Admin Mode (this host’s sudo password) and are audited on both panels. If Outpost runs as root here, they get root without a password.',
        confirmLabel: 'Allow',
      });
      if (!ok) return;
    }
    try {
      setRemoteAccess((await api.put<{ enabled: boolean }>('/host/remote-access', { enabled })).enabled);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t change the setting');
    }
  }

  const dis = !adminMode || !!busy;
  const title = adminMode ? undefined : 'Turn on Admin Mode first';

  return (
    <HostLayout>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          {data.linux && <AdminNotice active={adminMode} what="change these settings, restart or shut down the host" />}
          {data.power.scheduled && (
            <Notice tone="warning">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex-1">
                  <b>{data.power.scheduled.mode === 'reboot' ? 'Restart' : 'Shutdown'} scheduled</b> for {fmtTime(data.power.scheduled.at)}
                  {data.power.scheduled.message ? ` — “${data.power.scheduled.message}”` : ''}.
                </span>
                <Button variant="outlined" onClick={() => void cancelPower()} disabled={dis} title={title}>
                  Cancel it
                </Button>
              </div>
            </Notice>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-5">
              <CardTitle
                action={
                  data.linux && (
                    <Button variant="ghost" onClick={() => setEditHost(true)} disabled={dis} title={title}>
                      Edit name
                    </Button>
                  )
                }
              >
                System
              </CardTitle>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                {(
                  [
                    ['Host name', data.hostname],
                    ['Pretty name', data.prettyHostname],
                    ['Operating system', data.os],
                    ['Kernel', `${data.kernel} (${data.arch})`],
                    ['Hardware', [data.hardware.vendor, data.hardware.product].filter(Boolean).join(' ') || null],
                    ['CPU', data.hardware.cpu ? `${data.hardware.cpu} · ${data.hardware.cores} threads` : null],
                    ['Memory', `${(data.hardware.memoryMb / 1024).toFixed(1)} GB`],
                    ['Up for', `${uptime(data.bootedAt)} (since ${fmtTime(data.bootedAt)})`],
                    ['Machine ID', data.hardware.machineId],
                  ] as const
                )
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-ink-500">{k}</dt>
                      <dd className="min-w-0 break-words text-ink-100">{v}</dd>
                    </div>
                  ))}
              </dl>
            </Card>

            <Card className="p-5">
              <CardTitle action={<Badge tone={data.time.synchronized ? 'green' : 'yellow'}>{data.time.synchronized ? 'Synchronized' : 'Not synchronized'}</Badge>}>Time</CardTitle>
              <p className="mb-4 text-2xl font-light tabular-nums text-ink-50">
                {new Date(data.time.now).toLocaleString([], { timeZone: data.time.timezone, dateStyle: 'medium', timeStyle: 'short' })}
                <span className="ml-2 text-sm text-ink-400">{data.time.timezone}</span>
              </p>
              {data.linux && (
                <div className="space-y-4">
                  <div className="flex items-end gap-2">
                    <Field label="Time zone">
                      <Input list="host-timezones" value={tz} onChange={(e) => setTz(e.target.value)} />
                    </Field>
                    <datalist id="host-timezones">
                      {timezones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                    <Button disabled={dis || tz === data.time.timezone || (timezones.length > 0 && !timezones.includes(tz))} title={title} onClick={() => void change('tz', '/settings/timezone', { timezone: tz }, `Time zone set to ${tz}`)}>
                      Set
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink-300">
                    <input type="checkbox" checked={data.time.ntpEnabled} disabled={dis || !data.time.canNtp} onChange={(e) => void change('ntp', '/settings/ntp', { enabled: e.target.checked }, e.target.checked ? 'Network time on' : 'Network time off')} />
                    Set time automatically (NTP{data.time.ntp.client ? `, ${data.time.ntp.client}` : ''})
                  </label>
                  {data.time.ntpEnabled ? (
                    <div className="flex items-end gap-2">
                      <Field label="NTP servers (space-separated; empty = distribution default)">
                        <Input value={ntpServers} onChange={(e) => setNtpServers(e.target.value)} placeholder="time.cloudflare.com pool.ntp.org" />
                      </Field>
                      <Button
                        disabled={dis}
                        title={title}
                        onClick={() => void change('ntps', '/settings/ntp-servers', { servers: ntpServers.split(/[\s,]+/).filter(Boolean) }, 'NTP servers saved')}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-end gap-2">
                      <Field label="Set the clock (YYYY-MM-DD HH:MM)">
                        <Input value={manualTime} onChange={(e) => setManualTime(e.target.value)} placeholder={new Date().toISOString().slice(0, 16).replace('T', ' ')} />
                      </Field>
                      <Button disabled={dis || !manualTime} title={title} onClick={() => void change('time', '/settings/time', { time: manualTime }, 'Clock set')}>
                        Set
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>

            {data.linux && (
              <Card className="p-5">
                <CardTitle>Power</CardTitle>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="When">
                    <Select value={powerDelay} onChange={(e) => setPowerDelay(e.target.value)}>
                      <option value="0">Now</option>
                      <option value="1">In 1 minute</option>
                      <option value="5">In 5 minutes</option>
                      <option value="15">In 15 minutes</option>
                      <option value="30">In 30 minutes</option>
                      <option value="60">In 1 hour</option>
                      <option value="240">In 4 hours</option>
                    </Select>
                  </Field>
                  <Field label="Message to logged-in users (optional)">
                    <Input value={powerMessage} onChange={(e) => setPowerMessage(e.target.value)} placeholder="Maintenance" />
                  </Field>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="danger" disabled={dis} title={title} onClick={() => void power('reboot')}>
                    Restart
                  </Button>
                  <Button variant="outlined" disabled={dis} title={title} onClick={() => void power('poweroff')}>
                    Shut down
                  </Button>
                </div>
              </Card>
            )}

            {data.linux && (
              <Card className="p-5">
                <CardTitle action={data.tuned.active && <Badge tone="green">{data.tuned.active}</Badge>}>Performance profile</CardTitle>
                {!data.tuned.installed ? (
                  <p className="text-sm text-ink-400">
                    Performance profiles use <code>tuned</code>, which isn’t installed. Install the <b>tuned</b> package from{' '}
                    <Link className="text-accent-400 hover:underline" to="/host/software">
                      Software
                    </Link>
                    , then start it from Services.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <Select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Profile">
                      <option value="">Off (no tuning)</option>
                      {data.tuned.profiles.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.name === data.tuned.recommended ? ' (recommended)' : ''}
                          {p.description ? ` — ${p.description}` : ''}
                        </option>
                      ))}
                    </Select>
                    <Button
                      disabled={dis || profile === (data.tuned.active ?? '')}
                      title={title}
                      onClick={() => void change('tuned', '/settings/tuned', { profile: profile || null }, profile ? `Profile ${profile} active` : 'Tuning off')}
                    >
                      Apply
                    </Button>
                  </div>
                )}
              </Card>
            )}

            {!target.nodeId && remoteAccess !== null && (
              <Card className="p-5 lg:col-span-2">
                <CardTitle action={<Badge tone={remoteAccess ? 'yellow' : 'neutral'}>{remoteAccess ? 'Allowed' : 'Off'}</Badge>}>Administration from linked panels</CardTitle>
                <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
                  <p className="flex-1">
                    Lets administrators of Outpost panels that have this host’s node key pick this host in the Host switcher. Changes still need this host’s Admin Mode
                    password.
                  </p>
                  <Button variant={remoteAccess ? 'outlined' : 'default'} onClick={() => void setRemote(!remoteAccess)}>
                    {remoteAccess ? 'Turn off' : 'Allow'}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      {editHost && data && (
        <HostnameModal
          initial={{ hostname: data.hostname, pretty: data.prettyHostname ?? '' }}
          onClose={() => setEditHost(false)}
          onSave={async (hostname, pretty) => {
            if (await change('host', '/settings/hostname', { hostname, pretty }, `Host name set to ${hostname}`)) setEditHost(false);
          }}
        />
      )}
    </HostLayout>
  );
}

function HostnameModal({ initial, onClose, onSave }: { initial: { hostname: string; pretty: string }; onClose: () => void; onSave: (hostname: string, pretty: string) => Promise<void> }) {
  const [hostname, setHostname] = useState(initial.hostname);
  const [pretty, setPretty] = useState(initial.pretty);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(hostname);
  return (
    <Modal open onClose={onClose} title="Host name">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await onSave(hostname, pretty);
          setBusy(false);
        }}
      >
        <Field label="Host name">
          <Input value={hostname} onChange={(e) => setHostname(e.target.value)} autoFocus />
        </Field>
        <Field label="Pretty name (optional, free text)">
          <Input value={pretty} onChange={(e) => setPretty(e.target.value)} placeholder="Game server rack 2" />
        </Field>
        <ErrorText>{hostname && !valid ? 'Letters, digits and "-" only, with dots between labels' : ''}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
