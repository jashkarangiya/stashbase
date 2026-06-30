/**
 * Settings → Embedding panel. V1 fixes the embedder to OpenAI, so this
 * is just the OpenAI API key: add / change / remove. With no key set,
 * indexing and search are disabled (files still save and preview); the
 * `RequireApiKeyModal` auto-pop on folder load lives in
 * `EmbedderRequireKeyGate` so it fires whether or not Settings is open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type EmbedderState } from '../../api';
import { useApp } from '../../store/AppContext';
import { KeyModal } from '../embedder/KeyModal';
import { RemoveKeyModal } from '../embedder/RemoveKeyModal';

export function EmbeddingPanel() {
  const { state: appState, dispatch, actions } = useApp();
  const [state, setState] = useState<EmbedderState | null>(null);
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
    const result = await api.changeApiKey(key);
    if (!mountedRef.current) return;
    setKeyEditOpen(false);
    setState((s) => (s ? { ...s, hasKey: true } : s));
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
    if (result.warning) actions.toast(`OpenAI key saved, but validation could not reach OpenAI: ${result.warning}`, { level: 'warning' });
    void actions.refreshIndexState();
  }

  async function addKeySubmit() {
    const trimmed = addKey.trim();
    if (!trimmed) { setAddError('Key required'); return; }
    setAddBusy(true);
    setAddError(null);
    try {
      // changeApiKey rejects definite OpenAI auth failures server-side, so
      // the success path only does one OpenAI validation round trip.
      const result = await api.changeApiKey(trimmed);
      if (!mountedRef.current) return;
      setAddKey('');
      setState((s) => (s ? { ...s, hasKey: true } : s));
      dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
      if (result.warning) actions.toast(`OpenAI key saved, but validation could not reach OpenAI: ${result.warning}`, { level: 'warning' });
      void actions.markVisibleFilesStashing();
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
        error: 'Semantic search is disabled until you add an OpenAI API key. Switch to keyword search to search without embeddings.',
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

  return (
    <>
      <div className="settings-panel">
        <div className="settings-section">
          <div className="settings-section-title">OpenAI API key</div>
          <div className="settings-section-hint">
            StashBase indexes your content for semantic search using OpenAI embeddings
            (<code>text-embedding-3-small</code>).
          </div>
          {state.hasKey ? (
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
          ) : (
            <>
              <div className="settings-field-row">
                <input
                  type="password"
                  className="settings-text-input"
                  placeholder="sk-…"
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
            Stored locally in <code>~/.stashbase/config.json</code>. The key is used only for
            embeddings — never chat or completions — and costs about $0.02 per million tokens.
          </div>
        </div>
      </div>

      {keyEditOpen && (
        <KeyModal
          mode="change"
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
