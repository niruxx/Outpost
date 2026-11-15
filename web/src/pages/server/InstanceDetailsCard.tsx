import { Link } from 'react-router-dom';
import { Card, CardTitle } from '../../components/ui.js';
import { gameKindOf, gameLabel } from '../../components/GameArt.js';
import { useServerDetail } from './ServerContext.js';

export function InstanceDetailsCard({ compact = false }: { compact?: boolean }) {
  const { server, serverId, runtime, running, owner, autoRestart, can } = useServerDetail();
  if (!server || server.id !== serverId) return null;
  const minutes = runtime ? Math.floor(runtime.uptimeMs / 60000) : 0;
  const uptime = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m` : 'Less than a minute';
  const policy = server.restart_policy === 'always' ? 'Always restart' : server.restart_policy === 'on-crash' ? 'Restart on crash' : 'Manual restart';
  const fields = [
    ['Game / application', gameLabel(gameKindOf(server))],
    ['Edition / version', [server.loader, server.version, server.build].filter(Boolean).join(' · ')],
    ['Owner', owner?.username ?? 'Not assigned'],
    ['Uptime', running ? runtime ? uptime : 'Unavailable' : 'Not running'],
    ['Process ID', running ? runtime?.pid ? String(runtime.pid) : 'Not reported' : 'No active process'],
    ['Automatic recovery', policy],
    ['Start with panel', server.auto_start ? 'Enabled' : 'Disabled'],
    ['Created', Number.isNaN(Date.parse(server.created_at)) ? 'Unavailable' : new Date(server.created_at).toLocaleDateString()],
  ];
  const links = [['files', 'Browse files'], ['backups', 'Backups'], ['tasks', 'Schedules'], ['activity', 'Activity'], ['capabilities', 'Supported features']];
  if (can('settings')) links.push(['configuration', 'Configuration']);
  return <Card className="min-w-0 p-5" aria-label="Instance details">
    <CardTitle>Instance details</CardTitle>
    <dl className={`grid gap-x-5 gap-y-3 text-sm ${compact ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-4'}`}>{fields.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-ink-400">{label}</dt><dd className="mt-1 break-words text-ink-100">{value}</dd></div>)}</dl>
    {autoRestart?.pendingAt && <p className="mt-3 text-xs text-amber-400">Automatic restart scheduled for {new Date(autoRestart.pendingAt).toLocaleTimeString()} · Attempt {autoRestart.attempts}.</p>}
    <nav aria-label="Instance shortcuts" className="mt-4 flex flex-wrap gap-2 border-t border-surface-700 pt-4">{links.map(([path, label]) => <Link key={path} to={`/instances/${serverId}/${path}`} className="state-layer rounded-full bg-surface-900 px-3 py-2 text-xs font-medium text-accent-400">{label}</Link>)}</nav>
  </Card>;
}
