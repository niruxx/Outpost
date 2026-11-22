import { useState, type FormEvent } from 'react';
import { api } from '../../api/client.js';
import type { SnapshotMetadata } from '../../api/types.js';
import { Button, ErrorText, Field, Input, Modal, Spinner } from '../../components/ui.js';

export function SnapshotMetadataDialog({ snapshot, endpoint, onClose, onSaved }: {
  snapshot: SnapshotMetadata;
  endpoint: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(snapshot.name ?? '');
  const [label, setLabel] = useState(snapshot.label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameChanged = name.trim() !== (snapshot.name ?? '');
  const labelChanged = label.trim() !== (snapshot.label ?? '');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || (!nameChanged && !labelChanged)) return;
    setSaving(true);
    setError('');
    try {
      await api.patch(endpoint, {
        ...(nameChanged ? { name: name.trim() || null } : {}),
        ...(labelChanged ? { label: label.trim() || null } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not edit snapshot details.');
      setSaving(false);
    }
  }

  return (
    <Modal open title="Edit snapshot details" onClose={() => { if (!saving) onClose(); }}>
      <form className="space-y-4" onSubmit={save}>
        <Field label="Display name">
          <Input autoFocus value={name} maxLength={80} disabled={saving} placeholder="e.g. Before the server upgrade" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Label">
          <Input value={label} maxLength={40} disabled={saving} placeholder="e.g. Maintenance" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || (!nameChanged && !labelChanged)}>
            {saving ? <><Spinner /> Saving…</> : 'Save details'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
