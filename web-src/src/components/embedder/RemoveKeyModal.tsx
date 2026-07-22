/**
 * Confirmation for removing the global embedding key.
 * Without a key, indexing and search stop until the user adds one back.
 * The existing index is left untouched — nothing is deleted.
 */
import { useState } from 'react';
import { errorMessage } from '../../api';
import { ModalShell } from '../ModalShell';

export function RemoveKeyModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err: unknown) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <ModalShell onCancel={onCancel}>
      <h3>Remove API key?</h3>
      <p className="modal-hint">
        Indexing and search stop until you add a key back. Your existing
        index is kept — nothing is deleted.
      </p>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary danger"
          onClick={submit}
          disabled={busy}
        >{busy ? 'Removing…' : 'Remove key'}</button>
      </div>
    </ModalShell>
  );
}
