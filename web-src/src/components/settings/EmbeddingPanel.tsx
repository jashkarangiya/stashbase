/**
 * Settings → Embedding panel. The user can choose the direct OpenAI
 * embedding endpoint or OpenRouter's OpenAI-compatible endpoint. With no
 * key set, indexing and search are disabled (files still save and
 * preview); the `RequireApiKeyModal` auto-pop on folder load lives in
 * `EmbedderRequireKeyGate` so it fires whether or not Settings is open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type EmbedderProvider, type EmbedderState } from '../../api';
import { useApp } from '../../store/AppContext';
import { KeyModal } from '../embedder/KeyModal';
import { RemoveKeyModal } from '../embedder/RemoveKeyModal';

const PROVIDERS: Record<EmbedderProvider, { label: string; model: string; placeholder: string; costHint: string }> = {
  openai: {
    label: 'OpenAI',
    model: 'text-embedding-3-small',
    placeholder: 'sk-...',
    costHint: 'about $0.02 per million tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    model: 'openai/text-embedding-3-small',
    placeholder: 'sk-or-v1-...',
    costHint: 'billed by OpenRouter',
  },
};

const PROVIDER_ORDER: EmbedderProvider[] = ['openai', 'openrouter'];

export function EmbeddingPanel() {
  const { state: appState, dispatch, actions } = useApp();
  const [state, setState] = useState<EmbedderState | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<EmbedderProvider>('openai');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [keyEditOpen, setKeyEditOpen] = useState(false);
  const [keyRemoveOpen, setKeyRemoveOpen] = useState(false);
  // Inline "Add key" (no-key state): no modal — the input lives in the
  // panel. Change/Remove still use modals (rarer / needs confirm).
  const [addKey, setAddKey] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api.getEmbedder()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setSelectedProvider(s.provider);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg || 'Failed to load embedder settings');
      });
    return () => { cancelled = true; };
  }, [loadNonce]);

  const retryLoad = useCallback(() => setLoadNonce((n) => n + 1), []);

  async function onKeyChanged(key: string) {
    const result = await api.changeApiKey(key, selectedProvider);
    if (!mountedRef.current) return;
    setKeyEditOpen(false);
    setState((s) => (s ? { ...s, provider: result.provider, model: result.model, hasKey: true } : s));
    setSelectedProvider(result.provider);
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
    if (result.warning) actions.toast(`Embedding key saved, but validation could not reach the provider: ${result.warning}`, { level: 'warning' });
    if (result.backfillStarted) void actions.markVisibleFilesPendingForSearch();
    void actions.refreshIndexState();
  }

  async function addKeySubmit() {
    const trimmed = addKey.trim();
    if (!trimmed) { setAddError('Key required'); return; }
    setAddBusy(true);
    setAddError(null);
    try {
      // changeApiKey rejects definite provider auth failures server-side,
      // so the success path only does one validation round trip.
      const result = await api.changeApiKey(trimmed, selectedProvider);
      if (!mountedRef.current) return;
      setAddKey('');
      setState((s) => (s ? { ...s, provider: result.provider, model: result.model, hasKey: true } : s));
      setSelectedProvider(result.provider);
      dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
      if (result.warning) actions.toast(`Embedding key saved, but validation could not reach the provider: ${result.warning}`, { level: 'warning' });
      if (result.backfillStarted) void actions.markVisibleFilesPendingForSearch();
      void actions.refreshIndexState();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setAddError(errorMessage(err));
    } finally {
      if (mountedRef.current) setAddBusy(false);
    }
  }

  async function onKeyRemoveConfirmed() {
    await api.removeApiKey();
    if (!mountedRef.current) return;
    setKeyRemoveOpen(false);
    setState((s) => (s ? { ...s, hasKey: false } : s));
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: false });
    void actions.refreshIndexState();
    if (appState.searchMode === 'semantic' && appState.filterQuery.trim()) {
      dispatch({
        type: 'SEARCH_ERROR',
        error: 'Semantic search is disabled until you add an embedding API key. Switch to keyword search to search without embeddings.',
      });
    }
  }

  if (loadError) {
    return (
      <div className="settings-panel">
        <div className="settings-section">
          <div className="settings-error">Couldn’t load embedder settings: {loadError}</div>
          <div className="settings-actions-row">
            <button type="button" className="settings-secondary-btn" onClick={retryLoad}>Retry</button>
          </div>
        </div>
      </div>
    );
  }
  if (!state) return <div className="settings-panel-loading">Loading…</div>;
  const selected = PROVIDERS[selectedProvider];
  const activeProviderSelected = state.provider === selectedProvider;
  const hasSelectedProviderKey = state.hasKey && activeProviderSelected;

  return (
    <>
      <div className="settings-panel">
        <div className="settings-section">
          <div className="settings-section-title">Embedding</div>
          <div className="settings-section-hint">
            Used for semantic search. The model stays fixed so the local index remains compatible.
          </div>
          <div className="embedding-provider-row" role="radiogroup" aria-label="Embedding provider">
            {PROVIDER_ORDER.map((provider) => {
              const option = PROVIDERS[provider];
              const selectedOption = provider === selectedProvider;
              return (
                <button
                  key={provider}
                  type="button"
                  className={`embedding-provider-option${selectedOption ? ' selected' : ''}`}
                  role="radio"
                  aria-checked={selectedOption}
                  disabled={addBusy}
                  onClick={() => {
                    setSelectedProvider(provider);
                    setAddKey('');
                    setAddError(null);
                  }}
                >
                  <span className="embedding-provider-name">{option.label}</span>
                </button>
              );
            })}
          </div>
          <div className="settings-section-hint embedding-provider-meta">
            {state.hasKey && <span>Current: {PROVIDERS[state.provider].label}</span>}
            <span>Model: <code>{selected.model}</code></span>
            <span>{selected.costHint}</span>
          </div>
          {hasSelectedProviderKey ? (
            <div className="embedding-key-row">
              <div className="embedding-key-status">Key configured</div>
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => setKeyEditOpen(true)}
                >Change key…</button>
                <button
                  type="button"
                  className="settings-secondary-btn danger"
                  onClick={() => setKeyRemoveOpen(true)}
                >Remove key…</button>
              </div>
            </div>
          ) : (
            <>
              {state.hasKey && !activeProviderSelected && (
                <div className="settings-section-hint">
                  Save a {selected.label} key to switch from {PROVIDERS[state.provider].label}.
                </div>
              )}
              <div className="settings-field-row">
                <input
                  type="password"
                  className="settings-text-input"
                  placeholder={selected.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  value={addKey}
                  disabled={addBusy}
                  onChange={(e) => { setAddKey(e.target.value); setAddError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addKeySubmit(); } }}
                />
                <button
                  type="button"
                  className="settings-primary-btn"
                  onClick={() => { void addKeySubmit(); }}
                  disabled={addBusy || !addKey.trim()}
                >{addBusy ? 'Validating…' : 'Add key'}</button>
              </div>
              {addError && <div className="settings-error">{addError}</div>}
            </>
          )}
          <div className="settings-section-hint settings-hint-foot">
            Stored locally in <code>~/.stashbase/config.json</code>. Used only for embeddings, never chat.
          </div>
        </div>
      </div>

      {keyEditOpen && (
        <KeyModal
          mode="change"
          provider={selectedProvider}
          model={selected.model}
          placeholder={selected.placeholder}
          onCancel={() => setKeyEditOpen(false)}
          onSaved={onKeyChanged}
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
