/**
 * Mounted once at the app root: on every space switch, if the
 * library-wide embedder is OpenAI (the default) but no global key is
 * on file, pop the `RequireApiKeyModal`. Used to live inside the
 * chrome `EmbedderControl` chip; lifted out because the chip moved
 * into Settings and we still want the prompt to fire whether or not
 * Settings is open.
 *
 * Three exits from the modal:
 *   • Save key — validates + persists, daemon hot-swap.
 *   • Use Local instead — switches the whole library to onnx.
 *   • Later — dismiss; re-pops on next space open.
 */
import { useEffect, useState } from 'react';
import { api, type EmbedderProvider, type EmbedderState } from '../api';
import { useApp } from '../store/AppContext';
import { RequireApiKeyModal } from './embedder/RequireApiKeyModal';

export function EmbedderRequireKeyGate() {
  const { state: appState } = useApp();
  const space = appState.space;
  const [state, setState] = useState<EmbedderState | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!space) { setState(null); setOpen(false); return; }
    let cancelled = false;
    api.getEmbedder()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setOpen(s.provider === 'openai' && !s.hasKey);
      })
      .catch(() => { /* startup race with server boot — silent */ });
    return () => { cancelled = true; };
  }, [space]);

  async function commitSwitch(provider: EmbedderProvider) {
    setSwitching(true);
    try {
      const next = await api.setEmbedder(provider);
      setState({ provider: next.provider, hasKey: next.hasKey });
      return true;
    } catch {
      return false;
    } finally {
      setSwitching(false);
    }
  }

  if (!open || !state || state.provider !== 'openai' || state.hasKey) return null;

  return (
    <RequireApiKeyModal
      switching={switching}
      onSaved={() => {
        setState((s) => (s ? { ...s, hasKey: true } : s));
        setOpen(false);
      }}
      onUseLocal={async () => {
        const ok = await commitSwitch('onnx');
        if (ok) setOpen(false);
      }}
      onLater={() => setOpen(false)}
    />
  );
}
