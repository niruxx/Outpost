import { Badge } from './ui.js';
import type { ServerStatus } from '../api/types.js';

const TONE: Record<ServerStatus, 'neutral' | 'green' | 'red' | 'yellow' | 'blue'> = {
  installing: 'blue',
  install_failed: 'red',
  stopped: 'neutral',
  starting: 'yellow',
  running: 'green',
  stopping: 'yellow',
  crashed: 'red',
  updating: 'blue',
  transferring: 'blue',
};

const LABEL: Record<ServerStatus, string> = {
  installing: 'Installing',
  install_failed: 'Install failed',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
  updating: 'Updating',
  transferring: 'Transferring',
};

const PULSE: Record<ServerStatus, boolean> = {
  installing: true,
  install_failed: false,
  stopped: false,
  starting: true,
  running: true,
  stopping: true,
  crashed: false,
  updating: true,
  transferring: true,
};

const DOT: Record<'neutral' | 'green' | 'red' | 'yellow' | 'blue', string> = {
  neutral: 'bg-ink-500',
  green: 'bg-success-400',
  red: 'bg-red-400',
  yellow: 'bg-yellow-400',
  blue: 'bg-sky-400',
};

/** Compact status indicator for tight spots like the navigation drawer. */
export function StatusDot({ status, suspended = false }: { status: ServerStatus; suspended?: boolean }) {
  const label = suspended ? 'Suspended' : LABEL[status];
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${suspended ? DOT.red : DOT[TONE[status]]} ${!suspended && PULSE[status] ? 'animate-pulse-soft' : ''}`}
      title={label}
      aria-label={label}
    />
  );
}

export function StatusBadge({ status }: { status: ServerStatus }) {
  return (
    <Badge tone={TONE[status]} pulse={PULSE[status]}>
      {LABEL[status]}
    </Badge>
  );
}

export function SuspendedBadge() {
  return <Badge tone="red">Suspended</Badge>;
}
