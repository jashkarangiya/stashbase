/**
 * Auto-pops on folder open when no OpenAI key is on file. V1 is
 * OpenAI-only, so without a key embedding/index updates and semantic
 * search are disabled. Two
 * exits:
 *   • Save key — validates + persists via `/api/embedder/key`, daemon
 *     hot-swap, modal closes.
 *   • Later — dismiss; modal will re-pop next time the folder opens.
 * We deliberately don't show a plain "Cancel" — "Later" is the soft
 * escape.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { ModalShell } from '../ModalShell';

export function RequireApiKeyModal({
  onSaved,
  onLater,
}: {
  onSaved: (warning?: string) => void;
  onLater: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit() {
    const k = key.trim();
    if (!k) { setError('Key required'); return; }
    setBusy(true);
    setError(null);
    try {
      // `changeApiKey` server-side rejects definite OpenAI auth failures,
      // persists to `~/.stashbase/config.json`, and rebinds so the next
      // search uses the new key (creating the collection on first key).
      const result = await api.changeApiKey(k);
      onSaved(result.warning);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : errorMessage(err);
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={busy ? () => { /* swallow */ } : onLater}>
      <h3>Add OpenAI key</h3>
      <p className="modal-hint">
        Semantic search uses <strong>OpenAI embedding</strong> — embedding
        only, no chat, ~a few cents/month. Stored locally in
        {' '}<code>~/.stashbase/config.json</code>. Add it anytime — keyword
        search and editing work without it.
      </p>
      <input
        ref={inputRef}
        type="password"
        className="modal-input"
        placeholder="sk-…"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !busy) { e.preventDefault(); onLater(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button
          type="button"
          className="modal-btn"
          onClick={onLater}
          disabled={busy}
        >Later</button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={submit}
          disabled={busy}
        >{busy ? 'Validating…' : 'Save key'}</button>
      </div>
    </ModalShell>
  );
}
