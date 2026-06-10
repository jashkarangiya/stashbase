/**
 * Unified Settings modal — left nav (sections) + right content panel.
 * Replaces the old standalone MCP modal and the chrome-row dropdowns
 * for Embedder. Sections are imported as panels so each one keeps its
 * own state / auxiliary modals independent. (Agent selection moved out
 * to the chat panel's split button — see ChatPane.)
 *
 * Open from anywhere via the `openSettings(section?)` helper or by
 * dispatching the `stashbase-open-settings` event with an optional
 * `detail.section` payload — Welcome's MCP CTA and the chrome gear
 * button both go through this.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { EmbeddingPanel } from './settings/EmbeddingPanel';
import { McpClientsPanel } from './settings/McpClientsPanel';
import { StoragePanel } from './settings/StoragePanel';
import { CapturePanel } from './settings/CapturePanel';

export type SettingsSection = 'storage' | 'embedding' | 'mcp' | 'capture';

const SECTIONS: { id: SettingsSection; label: string; render: () => ReactNode }[] = [
  { id: 'storage', label: 'Storage', render: () => <StoragePanel /> },
  { id: 'capture', label: 'Capture', render: () => <CapturePanel /> },
  { id: 'embedding', label: 'Embedding', render: () => <EmbeddingPanel /> },
  { id: 'mcp', label: 'MCP', render: () => <McpClientsPanel /> },
];

interface OpenDetail {
  section?: SettingsSection;
}

interface LockDetail {
  locked?: boolean;
}

/** Fire from anywhere to open the Settings modal. Optional `section`
 *  picks the initial pane (default: storage). */
export function openSettings(section?: SettingsSection): void {
  window.dispatchEvent(
    new CustomEvent<OpenDetail>('stashbase-open-settings', { detail: { section } }),
  );
}

/** Mount once at the app root; listens for `openSettings` events and
 *  renders the modal when triggered. */
export function SettingsPortal() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>('storage');
  const [interactionLocked, setInteractionLocked] = useState(false);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      if (detail?.section && !interactionLocked) setSection(detail.section);
      setOpen(true);
    }
    function onLock(e: Event) {
      const detail = (e as CustomEvent<LockDetail>).detail;
      setInteractionLocked(detail?.locked === true);
    }
    window.addEventListener('stashbase-open-settings', onOpen);
    window.addEventListener('stashbase-settings-lock', onLock);
    return () => {
      window.removeEventListener('stashbase-open-settings', onOpen);
      window.removeEventListener('stashbase-settings-lock', onLock);
    };
  }, [interactionLocked]);

  return open ? (
    <SettingsModal
      initialSection={section}
      interactionLocked={interactionLocked}
      onClose={() => {
        if (!interactionLocked) setOpen(false);
      }}
    />
  ) : null;
}

function SettingsModal({
  initialSection,
  interactionLocked,
  onClose,
}: {
  initialSection: SettingsSection;
  interactionLocked: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<SettingsSection>(initialSection);
  const active = SECTIONS.find((s) => s.id === current) ?? SECTIONS[0];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !interactionLocked) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactionLocked, onClose]);

  return (
    <div className="modal-veil" onClick={interactionLocked ? undefined : onClose}>
      <div
        className="modal-card settings-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h3>Settings</h3>
          <button
            type="button"
            className="settings-close"
            aria-label="Close settings"
            onClick={onClose}
            disabled={interactionLocked}
          >×</button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === current}
                className={'settings-nav-item' + (s.id === current ? ' current' : '')}
                disabled={interactionLocked}
                onClick={() => setCurrent(s.id)}
              >{s.label}</button>
            ))}
          </nav>
          <div className="settings-content" role="tabpanel">
            {active.render()}
          </div>
        </div>
      </div>
    </div>
  );
}
