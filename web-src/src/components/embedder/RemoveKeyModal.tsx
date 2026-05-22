/**
 * Confirmation for removing the global OpenAI key. If the library is
 * still configured as `openai`, embed / search calls will start
 * failing until the user adds a key back or switches the provider to
 * Local. Existing vectors stay valid.
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
        If the library is still set to OpenAI, embed / search will fail
        until you add a key back or switch to Local. Existing vectors
        are kept as-is.
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
