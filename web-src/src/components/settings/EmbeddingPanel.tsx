/**
 * Settings → Embedding panel. V1 fixes the embedder to OpenAI, so this
 * is just the OpenAI API key: add / change / remove. With no key set,
 * indexing and search are disabled (files still save and preview); the
 * `RequireApiKeyModal` auto-pop on space load lives in
 * `EmbedderRequireKeyGate` so it fires whether or not Settings is open.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type EmbedderState } from '../../api';
import { KeyModal } from '../embedder/KeyModal';
import { RemoveKeyModal } from '../embedder/RemoveKeyModal';

export function EmbeddingPanel() {
  const [state, setState] = useState<EmbedderState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [keyEditOpen, setKeyEditOpen] = useState(false);
  const [keyRemoveOpen, setKeyRemoveOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api.getEmbedder()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg || 'Failed to load embedder settings');
      });
    return () => { cancelled = true; };
  }, [loadNonce]);

  const retryLoad = useCallback(() => setLoadNonce((n) => n + 1), []);

  async function onKeyChanged(key: string) {
    await api.changeApiKey(key);
    setKeyEditOpen(false);
    setState((s) => (s ? { ...s, hasKey: true } : s));
  }

  async function onKeyRemoveConfirmed() {
    await api.removeApiKey();
    setKeyRemoveOpen(false);
    setState((s) => (s ? { ...s, hasKey: false } : s));
  }

  if (loadError) {
    return (
      <div className="settings-panel-loading">
        <div className="settings-section-hint" style={{ color: 'var(--danger, #c0392b)' }}>
          Couldn’t load embedder settings: {loadError}
        </div>
        <div className="settings-actions-row" style={{ marginTop: 12 }}>
          <button type="button" className="modal-btn" onClick={retryLoad}>Retry</button>
        </div>
      </div>
    );
  }
  if (!state) return <div className="settings-panel-loading">Loading…</div>;

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-title">OpenAI API key</div>
        <div className="settings-section-hint">
          Search uses OpenAI embeddings (<code>text-embedding-3-small</code>). Stored
          owner-only in <code>~/.stashbase/config.json</code>, used for embedding requests only.
          Without a key, files still save and preview — indexing and search stay off until you add one.
        </div>
        <div className="settings-actions-row">
          {state.hasKey ? (
            <>
              <button
                type="button"
                className="modal-btn"
                onClick={() => setKeyEditOpen(true)}
              >Change key…</button>
              <button
                type="button"
                className="modal-btn danger"
                onClick={() => setKeyRemoveOpen(true)}
              >Remove key…</button>
            </>
          ) : (
            <button
              type="button"
              className="modal-btn"
              onClick={() => setKeyEditOpen(true)}
            >Add key…</button>
          )}
        </div>
      </div>

      {keyEditOpen && (
        <KeyModal
          mode={state.hasKey ? 'change' : undefined}
          onCancel={() => setKeyEditOpen(false)}
          onSaved={state.hasKey
            ? onKeyChanged
            : async (key: string) => {
                setKeyEditOpen(false);
                await api.changeApiKey(key);
                setState((s) => (s ? { ...s, hasKey: true } : s));
              }}
        />
      )}
      {keyRemoveOpen && (
        <RemoveKeyModal
          onCancel={() => setKeyRemoveOpen(false)}
          onConfirm={onKeyRemoveConfirmed}
        />
      )}
    </>
  );
}
