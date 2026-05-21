/**
 * Settings → Embedding panel. Lifted out of the old chrome-row chip
 * (`EmbedderControl`). Same auxiliary modals (KeyModal /
 * ConfirmSwitchModal / RemoveKeyModal) wrapped here. The
 * `RequireApiKeyModal` auto-pop on space load lives in
 * `EmbedderRequireKeyGate` so it fires whether or not Settings is open.
 */
import { useEffect, useState } from 'react';
import { api, type EmbedderProvider, type EmbedderState } from '../../api';
import { CheckIcon } from '../../icons';
import { LABEL, DETAIL } from '../embedder/labels';
import { KeyModal } from '../embedder/KeyModal';
import { RemoveKeyModal } from '../embedder/RemoveKeyModal';
import { ConfirmSwitchModal, type ConfirmDraft } from '../embedder/ConfirmSwitchModal';

export function EmbeddingPanel() {
  const [state, setState] = useState<EmbedderState | null>(null);
  const [keyModalFor, setKeyModalFor] = useState<EmbedderProvider | null>(null);
  const [keyEditOpen, setKeyEditOpen] = useState(false);
  const [keyRemoveOpen, setKeyRemoveOpen] = useState(false);
  const [confirmDraft, setConfirmDraft] = useState<ConfirmDraft | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getEmbedder()
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { /* startup race — silent */ });
    return () => { cancelled = true; };
  }, []);

  function onPick(next: EmbedderProvider) {
    if (!state || next === state.provider) return;
    setConfirmDraft({ provider: next });
  }

  async function commitSwitch(provider: EmbedderProvider, openaiKey?: string) {
    setSwitching(true);
    setSwitchError(null);
    try {
      const next = await api.setEmbedder(provider, openaiKey);
      setState({ provider: next.provider, hasKey: next.hasKey });
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchError(msg);
      return false;
    } finally {
      setSwitching(false);
    }
  }

  async function onConfirm() {
    if (!confirmDraft || !state) return;
    if (
      confirmDraft.provider === 'openai'
      && !state.hasKey
      && !confirmDraft.openaiKey
    ) {
      setConfirmDraft(null);
      setKeyModalFor('openai');
      return;
    }
    const ok = await commitSwitch(confirmDraft.provider, confirmDraft.openaiKey);
    if (ok) setConfirmDraft(null);
  }

  async function onKeySaved(key: string) {
    setKeyModalFor(null);
    const ok = await commitSwitch('openai', key);
    if (!ok) setConfirmDraft({ provider: 'openai', openaiKey: key });
  }

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

  if (!state) return <div className="settings-panel-loading">Loading…</div>;

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-title">Embedding provider</div>
        <div className="settings-section-hint">
          Switching re-embeds this space. The provider is stored per-space; one OpenAI key is shared across all spaces.
        </div>
        <div className="settings-radio-list">
          {(['onnx', 'openai'] as EmbedderProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              className={'settings-radio-row' + (p === state.provider ? ' current' : '')}
              onClick={() => onPick(p)}
            >
              <span className="settings-radio-text">
                <span className="settings-radio-name">{LABEL[p]}</span>
                <span className="settings-radio-detail">{DETAIL[p]}</span>
              </span>
              {p === state.provider && <CheckIcon className="settings-radio-check" />}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">OpenAI API key</div>
        <div className="settings-section-hint">
          Stored owner-only in <code>~/.stashbase/config.json</code>. Used for embedding requests only.
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

      {keyModalFor && (
        <KeyModal
          onCancel={() => setKeyModalFor(null)}
          onSaved={onKeySaved}
        />
      )}
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
      {confirmDraft && (
        <ConfirmSwitchModal
          draft={confirmDraft}
          switching={switching}
          error={switchError}
          onCancel={() => {
            if (switching) return;
            setConfirmDraft(null);
            setSwitchError(null);
          }}
          onConfirm={onConfirm}
        />
      )}
    </>
  );
}
