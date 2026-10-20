import { useEffect, useState } from 'react';
import { setVisibleInterval } from '../../lib/perf.js';
import { Link, useNavigate } from 'react-router-dom';
import { useServerDetail } from './ServerContext.js';
import { api, ApiError } from '../../api/client.js';
import type { PanelNode, PublicUser, TransferState } from '../../api/types.js';
import { Button, Card, CardTitle, ErrorText, Field, Input, Notice, Select, Spinner } from '../../components/ui.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { useConfirm } from '../../components/ConfirmDialog.js';
import { formatBytes } from './StatusTab.js';

const SUSPEND_REASONS = ['Non-payment', 'Terms of Service violation', 'Abuse report under review', 'Other'];

function SuspensionCard() {
  const { server, refresh } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const [reason, setReason] = useState(SUSPEND_REASONS[0]);
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!server) return null;

  async function suspend() {
    const fullReason = [reason === 'Other' ? '' : reason, note.trim()].filter(Boolean).join(' — ');
    const ok = await confirm({
      title: 'Suspend instance',
      message: (
        <>
          <p>
            “{server!.name}” will be {force ? 'killed immediately' : 'stopped'} and locked. Its users won't be able to see its
            files, console, backups or settings, or start it, through the panel or the API until you lift the suspension.
          </p>
          {fullReason && <p className="mt-2 text-ink-400">Reason shown to them: {fullReason}</p>}
        </>
      ),
      confirmLabel: 'Suspend',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/servers/${server!.id}/suspend`, { reason: fullReason, force });
      toast.success(`Suspended “${server!.name}”`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to suspend');
    } finally {
      setBusy(false);
    }
  }

  async function lift() {
    setBusy(true);
    try {
      await api.post(`/servers/${server!.id}/unsuspend`);
      toast.success('Suspension lifted');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to lift suspension');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Suspension</CardTitle>
      {server.suspended ? (
        <div className="space-y-4">
          <Notice tone="error">
            Suspended{server.suspended_at && ` on ${new Date(server.suspended_at).toLocaleString()}`}
            {server.suspended_by && ` by ${server.suspended_by}`}.
            {server.suspended_reason && (
              <>
                <br />
                Reason: {server.suspended_reason}
              </>
            )}
          </Notice>
          <Button variant="primary" disabled={busy} onClick={lift}>
            <Icon name="unlock" className="h-4 w-4" /> Lift suspension
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-400">
            Stops the instance and locks it for everyone except admins — for non-payment, Terms of Service violations, or while
            investigating abuse. Files and backups are kept.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {SUSPEND_REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <Field label="Note for the owner (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Invoice #1042 overdue" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-[rgb(var(--accent-400))]" />
            Kill the process immediately instead of a graceful stop (unsaved progress is lost)
          </label>
          <Button variant="danger" disabled={busy} onClick={suspend}>
            <Icon name="lock" className="h-4 w-4" /> Suspend instance
          </Button>
        </div>
      )}
    </Card>
  );
}

function TransferCard() {
  const { server, running, refresh } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<PanelNode[] | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [deleteSource, setDeleteSource] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ nodes: PanelNode[] }>('/nodes')
      .then((res) => {
        setNodes(res.nodes);
        setNodeId((prev) => prev || res.nodes[0]?.id || '');
      })
      .catch(() => setNodes([]));
    if (server) {
      api
        .get<{ transfer: TransferState | null }>(`/servers/${server.id}/transfer`)
        .then((res) => setTransfer(res.transfer))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id]);

  // Poll while a transfer is in flight.
  useEffect(() => {
    if (!server || transfer?.state !== 'running') return;
    const t = setVisibleInterval(async () => {
      try {
        const res = await api.get<{ transfer: TransferState | null }>(`/servers/${server.id}/transfer`);
        setTransfer(res.transfer);
        if (res.transfer?.state === 'done') {
          toast.success(`Transferred to ${res.transfer.nodeName}`);
          if (res.transfer.sourceDeleted) navigate('/');
          else refresh();
        } else if (res.transfer?.state === 'failed') {
          refresh();
        }
      } catch {
        // instance deleted after a move — the done branch above navigates away
      }
    }, 1500);
    return () => t();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, transfer?.state]);

  if (!server) return null;
  const node = nodes?.find((n) => n.id === nodeId);

  async function start() {
    const ok = await confirm({
      title: 'Transfer instance',
      message: `Copy “${server!.name}” (all files and settings) to ${node?.name}? ${
        deleteSource ? 'It will be deleted from this node once the transfer succeeds.' : 'A stopped copy stays on this node with auto-start turned off.'
      }`,
      confirmLabel: 'Transfer',
    });
    if (!ok) return;
    setError('');
    try {
      const res = await api.post<{ transfer: TransferState }>(`/servers/${server!.id}/transfer`, { nodeId, deleteSource });
      setTransfer(res.transfer);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Transfer failed to start');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Transfer to another node</CardTitle>
      {nodes === null ? (
        <Spinner />
      ) : nodes.length === 0 ? (
        <p className="text-sm text-ink-400">
          No other nodes yet. Add another Outpost host under{' '}
          <Link to="/configuration" className="text-accent-400 underline-offset-2 hover:underline">
            Configuration → Nodes
          </Link>{' '}
          to move instances between machines.
        </p>
      ) : (
        <div className="space-y-4">
          {transfer?.state === 'running' ? (
            <Notice tone="info">
              <span className="inline-flex items-center gap-2">
                <Spinner /> Sending to {transfer.nodeName}… {formatBytes(transfer.bytesSent)} transferred (compressed)
              </span>
            </Notice>
          ) : transfer?.state === 'failed' ? (
            <Notice tone="error">Last transfer to {transfer.nodeName} failed: {transfer.error}</Notice>
          ) : transfer?.state === 'done' ? (
            <Notice tone="info">
              Transferred to {transfer.nodeName} on {new Date(transfer.finishedAt ?? transfer.startedAt).toLocaleString()} (
              {formatBytes(transfer.bytesSent)}).
            </Notice>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Destination node">
              <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} — {n.url}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
            Delete it from this node after a successful transfer (move instead of copy)
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={running || !nodeId || transfer?.state === 'running'} onClick={start}>
              <Icon name="transfer" className="h-4 w-4" /> Transfer
            </Button>
            {running && <span className="text-xs text-ink-400">Stop the instance first.</span>}
          </div>
          <p className="text-xs text-ink-500">
            Copies the instance folder and its settings. Backups, schedules and user access stay here; set them up again on the
            destination. The destination port must be free there.
          </p>
        </div>
      )}
    </Card>
  );
}

function OwnerCard() {
  const { server, owner, refresh } = useServerDetail();
  const toast = useToast();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [choice, setChoice] = useState('');

  useEffect(() => {
    api.get<{ users: PublicUser[] }>('/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, []);
  useEffect(() => setChoice(owner?.id ?? ''), [owner?.id]);

  if (!server) return null;

  async function save() {
    try {
      await api.patch(`/servers/${server!.id}/owner`, { userId: choice || null });
      toast.success(choice ? 'Ownership transferred' : 'Owner removed');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to change the owner');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Owner</CardTitle>
      <p className="mb-4 text-sm text-ink-400">
        The owner can manage and delete this instance and it counts toward their instance limit. A new non-admin owner automatically gets
        owner access.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Field label="Owned by">
            <Select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!users}>
              <option value="">No owner (admins only)</option>
              {users?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} ({u.role})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button variant="primary" onClick={save} disabled={choice === (owner?.id ?? '')}>
          Save owner
        </Button>
      </div>
    </Card>
  );
}

function DangerZone() {
  const { server, running } = useServerDetail();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  if (!server) return null;

  async function deleteInstance() {
    const ok = await confirm({
      title: 'Delete instance',
      message: `Permanently delete “${server!.name}”? All files and backups will be removed. This cannot be undone.`,
      confirmLabel: 'Delete instance',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/servers/${server!.id}`);
      toast.success(`Deleted “${server!.name}”`);
      navigate('/');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete instance');
    }
  }

  return (
    <Card className="p-5">
      <CardTitle>Delete instance</CardTitle>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-400">Removes the instance, its files and every backup from this node.</p>
        <Button variant="danger" disabled={running} onClick={deleteInstance}>
          <Icon name="trash" className="h-4 w-4" /> Delete
        </Button>
      </div>
    </Card>
  );
}

/** Admin-only section at the bottom of an instance's Configuration page. */
export function InstanceAdminCards() {
  const { isAdmin, isOwner } = useServerDetail();
  if (!isAdmin && !isOwner) return null;
  return (
    <div className="stagger space-y-5">
      <h2 className="pt-2 text-sm font-medium text-ink-400">{isAdmin ? 'Administration' : 'Ownership'}</h2>
      {isAdmin && <OwnerCard />}
      {isAdmin && <SuspensionCard />}
      {isAdmin && <TransferCard />}
      <DangerZone />
    </div>
  );
}
