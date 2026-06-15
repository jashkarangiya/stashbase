import { useEffect, useState } from 'react';
import { FilesViewIcon, RecordIcon, SearchIcon, SettingsIcon, StopIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { api } from '../api';
import { openSettings } from './SettingsModal';
import { useHoverTip } from '../hooks/useHoverTip';

interface CaptureBridge {
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
 * The view is NOT persisted across launches — every relaunch lands on
 * Files (the canonical landing spot; Search is entered on demand).
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

  const recordLabel = recording ? 'Stop recording' : 'Record screen (video understanding)';
  const recordTip = useHoverTip(recordLabel);
  const settingsTip = useHoverTip('Settings');

  async function toggleRecording() {
    const bridge = captureBridge();
    if (recording) { bridge?.stopRecording?.(); return; }
    // Recording is Gemini-only (no local fallback) — check the key BEFORE
    // capture starts, so the user never loses a recording to a missing key.
    try {
      const { hasKey } = await api.getGeminiKey();
      if (!hasKey) {
        actions.toast('Screen recording needs a Gemini API key — add one in Settings → Capture.', { level: 'error' });
        return;
      }
    } catch { /* server unreachable — let the route's own guard handle it */ }
    bridge?.startRecording?.();
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
      {/* Screen recording — desktop only. Video understanding (recording →
          Gemini). Doubles as the stop control while recording. */}
      {isElectron && (
        <button
          type="button"
          className={'activity-bar-btn' + (recording ? ' recording' : '')}
          onClick={toggleRecording}
          aria-label={recordLabel}
          aria-pressed={recording}
          {...recordTip.tipProps}
        >
          {recording ? <StopIcon /> : <RecordIcon />}
          {recordTip.tip}
        </button>
      )}
      {/* Settings pinned to the bottom of the rail, VSCode-style. The
          spacer above (margin-top:auto on this button) pushes it down
          so view toggles stay grouped at the top. */}
      <button
        type="button"
        className="activity-bar-btn activity-bar-btn-bottom"
        onClick={() => openSettings()}
        aria-label="Settings"
        {...settingsTip.tipProps}
      >
        <SettingsIcon />
        {settingsTip.tip}
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
  const { tipProps, tip } = useHoverTip(label);
  return (
    <button
      type="button"
      className={'activity-bar-btn' + (active ? ' active' : '')}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      aria-label={label}
      onClick={onClick}
      {...tipProps}
    >
      {children}
      {tip}
    </button>
  );
}
