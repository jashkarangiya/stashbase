/**
 * OpenAI key entry modal. Validates against /v1/models before resolving
 * so a typo never lands in `~/.stashbase/config.json`. `mode='change'`
 * only swaps the title + button text; the validation + save path is
 * identical (the caller wires `onSaved` to either commitSwitch or
 * changeApiKey).
 */
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { ModalShell } from '../ModalShell';

export function KeyModal({
  mode = 'enter',
  onCancel,
  onSaved,
}: {
  mode?: 'enter' | 'change';
  onCancel: () => void;
  onSaved: (key: string) => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit() {
    const trimmed = key.trim();
    if (!trimmed) { setError('Key required'); return; }
    setBusy(true);
    setError(null);
    try {
      // validateEmbedder throws ApiError on a bad key; resolves silently
      // on success. The server-side check ran against /v1/models — at
      // this point we know the key is valid, hand it to the caller.
      await api.validateEmbedder(trimmed);
      onSaved(trimmed);
    } catch (err: unknown) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={onCancel}>
      <h3>{mode === 'change' ? 'Change API key' : 'OpenAI API key'}</h3>
      <p className="modal-hint">
        {mode === 'change'
          ? 'Replaces the stored OpenAI key. Existing vectors stay valid — no re-embed.'
          : <>Used for embedding only. Stored in <code>~/.stashbase/config.json</code> with owner-only permissions.</>}
      </p>
      <input
        ref={inputRef}
        type="password"
        className="modal-input"
        placeholder="sk-…"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={submit}
          disabled={busy}
        >{busy ? 'Validating…' : (mode === 'change' ? 'Save' : 'Continue')}</button>
      </div>
    </ModalShell>
  );
}
