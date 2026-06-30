import { useRef, useState, type DragEvent } from 'react';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';
import { StashBaseIcon } from '../icons';

const TAB_MIME = 'application/x-stashbase-tab';

/**
 * Tab strip at the top of the main pane — one chip per open tab plus a
 * `+` button. Left-click activates, `×` (or middle-click) closes, `+`
 * pushes an empty tab (Obsidian-style). The active tab gets a stronger
 * background; inactive tabs are muted; long names ellipsize.
 *
 * Preview tabs (single-click in the sidebar) render their label
 * italic. Double-clicking the tab title promotes it to pinned — same
 * convention as VS Code's preview tabs.
 *
 * Tabs are draggable: dropping one onto another inserts it before that
 * target (or appends when dropped on the trailing strip area). The
 * dragged tab carries the rendered chip with it; we draw the drop
 * indicator as a `before` vs `after` accent on the target chip so the
 * insertion point is obvious before commit.
 *
 * All state mutations route through `AppContext` actions / dispatch —
 * this component just renders.
 */
export function TabStrip() {
  const { state, actions, dispatch } = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  // `dropTarget` carries both the target tab id and which side of the
  // chip the cursor is on. Storing this lets us paint the indicator
  // without re-deriving from event coords on every render.
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  function onDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    e.dataTransfer.effectAllowed = 'move';
    // setData is required for Firefox to fire any subsequent drag events.
    try { e.dataTransfer.setData(TAB_MIME, id); } catch { /* unwriteable in some test envs */ }
    setDragId(id);
  }

  function onDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  function onTabDragOver(e: DragEvent<HTMLDivElement>, targetId: string) {
    if (!dragId) return;
    if (dragId === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Edge based on cursor position relative to the chip — left half =
    // insert before, right half = insert after. Cheap getBoundingClientRect.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (dropTarget?.id !== targetId || dropTarget.edge !== edge) {
      setDropTarget({ id: targetId, edge });
    }
  }

  function onTabDrop(e: DragEvent<HTMLDivElement>, targetId: string) {
    if (!dragId) return;
    e.preventDefault();
    if (dragId === targetId) { onDragEnd(); return; }
    const tabs = state.tabs;
    const targetIdx = tabs.findIndex((t) => t.id === targetId);
    let beforeId: string | null;
    if (dropTarget?.edge === 'after') {
      beforeId = tabs[targetIdx + 1]?.id ?? null;
    } else {
      beforeId = targetId;
    }
    dispatch({ type: 'TABS_REORDER', id: dragId, beforeId });
    onDragEnd();
  }

  function onStripDragOver(e: DragEvent<HTMLDivElement>) {
    // Allow drop on the trailing empty area of the strip — interpret as
    // "append to the end". We only react when the drag is actually a
    // tab (dragId set), so external file drags fall through.
    if (!dragId) return;
    e.preventDefault();
  }

  // TODO(09⏳02 b/c): drag-to-split (drop a tab on the right edge of the
  // main pane → vertical split) and drag-to-window (drag a tab out →
  // spawn a new window). Both couple to multi-window state; only the
  // in-strip reorder (a) is implemented here.
  function onStripDrop(e: DragEvent<HTMLDivElement>) {
    if (!dragId) return;
    // If the user dropped on a child tab, that handler already ran and
    // cleared `dragId`. This is the trailing-area fallback.
    e.preventDefault();
    dispatch({ type: 'TABS_REORDER', id: dragId, beforeId: null });
    onDragEnd();
  }

  return (
    <div className="tab-strip">
      <div
        className="tab-strip-inner"
        ref={stripRef}
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
      >
        {state.tabs.map((t) => {
          const isActive = t.id === state.activeTabId;
          const label = t.file ? displayTabLabel(t.file.name) : 'Untitled';
          const isDragging = dragId === t.id;
          // "stashing" = the file's still being turned into searchable
          // content — either converting (PDF/image OCR) or indexing
          // (embedding). We mark it on its tab with the StashBase logo (a
          // placeholder for the eventual animated mark) so an opened-but-
          // not-yet-stashed file reads as "in progress", not broken.
          const isStashing = !!t.file && getFileReadiness(state, t.file.name).isStashing;
          const dropEdge = dropTarget?.id === t.id ? dropTarget.edge : null;
          const cls = 'tab'
            + (isActive ? ' active' : '')
            + (t.preview ? ' preview' : '')
            + (isStashing ? ' stashing' : '')
            + (isDragging ? ' dragging' : '')
            + (dropEdge === 'before' ? ' drop-before' : '')
            + (dropEdge === 'after' ? ' drop-after' : '');
          return (
            <div
              key={t.id}
              className={cls}
              draggable
              title={
                (t.file?.name ?? 'Empty tab')
                + (t.preview ? '  (preview — double-click to keep)' : '')
              }
              onClick={() => { void actions.activateTab(t.id); }}
              onDoubleClick={(e) => {
                e.preventDefault();
                // Double-click on a preview tab pins it. No-op on
                // already-pinned tabs (the action layer guards too).
                if (t.preview) dispatch({ type: 'PROMOTE_TAB', id: t.id });
              }}
              onAuxClick={(e) => {
                // Middle-click closes — matches browser tab behavior.
                if (e.button === 1) {
                  e.preventDefault();
                  void actions.closeTab(t.id);
                }
              }}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onTabDragOver(e, t.id)}
              onDragLeave={() => {
                // Only clear when the leaving tab was our last target —
                // otherwise transitioning between adjacent tabs would
                // flicker the indicator off and back on.
                if (dropTarget?.id === t.id) setDropTarget(null);
              }}
              onDrop={(e) => onTabDrop(e, t.id)}
            >
              {isStashing && <StashBaseIcon className="tab-stashing-logo" />}
              <span className="tab-label">{label}</span>
              <button
                type="button"
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  void actions.closeTab(t.id);
                }}
              >×</button>
            </div>
          );
        })}
        <button
          type="button"
          className="tab-new"
          title="New tab"
          onClick={() => { void actions.newTab(); }}
        >+</button>
      </div>
    </div>
  );
}

/** Tab label = the file's basename, extension included (`note.md`, not
 *  `note`). Showing the suffix keeps `.md` vs `.html` vs `.pdf` tabs
 *  unambiguous at a glance. */
function displayTabLabel(path: string): string {
  return path.split('/').pop() ?? path;
}
