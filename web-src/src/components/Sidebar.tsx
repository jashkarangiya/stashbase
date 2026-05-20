import {
  ChevronDownIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  NewFileIcon,
  NewFolderIcon,
  SearchIcon,
  SyncIcon,
} from '../icons';
import { useApp } from '../store/AppContext';
import { FileTree } from './FileTree';
import { Outline } from './Outline';
import { useEffect, useRef, useState, type DragEvent } from 'react';

const FILE_MIME = 'application/x-stashbase-file';

/**
 * Left rail composition. Search box → space header (chevron + label +
 * 4 action buttons) → file tree → outline. The SPACE header doubles
 * as a drop target for "move to root" gestures (otherwise files in a
 * subfolder have no obvious way back up).
 */
export function Sidebar() {
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
    <aside className="sidebar">
      <SearchBox />
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
        {state.pendingConversions.length > 0 && (
          <div className="pdf-converting-banner">
            {state.pendingConversions.map((p) => (
              <div key={p} className="pdf-converting-row" title={p}>
                <span className="pdf-converting-spinner" />
                <span className="pdf-converting-label">
                  Converting <strong>{p.split('/').pop()}</strong>…
                </span>
              </div>
            ))}
          </div>
        )}
        <FileTree />
      </div>
      <Outline />
    </aside>
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

/** Sidebar search input. Fires semantic search (`/api/search`) against
 *  the chunk index; input value updates immediately for responsiveness,
 *  the actual fetch debounces 250ms so fast typing isn't a stampede.
 *  Race protection lives in `actions.runSearch` itself. */
function SearchBox() {
  const { state, actions, dispatch } = useApp();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  // Hand the input handle to the store on mount so `actions.focusSearch`
  // can reach it without a global DOM query. Mirrors the `registerEditor`
  // pattern used by CodeEditor.
  useEffect(() => {
    actions.registerSearchInput(inputRef.current);
    return () => actions.registerSearchInput(null);
  }, [actions]);

  function onChange(value: string) {
    dispatch({ type: 'FILTER', q: value });
    if (debounce.current) clearTimeout(debounce.current);
    if (!value.trim()) {
      // Clear immediately on empty — no point waiting to drop hits.
      void actions.runSearch('');
      return;
    }
    debounce.current = setTimeout(() => { void actions.runSearch(value); }, 250);
  }

  return (
    <div className="side-search">
      <SearchIcon className="side-search-icon" />
      <input
        ref={inputRef}
        type="search"
        placeholder="Search notes…"
        autoComplete="off"
        spellCheck={false}
        value={state.filterQuery}
        onChange={(e) => onChange(e.target.value)}
      />
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

