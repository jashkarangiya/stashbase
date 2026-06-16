/**
 * Pops when the record button is pressed and no Gemini key is on file.
 * Recording is Gemini-only (video understanding → note), so without a
 * key capture can't start. Mirrors `RequireApiKeyModal`. Two exits:
 *   • Save key — validates + persists via `/api/gemini/key`, then the
 *     caller proceeds to start recording.
 *   • Later — dismiss without recording; re-pops on the next attempt.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { ModalShell } from '../ModalShell';

export function RequireGeminiKeyModal({
  onSaved,
  onLater,
}: {
  onSaved: () => void;
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
      await api.setGeminiKey(k);
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : errorMessage(err);
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={busy ? () => { /* swallow */ } : onLater}>
      <h3>Add Gemini key</h3>
      <p className="modal-hint">
        Screen recording uses <strong>Gemini video understanding</strong> to
        turn a capture into a note. Stored locally in
        {' '}<code>~/.stashbase/config.json</code>.
      </p>
      <input
        ref={inputRef}
        type="password"
        className="modal-input"
        placeholder="AIza…"
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
