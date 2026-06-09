import { useEffect, useState } from 'react';
import { FilesViewIcon, RecordIcon, RegionCaptureIcon, SearchIcon, SettingsIcon, StopIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { openSettings } from './SettingsModal';

interface CaptureBridge {
  /** Region screenshot → image saved + OCR'd (same path as other images). */
  capture?: (request: { mode: string }) => Promise<unknown>;
  /** Start screen recording → Gemini video understanding → note. */
  startRecording?: () => void;
  stopRecording?: () => void;
  onRecordingState?: (handler: (recording: boolean) => void) => (() => void);
}

function captureBridge(): CaptureBridge | undefined {
  return (window as { electron?: CaptureBridge }).electron;
}

/**
 * Narrow left rail (à la VS Code / Obsidian) holding one icon per
 * sidebar view. Two mutually-exclusive views:
 *
 *   - files   → KB-root files + space-scoped tree
 *   - search  → search input + result list
 *
 * Exactly one icon is "active" at a time — the active state is bound
 * to `state.activeSidebarView`, NOT to whatever happens to be focused
 * in the main pane, so the bar always reads as "what view am I in".
 * Not persisted across launches — the AppProvider always boots into
 * `files` (the tree is the canonical landing surface; search is a task
 * the user enters on purpose, not a state to restore).
 */
export function ActivityBar() {
  const { state, dispatch, actions } = useApp();

  // Screen recording trigger (desktop app only). The button doubles as
  // the stop control while recording — main pushes the state so it stays
  // in sync no matter how recording was started or stopped (e.g. the
  // macOS recording indicator).
  const [recording, setRecording] = useState(false);
  const isElectron = !!captureBridge();
  useEffect(() => captureBridge()?.onRecordingState?.(setRecording), []);

  function captureRegion() {
    void captureBridge()?.capture?.({ mode: 'region' });
  }

  function toggleRecording() {
    const bridge = captureBridge();
    if (recording) bridge?.stopRecording?.();
    else bridge?.startRecording?.();
  }

  /** VSCode rail semantics: clicking the *active* view toggles the
   *  panel collapsed; clicking another view (or any view while
   *  collapsed) opens it on that view. `after` runs the view's
   *  side effect (e.g. focus search) only when we land on it — never
   *  on a collapse. */
  function selectView(view: 'files' | 'search', after?: () => void) {
    if (!state.sidebarCollapsed && state.activeSidebarView === view) {
      dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: true });
      return;
    }
    dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: false });
    dispatch({ type: 'SIDEBAR_VIEW', view });
    after?.();
  }

  return (
    <nav className="activity-bar" role="tablist" aria-label="Sidebar views">
      <ActivityIcon
        active={!state.sidebarCollapsed && state.activeSidebarView === 'files'}
        controls="sidebar-panel-files"
        label="Files (⌘⇧E)"
        onClick={() => selectView('files')}
      >
        <FilesViewIcon />
      </ActivityIcon>
      <ActivityIcon
        active={!state.sidebarCollapsed && state.activeSidebarView === 'search'}
        controls="sidebar-panel-search"
        label="Search (⌘⇧F)"
        // Focusing the input after the view switch lets ⌘⇧F (and a
        // mouse click) feel the same — both end with the caret in
        // the search box ready for typing.
        onClick={() => selectView('search', () => actions.focusSearch())}
      >
        <SearchIcon />
      </ActivityIcon>
      {/* Capture group — desktop only. Region screenshot (still → OCR) on
          top, video understanding (recording → Gemini) below. */}
      {isElectron && (
        <>
          <button
            type="button"
            className="activity-bar-btn"
            onClick={captureRegion}
            title="Region screenshot"
          >
            <RegionCaptureIcon />
          </button>
          <button
            type="button"
            className={'activity-bar-btn' + (recording ? ' recording' : '')}
            onClick={toggleRecording}
            title={recording ? 'Stop recording' : 'Record screen (video understanding)'}
            aria-pressed={recording}
          >
            {recording ? <StopIcon /> : <RecordIcon />}
          </button>
        </>
      )}
      {/* Settings pinned to the bottom of the rail, VSCode-style. The
          spacer above (margin-top:auto on this button) pushes it down
          so view toggles stay grouped at the top. */}
      <button
        type="button"
        className="activity-bar-btn activity-bar-btn-bottom"
        onClick={() => openSettings()}
        title="Settings"
      >
        <SettingsIcon />
      </button>
    </nav>
  );
}

interface ActivityIconProps {
  active: boolean;
  controls: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ActivityIcon({ active, controls, label, onClick, children }: ActivityIconProps) {
  return (
    <button
      type="button"
      className={'activity-bar-btn' + (active ? ' active' : '')}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}
