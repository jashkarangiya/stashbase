/**
 * Mounted once at the app root: on every folder switch, if no OpenAI key
 * is on file, pop the `RequireApiKeyModal`. V1 is OpenAI-only — without
 * a key, indexing and search are disabled, so we nudge the user to add
 * one (they can defer with "Later"; it re-pops on the next folder open).
 *
 * Two exits from the modal:
 *   • Save key — validates + persists, daemon hot-swap.
 *   • Later — dismiss; re-pops on next folder open.
 */
import { useEffect, useState } from 'react';
import { api, type EmbedderState } from '../api';
import { useApp } from '../store/AppContext';
import { RequireApiKeyModal } from './embedder/RequireApiKeyModal';

export function EmbedderRequireKeyGate() {
  const { state: appState, dispatch, actions } = useApp();
  const folder = appState.folder;
  const [state, setState] = useState<EmbedderState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!folder) { setState(null); setOpen(false); return; }
    let cancelled = false;
    api.getEmbedder()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: s.hasKey });
        setOpen(!s.hasKey);
      })
      .catch(() => { /* startup race with server boot — silent */ });
    return () => { cancelled = true; };
  }, [folder]);

  if (!open || !state || state.hasKey) return null;

  return (
    <RequireApiKeyModal
      onSaved={(warning) => {
        setState((s) => (s ? { ...s, hasKey: true } : s));
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
        setOpen(false);
        if (warning) actions.toast(`OpenAI key saved, but validation could not reach OpenAI: ${warning}`, { level: 'warning' });
        void actions.markVisibleFilesStashing();
        void actions.refreshIndexState();
      }}
      onLater={() => setOpen(false)}
    />
  );
}
