import {
  ChevronDownIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  SyncIcon,
} from '../icons';
import { useApp } from '../store/AppContext';
import { ActivityBar } from './ActivityBar';
import { FileTree } from './FileTree';
import { LibraryPanel } from './LibraryPanel';
import { ModalShell } from './ModalShell';
import { Outline } from './Outline';
import { SearchPanel } from './SearchPanel';
import { api, errorMessage } from '../api';
import { useEffect, useRef, useState, type DragEvent } from 'react';

const FILE_MIME = 'application/x-stashbase-file';
interface ElectronBridge {
  openSpaceWindow?: (name: string) => Promise<boolean>;
}

/**
 * Left rail composition. The activity bar (narrow icon column on the
 * far left) toggles between three mutually-exclusive side panels:
 *   - Files   → SnapshotWarning, space header, file tree, outline
 *   - Search  → search input + ≈/= toggle + result list (see
 *               `SearchPanel.tsx`)
 *   - Library → KB-root file list (STASHBASE.md + future root docs)
 *
 * Each panel keeps its own state when hidden — flipping back doesn't
 * blow away tree expansion or the active query.
 */
export function Sidebar() {
  const { state } = useApp();
  return (
    <aside className="sidebar">
      <ActivityBar />
      <div className="sidebar-panel">
        {state.activeSidebarView === 'search' ? <SearchPanel />
          : state.activeSidebarView === 'library' ? <LibraryPanel />
          : <FilesPanel />}
      </div>
    </aside>
  );
}

/** The current sidebar content minus the search input and the
 *  STASHBASE.md row — owns the snapshot-warning banner, the space header
 *  (with the 4 action buttons), the file tree, and the outline. */
function FilesPanel() {
  const { state, actions, dispatch } = useApp();
  const [sideHeadDrop, setSideHeadDrop] = useState(false);

  function onSideHeadDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(FILE_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setSideHeadDrop(true);
  }
  function onSideHeadDragLeave() { setSideHeadDrop(false); }
  function onSideHeadDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setSideHeadDrop(false);
    const internal = e.dataTransfer.getData(FILE_MIME);
    if (internal) {
      void actions.moveFile(internal, '');
    }
    // External imports are handled by the global drop listener which
    // computes its target from the cursor's `.tree-row.folder` /
    // `#sideHead` closest. We don't double-handle here.
  }

  const rootSelected = state.selectedPath === '';

  return (
    <div className="files-panel" id="sidebar-panel-files" role="tabpanel">
      <SnapshotWarningBanner />
      <div
        id="sideHead"
        className={
          'side-head'
          + (sideHeadDrop ? ' drop-target' : '')
          + (rootSelected ? ' active-root' : '')
        }
        onDragOver={onSideHeadDragOver}
        onDragLeave={onSideHeadDragLeave}
        onDrop={onSideHeadDrop}
      >
        <span className={'space-title' + (state.spaceCollapsed ? ' collapsed' : '')}>
          {/* Chevron alone toggles whole-space fold. Clicking the
              label selects "space root" so the next new-note / +folder
              lands at the top level — mirrors VSCode where the
              workspace header is itself a selectable container. */}
          <span
            className="space-chev"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'SPACE_FOLD_TOGGLE' });
            }}
          ><ChevronDownIcon /></span>
          <span
            className="folder-label"
            title={state.space || 'notes'}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'ACTIVE_FOLDER', path: '' });
            }}
          >{(state.space || 'notes').toUpperCase()}</span>
        </span>
        <div className="side-actions">
          <SpaceMenu />
          <NewNoteButton />
          <button
            className="icon-btn"
            type="button"
            title={'New folder in ' + (state.activeFolder || (state.space || 'space root'))}
            onClick={() => {
              // Make sure the target parent is expanded so the inline
              // input appears in view; FileTree mounts it there.
              if (state.activeFolder) {
                dispatch({ type: 'EXPAND_FOLDER', path: state.activeFolder });
              }
              dispatch({ type: 'NEW_FOLDER_INPUT', open: true });
            }}
          ><NewFolderIcon /></button>
          <SyncButton />
          <FolderFoldToggle />
        </div>
      </div>
      <div className={'file-list' + (state.spaceCollapsed ? ' collapsed' : '')}>
        {state.pendingConversions.length > 0 && (
          <div className="pdf-processing-banner">
            {state.pendingConversions.map((p) => (
              <div key={p} className="pdf-processing-row" title={p}>
                <span className="pdf-processing-spinner" />
                <span className="pdf-processing-label">
                  Processing <strong>{p.split('/').pop()}</strong>…
                </span>
              </div>
            ))}
          </div>
        )}
        <FileTree />
      </div>
      <Outline />
    </div>
  );
}

function SpaceMenu() {
  const { state, actions } = useApp();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | { kind: 'new' | 'rename' | 'switch'; name: string }>(null);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = state.space || '';

  async function loadSpaces() {
    try {
      const r = await api.listAvailableSpaces();
      setSpaces(r.names);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function openModal(kind: 'new' | 'rename' | 'switch') {
    setOpen(false);
    setError(null);
    if (kind === 'switch') void loadSpaces();
    setModal({ kind, name: kind === 'rename' ? current : '' });
  }

  async function submitName() {
    if (!modal) return;
    const name = modal.name.trim();
    if (!name) { setError('Name required'); return; }
    setBusy(true);
    setError(null);
    const prevSpaces = spaces;
    try {
      if (modal.kind === 'new') {
        setSpaces((currentSpaces) => currentSpaces.includes(name) ? currentSpaces : [...currentSpaces, name].sort());
        await actions.openSpaceByName(name);
      } else if (modal.kind === 'rename') {
        setSpaces((currentSpaces) => currentSpaces.map((v) => (v === current ? name : v)).sort());
        await api.renameSpace(current, name);
        await actions.openSpaceByName(name);
      } else {
        await actions.openSpaceByName(name);
      }
      setModal(null);
    } catch (err) {
      setSpaces(prevSpaces);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(name: string) {
    setBusy(true);
    setError(null);
    setModal({ kind: 'switch', name });
    try {
      await actions.openSpaceByName(name);
      setModal(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrent() {
    setOpen(false);
    if (!current) return;
    const ok = await actions.confirm(`Delete space "${current}" and everything inside it?`);
    if (!ok) return;
    const prevSpaces = spaces;
    setSpaces((currentSpaces) => currentSpaces.filter((name) => name !== current));
    actions.goHome();
    try {
      await api.deleteSpace(current);
    } catch (err) {
      setSpaces(prevSpaces);
      try { await actions.openSpaceByName(current); } catch { /* original delete error is what matters */ }
      await actions.alert('Delete failed: ' + errorMessage(err));
    }
  }

  async function openCurrentInNewWindow() {
    setOpen(false);
    if (!current) return;
    const bridge = (window as { electron?: ElectronBridge }).electron;
    const ok = await bridge?.openSpaceWindow?.(current);
    if (!ok) await actions.alert('New window is only available in the desktop app.');
  }

  return (
    <>
      <span className="space-menu-wrap">
        <button
          className="icon-btn"
          type="button"
          title="Space actions"
          onClick={() => setOpen((v) => !v)}
        >⋯</button>
        {open && (
          <>
            <div className="embedder-backdrop" onClick={() => setOpen(false)} />
            <div className="space-menu" role="menu">
              <button type="button" onClick={() => openModal('switch')}>Switch space</button>
              <button type="button" onClick={() => { void openCurrentInNewWindow(); }} disabled={!current}>Open in new window</button>
              <button type="button" onClick={() => openModal('new')}>New space</button>
              <button type="button" onClick={() => openModal('rename')} disabled={!current}>Rename space</button>
              <button type="button" className="danger" onClick={() => { void deleteCurrent(); }} disabled={!current}>Delete space</button>
            </div>
          </>
        )}
      </span>
      {modal && (
        <ModalShell onCancel={busy ? () => {} : () => setModal(null)}>
          <h3>{modal.kind === 'new' ? 'New space' : modal.kind === 'rename' ? 'Rename space' : 'Switch space'}</h3>
          {modal.kind === 'switch' ? (
            spaces.length === 0 ? (
              <p className="modal-hint">No spaces found.</p>
            ) : (
              <div className="welcome-open-list">
                {spaces.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="welcome-open-row"
                    disabled={busy || name === current}
                    onClick={() => { void switchTo(name); }}
                  >
                    <FolderIcon className="welcome-open-row-icon" />
                    <span className="welcome-open-row-name">{name}</span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <input
              type="text"
              className="modal-input"
              autoFocus
              spellCheck={false}
              value={modal.name}
              disabled={busy}
              onChange={(e) => setModal({ ...modal, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') { e.preventDefault(); void submitName(); }
                if (e.key === 'Escape' && !busy) { e.preventDefault(); setModal(null); }
              }}
            />
          )}
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="modal-btn" onClick={() => setModal(null)} disabled={busy}>Cancel</button>
            {modal.kind !== 'switch' && (
              <button type="button" className="modal-btn primary" onClick={() => { void submitName(); }} disabled={busy || !modal.name.trim()}>
                {busy ? 'Saving…' : modal.kind === 'new' ? 'Create' : 'Rename'}
              </button>
            )}
          </div>
        </ModalShell>
      )}
    </>
  );
}

/** "+" icon in the sidebar header that opens a small picker for the
 *  new note's format. Default is HTML — what the README recommends
 *  for content meant to outlive a chat session — but Markdown stays
 *  one click away for quick drafts. Format is decided at create time,
 *  not via a setting; the picker enforces an explicit choice every
 *  time without making either option feel hidden.
 *
 *  The popover uses `position: fixed` with coords measured off the
 *  button — sidebar containers further up the tree have `overflow:
 *  hidden` and would otherwise clip an absolutely-positioned menu
 *  rendered inside them. Fixed lets the menu float over the whole
 *  viewport instead. */
function NewNoteButton() {
  const { state, actions } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const target = state.activeFolder || state.space || 'space root';

  function toggle() {
    if (menuOpen) { setMenuOpen(false); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    // Anchor the menu's LEFT edge to the button's left edge so it
    // grows RIGHTWARD into the main pane area. Anchoring right-edge
    // to button-right makes the menu bleed off the viewport's left
    // edge whenever the sidebar is narrower than the menu's min-width
    // (the menu's 220 px ends up at x ≈ -30, clipping "H"/"M").
    // position:fixed escapes sidebar overflow either way.
    setPos({ top: r.bottom + 4, left: r.left });
    setMenuOpen(true);
  }

  function create(format: 'html' | 'md') {
    setMenuOpen(false);
    void actions.newNote(format);
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        type="button"
        title={'New note in ' + target}
        onClick={toggle}
      ><NewFileIcon /></button>
      {menuOpen && pos && (
        <>
          <div className="embedder-backdrop" onClick={() => setMenuOpen(false)} />
          <div
            className="embedder-menu"
            role="menu"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              // Explicit `auto` because `.embedder-menu` sets `right: 0`
              // at the class level; we need it cleared so `left` wins.
              right: 'auto',
              minWidth: 200,
            }}
          >
            <button
              type="button"
              className="embedder-menu-item"
              onClick={() => create('html')}
            >
              <span className="embedder-menu-text">
                <span className="embedder-menu-name">HTML note</span>
                <span className="embedder-menu-detail">richer structure · default</span>
              </span>
            </button>
            <button
              type="button"
              className="embedder-menu-item"
              onClick={() => create('md')}
            >
              <span className="embedder-menu-text">
                <span className="embedder-menu-name">Markdown note</span>
                <span className="embedder-menu-detail">quick draft</span>
              </span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** One-time banner shown above the file tree when the active space's
 *  most recent snapshot import skipped chunks because their provider
 *  key didn't match the library's current embedder. Most users will
 *  see this exactly once (after cloning a starter space whose snapshot
 *  was exported with a different embedder). The banner offers a quick
 *  link to the embedder settings + a dismiss button. */
function SnapshotWarningBanner() {
  const { state, actions } = useApp();
  const w = state.snapshotWarning;
  if (!w) return null;
  const detail = w.details
    .map((d) => `${d.chunks} from ${d.provider}`)
    .join(', ');
  return (
    <div className="snapshot-warning">
      <div className="snapshot-warning-body">
        <div className="snapshot-warning-title">
          Snapshot partly imported
        </div>
        <div className="snapshot-warning-msg">
          Skipped {w.skipped} chunk{w.skipped === 1 ? '' : 's'} ({detail}).
          Switch the library's embedder to match — or re-export the snapshot.
        </div>
      </div>
      <button
        type="button"
        className="snapshot-warning-dismiss"
        title="Dismiss"
        onClick={() => { void actions.dismissSnapshotWarning(); }}
      >×</button>
    </div>
  );
}

function SyncButton() {
  const { actions } = useApp();
  const [tip, setTip] = useState('Re-scan disk for external changes');
  // Decoupled from `state.syncRunning` so the icon keeps spinning for
  // a guaranteed minimum even when the sync request resolves in <100ms
  // (small / already-indexed spaces). Without this the click felt
  // like nothing happened.
  const [spinning, setSpinning] = useState(false);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current); }, []);

  return (
    <button
      className={'icon-btn' + (spinning ? ' spinning' : '')}
      type="button"
      title={spinning ? 'Syncing…' : tip}
      disabled={spinning}
      onClick={async () => {
        setSpinning(true);
        setTip('Syncing…');
        const minSpin = new Promise((r) => setTimeout(r, 600));
        let ok = true;
        try {
          await Promise.all([actions.runSync(), minSpin]);
        } catch {
          ok = false;
          await minSpin;
        }
        setSpinning(false);
        setTip(ok ? 'Synced' : 'Sync failed');
        if (tipTimer.current) clearTimeout(tipTimer.current);
        tipTimer.current = setTimeout(
          () => setTip('Re-scan disk for external changes'),
          3000,
        );
      }}
    ><SyncIcon /></button>
  );
}

/** Toggle button: collapse-all when anything is open, expand-all when
 *  everything's already folded. Mirrors VSCode's explorer toolbar
 *  button so a single click always does the "obvious" thing for the
 *  current state. */
function FolderFoldToggle() {
  const { state, dispatch } = useApp();
  const allCollapsed = state.expanded.size === 0;
  return (
    <button
      className="icon-btn"
      type="button"
      title={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
      onClick={() => {
        if (allCollapsed) {
          dispatch({
            type: 'EXPAND_ALL_FOLDERS',
            paths: state.folders.map((f) => f.path),
          });
        } else {
          dispatch({ type: 'COLLAPSE_ALL_FOLDERS' });
        }
      }}
    >{allCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}</button>
  );
}
