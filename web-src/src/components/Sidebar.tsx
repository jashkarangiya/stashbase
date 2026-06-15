import {
  ChevronDownIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  StashBaseIcon,
  SyncIcon,
} from '../icons';
import { useApp } from '../store/AppContext';
import { stashingPaths } from '../store/state';
import { ActivityBar } from './ActivityBar';
import { FileTree } from './FileTree';
import { Menu, type MenuItem } from './Menu';
import { ModalShell } from './ModalShell';
import { SearchPanel } from './SearchPanel';
import { api, errorMessage } from '../api';
import { FILE_MIME } from '../dragMime';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';

interface ElectronBridge {
  openSpaceWindow?: (name: string) => Promise<boolean>;
}

/**
 * Left rail composition. The activity bar (narrow icon column on the
 * far left) toggles between two mutually-exclusive side panels:
 *   - Files   → a KNOWLEDGE BASE section (KB-root STASHBASE.md), then
 *               the SnapshotWarning, the SPACE header, and the file tree
 *   - Search  → search input + ≈/= toggle + result list (see
 *               `SearchPanel.tsx`)
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
        {state.activeSidebarView === 'search' ? <SearchPanel /> : <FilesPanel />}
      </div>
    </aside>
  );
}

/** KB-root governance file pinned at the top of the Files panel —
 *  STASHBASE.md (the rules book). KB-scope (the same in every window /
 *  space), so it sits above the per-space tree as a scope label, not
 *  inside it. Per-space STASHBASE.md files live in the tree below, where
 *  they physically are. */
function KbSection() {
  const { state, actions } = useApp();
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const activeKbName = activeTab?.file?.kind === 'kb' ? activeTab.file.name : null;

  return (
    <>
      <div className="panel-section-head">
        <span className="panel-section-title">Knowledge base</span>
      </div>
      <div className="kb-file-list">
        <button
          type="button"
          className={'kb-file-row' + (activeKbName === 'STASHBASE.md' ? ' selected' : '')}
          onClick={() => { void actions.openKbRules(); }}
          title="KB-level maintenance rules (STASHBASE.md)"
        >
          <span className="kb-file-icon"><StashBaseIcon /></span>
          <span className="kb-file-label">STASHBASE.md</span>
        </button>
      </div>
    </>
  );
}

/** The current sidebar content minus the search input — owns the
 *  KNOWLEDGE BASE section, the snapshot-warning banner, a VSCode-style
 *  two-tier SPACE header (a "SPACE" section row with the space-actions ⋯
 *  above the folder row: current space name + the 4 file-action
 *  buttons), and the file tree. */
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
      <KbSection />
      <SnapshotWarningBanner />
      {/* VSCode-style two-tier header: a section-title row ("SPACE" +
          space-actions ⋯, mirroring EXPLORER) above the folder row
          (current space name + file actions). */}
      <div className="panel-section-head space-section-head">
        <span className="panel-section-title">SPACE</span>
        {/* Stashing status sits left, right after the SPACE label — and
            OUTSIDE .side-actions (which is hover-reveal-only) so the count
            stays visible at all times. The ⋯ actions are pushed to the
            right edge via `margin-left:auto`. */}
        <StashingIndicator />
        <div className="side-actions">
          <SpaceMenu />
        </div>
      </div>
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
        <FileTree />
      </div>
    </div>
  );
}

/** "N stashing" pill in the SPACE header (left of the ⋯ actions). A
 *  file is *stashing* while the server is still turning it into
 *  searchable content — BOTH the slow conversion phase (PDF/image OCR,
 *  recording transcode) and the indexing/embedding phase that every
 *  dropped file goes through. `stashingPaths` unions the two so a folder
 *  drop of plain markdown gets a count too, not just PDFs. Counts the
 *  active space only. Clicking opens a Chrome-downloads-style list of
 *  what's in flight. The logo is a placeholder for the eventual animated
 *  "stashing" mark. */
function StashingIndicator() {
  const { state } = useApp();
  const items = stashingPaths(state);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  if (items.length === 0) return null;

  function toggle() {
    if (anchor) { setAnchor(null); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="stashing-pill"
        title={`${items.length} file${items.length === 1 ? '' : 's'} stashing`}
        onClick={toggle}
      >
        <StashBaseIcon className="stashing-pill-logo" />
        <span className="stashing-pill-count">{items.length} stashing</span>
      </button>
      {anchor && (
        <StashingList anchor={anchor} items={items} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}

/** The dropdown list anchored under the stashing pill. Right-aligned to
 *  the pill and clamped into the viewport (mirrors `Menu`'s fixed-
 *  position approach so it escapes the sidebar's `overflow: hidden`). */
function StashingList({
  anchor,
  items,
  onClose,
}: {
  anchor: DOMRect;
  items: string[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = anchor.left; // left-align to the pill (sits on the left)
    let top = anchor.bottom + 4;
    left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - height - 6));
    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, [anchor]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={'stashing-list' + (pos ? ' ready' : '')}
      style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0 }}
    >
      <div className="stashing-list-head">Stashing</div>
      {items.map((p) => (
        <div key={p} className="stashing-list-row" title={p}>
          <StashBaseIcon className="stashing-list-logo" />
          <span className="stashing-list-name">{p.split('/').pop()}</span>
          <span className="stashing-list-phase">stashing…</span>
        </div>
      ))}
    </div>
  );
}

function SpaceMenu() {
  const { state, actions } = useApp();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [modal, setModal] = useState<null | { kind: 'new' | 'rename' | 'switch'; name: string }>(null);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = state.space || '';

  function toggle() {
    if (anchor) { setAnchor(null); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }

  async function loadSpaces() {
    try {
      const r = await api.listAvailableSpaces();
      setSpaces(r.names);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function openModal(kind: 'new' | 'rename' | 'switch') {
    setError(null);
    setAnchor(null);
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
        await actions.openSpaceByName(name, { create: true, exclusiveCreate: true });
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
    if (!current) return;
    const bridge = (window as { electron?: ElectronBridge }).electron;
    const ok = await bridge?.openSpaceWindow?.(current);
    if (!ok) await actions.alert('New window is only available in the desktop app.');
  }

  // Bake the space's embeddings into `.stashbase/snapshot.parquet` so the
  // folder carries reusable vectors when copied / git-cloned (the other
  // end reuses them by text_hash instead of re-embedding).
  async function exportSnapshot() {
    if (!current) return;
    setBusy(true);
    try {
      const r = await api.exportSnapshot();
      actions.toast(
        `Embedding snapshot baked — ${r.vectors} vector(s) from ${r.chunks} chunk(s) into ${current}/.stashbase/.`,
        { level: 'success' },
      );
    } catch (err) {
      actions.toast('Snapshot export failed: ' + errorMessage(err), { level: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const items: MenuItem[] = [
    { label: 'Switch space', onSelect: () => openModal('switch') },
    { label: 'Open in new window', disabled: !current, onSelect: () => { void openCurrentInNewWindow(); } },
    { label: 'New space', onSelect: () => openModal('new') },
    { label: 'Rename space', disabled: !current, onSelect: () => openModal('rename') },
    { label: 'Export embedding snapshot', detail: 'Bake reusable vectors into .stashbase/', disabled: !current, onSelect: () => { void exportSnapshot(); } },
    { separator: true },
    { label: 'Delete space', danger: true, disabled: !current, onSelect: () => { void deleteCurrent(); } },
  ];

  return (
    <>
      <button
        ref={buttonRef}
        className="icon-btn"
        type="button"
        title="Space actions"
        onClick={toggle}
      >⋯</button>
      {anchor && <Menu anchor={{ rect: anchor }} items={items} onClose={() => setAnchor(null)} />}
      {modal && (
        <ModalShell top onCancel={busy ? () => {} : () => setModal(null)}>
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
              onFocus={(e) => e.currentTarget.select()}
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

/** "+" icon in the sidebar header that creates a new Markdown note in
 *  the active folder. HTML notes were dropped once their editor went
 *  away, so there's no format picker — one click, one .md draft. */
function NewNoteButton() {
  const { state, actions } = useApp();
  const target = state.activeFolder || state.space || 'space root';

  return (
    <button
      className="icon-btn"
      type="button"
      title={'New note in ' + target}
      onClick={() => void actions.newNote()}
    ><NewFileIcon /></button>
  );
}

/** One-time banner shown above the file tree when the active space's
 *  most recent snapshot import skipped chunks because their provider
 *  key didn't match the knowledge base's current embedder. Most users will
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
          Switch the knowledge base's embedder to match — or re-export the snapshot.
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
