/**
 * Auto-pops on folder open when no embedding key is on file. Without a
 * key, embedding/index updates and semantic search are disabled. Two
 * exits:
 *   • Save key — validates + persists via `/api/embedder/key`, daemon
 *     hot-swap, modal closes.
 *   • Later — dismiss; modal will re-pop next time the folder opens.
 * We deliberately don't show a plain "Cancel" — "Later" is the soft
 * escape.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, type EmbedderProvider } from '../../api';
import { ModalShell } from '../ModalShell';

const PROVIDERS: Record<EmbedderProvider, { label: string; model: string; placeholder: string }> = {
  openai: {
    label: 'OpenAI',
    model: 'text-embedding-3-small',
    placeholder: 'sk-...',
  },
  openrouter: {
    label: 'OpenRouter',
    model: 'openai/text-embedding-3-small',
    placeholder: 'sk-or-v1-...',
  },
};

const PROVIDER_ORDER: EmbedderProvider[] = ['openai', 'openrouter'];

export function RequireApiKeyModal({
  initialProvider = 'openai',
  onSaved,
  onLater,
}: {
  initialProvider?: EmbedderProvider;
  onSaved: (provider: EmbedderProvider, model: string, backfillStarted?: boolean, warning?: string) => void;
  onLater: () => void;
}) {
  const [provider, setProvider] = useState<EmbedderProvider>(initialProvider);
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
      // `changeApiKey` server-side rejects definite provider auth failures,
      // persists to `~/.stashbase/config.json`, and rebinds so the next
      // search uses the new key (creating the collection on first key).
      const result = await api.changeApiKey(k, provider);
      onSaved(result.provider, result.model, result.backfillStarted, result.warning);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : errorMessage(err);
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <ModalShell onCancel={busy ? () => { /* swallow */ } : onLater}>
      <h3>Add embedding key</h3>
      <p className="modal-hint">
        Semantic search uses embeddings. Choose a provider, then paste the API key.
        Keyword search and editing work without it.
      </p>
      <div className="embedder-modal-provider-row" role="radiogroup" aria-label="Embedding provider">
        {PROVIDER_ORDER.map((optionProvider) => {
          const option = PROVIDERS[optionProvider];
          const selected = provider === optionProvider;
          return (
            <button
              key={optionProvider}
              type="button"
              className={`embedder-modal-provider-option${selected ? ' selected' : ''}`}
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => {
                setProvider(optionProvider);
                setKey('');
                setError(null);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="modal-hint embedder-modal-meta">
        <span>Model: <code>{PROVIDERS[provider].model}</code></span>
        <span>Stored locally in <code>~/.stashbase/config.json</code></span>
      </div>
      <input
        ref={inputRef}
        type="password"
        className="modal-input"
        placeholder={PROVIDERS[provider].placeholder}
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
