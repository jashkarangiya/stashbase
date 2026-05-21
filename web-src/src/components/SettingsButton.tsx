/**
 * Chrome-row gear button. One click opens the unified Settings modal
 * (Embedding / MCP / Chat CLI). The modal itself lives in
 * `SettingsModal.tsx` and is mounted via `<SettingsPortal />` at the
 * app root.
 */
import { SettingsIcon } from '../icons';
import { openSettings } from './SettingsModal';

export function SettingsButton() {
  return (
    <button
      className="icon-btn"
      type="button"
      title="Settings"
      onClick={() => openSettings()}
    >
      <SettingsIcon />
    </button>
  );
}
