/**
 * Re-embed confirmation. Loads the cost estimate on mount and waits
 * for the user to confirm before the actual provider-switch PUT fires.
 * The `error` prop is filled in by the parent when `commitSwitch`
 * fails; the modal stays open so the user can retry without losing
 * their place.
 */
import { useEffect, useState } from 'react';
import {
  api,
  errorMessage,
  type EmbedderCostEstimate,
  type EmbedderProvider,
} from '../../api';
import { ModalShell } from '../ModalShell';
import { LABEL } from './labels';

export interface ConfirmDraft {
  provider: EmbedderProvider;
  openaiKey?: string;
}

export function ConfirmSwitchModal({
  draft,
  switching,
  error,
  onCancel,
  onConfirm,
}: {
  draft: ConfirmDraft;
  switching: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [estimate, setEstimate] = useState<EmbedderCostEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.embedderCostEstimate(draft.provider)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch((err) => { if (!cancelled) setEstimateError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [draft.provider]);

  const label = LABEL[draft.provider];

  return (
    <ModalShell wide onCancel={onCancel}>
      <h3>Switch to {label}?</h3>
      <p className="modal-hint">
        Rebuilds the search index across every space. Existing vectors stay searchable while the re-embed runs in the background.
      </p>
      <div className="modal-stats">
        {estimate ? (
          <>
            <Stat label="Files" value={estimate.files.toLocaleString()} />
            <Stat label="Tokens (est.)" value={estimate.tokens.toLocaleString()} />
            <Stat
              label={draft.provider === 'openai' ? 'API cost (est.)' : 'API cost'}
              value={draft.provider === 'openai' ? formatUsd(estimate.costUsd) : 'free'}
              highlight={draft.provider === 'openai'}
            />
          </>
        ) : estimateError ? (
          <div className="modal-error">Couldn't estimate: {estimateError}</div>
        ) : (
          <div className="modal-hint">Estimating…</div>
        )}
      </div>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onCancel} disabled={switching}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={onConfirm}
          disabled={switching}
        >{switching ? 'Switching…' : `Switch to ${label}`}</button>
      </div>
    </ModalShell>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="modal-stat">
      <div className="modal-stat-label">{label}</div>
      <div className={'modal-stat-value' + (highlight ? ' highlight' : '')}>{value}</div>
    </div>
  );
}

function formatUsd(usd: number): string {
  if (usd < 0.01) return `< $0.01`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}
