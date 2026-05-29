import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { ChevronDownIcon } from '../icons';
import type { FileMeta, FolderMeta, SearchHit } from '../api';
import { useApp } from '../store/AppContext';
import { RenameInput, useRenameTarget } from './RenameInput';

const FILE_MIME = 'application/x-stashbase-file';
const FOLDER_MIME = 'application/x-stashbase-folder';
// Mirror of the source row's parent path during a drag, so drop
// targets can verify same-parent before accepting a reorder. Read at
// drop time so we don't need to (a)wait the dataTransfer parse.
const REORDER_PARENT_MIME = 'application/x-stashbase-parent';

/** Where in a row the cursor is during dragover — drives the drop
 *  indicator + the action the drop triggers. `into` is folder-only
 *  (move the dragged file/folder into that folder, current behavior);
 *  `above` / `below` are reorder slots (same parent only). */
type DropEdge = 'above' | 'into' | 'below' | null;

// Module-scoped breadcrumbs the drag source writes at `dragstart` so
// drop targets can verify "same parent" / "not yourself" without
// resorting to MIME data (`dataTransfer.getData` is unreadable during
// `dragover`). Cleared on `dragend`.
let dragSourceParent: string | null = null;
let dragSourceName: string | null = null;
let dragSourceKind: 'file' | 'folder' | null = null;

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

interface FileNode {
  type: 'file';
  name: string;
  path: string;
  meta: FileMeta;
}

type TreeNode = FolderNode | FileNode;

function buildTree(
  files: FileMeta[],
  folders: FolderMeta[],
  fileOrder: Record<string, string[]>,
): FolderNode {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);

  const ensureFolder = (folderPath: string): FolderNode => {
    const cached = folderMap.get(folderPath);
    if (cached) return cached;
    const segs = folderPath.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const node: FolderNode = {
      type: 'folder',
      name: segs[segs.length - 1],
      path: folderPath,
      children: [],
    };
    parent.children.push(node);
    folderMap.set(folderPath, node);
    return node;
  };
  for (const f of folders) ensureFolder(f.path);

  for (const f of files) {
    const segs = f.name.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    parent.children.push({
      type: 'file',
      name: segs[segs.length - 1],
      path: f.name,
      meta: f,
    });
  }

  // Sort: items the user has manually ordered come first (in the
  // recorded order), unranked items follow in folders-first +
  // alphabetical order. Names in `fileOrder` that no longer exist on
  // disk are dropped silently (renamed / deleted files don't keep
  // their slot).
  const sortNodes = (nodes: TreeNode[], parentPath: string) => {
    const order = fileOrder[parentPath];
    if (order && order.length > 0) {
      const rank = new Map<string, number>();
      order.forEach((name, i) => rank.set(name, i));
      nodes.sort((a, b) => {
        const ai = rank.get(a.name);
        const bi = rank.get(b.name);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    for (const n of nodes) if (n.type === 'folder') sortNodes(n.children, n.path);
  };
  sortNodes(root.children, '');
  return root;
}

/** Split a path into `parent` and `basename`. Parent is `""` for
 *  space-root entries. Used by drag-to-reorder to verify same-parent
 *  before accepting a drop. */
function splitParent(p: string): { parent: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { parent: '', base: p } : { parent: p.slice(0, i), base: p.slice(i + 1) };
}

/** Reorder helper: produce a new array where `dragName` lands at the
 *  position of `dropName` (above or below it). Used for the manual
 *  sidebar ordering optimistic update. */
function reorder(
  names: string[],
  dragName: string,
  dropName: string,
  edge: 'above' | 'below',
): string[] {
  const without = names.filter((n) => n !== dragName);
  const dropIdx = without.indexOf(dropName);
  if (dropIdx < 0) return names; // dropName not in current list — bail
  const insertAt = edge === 'above' ? dropIdx : dropIdx + 1;
  return [...without.slice(0, insertAt), dragName, ...without.slice(insertAt)];
}

function displayName(name: string): string {
  // Show the extension. Three viewer formats (md / html / pdf) coexist
  // — PDF-derived notes ship as a `paper.pdf` + `paper.html` pair, and
  // collapsing both to "paper" leaves them visually indistinguishable.
  // ICP is developers who already read extensions everywhere (IDE /
  // Finder / git), so the noise cost is small. Kept as a hook so we
  // can flip back to stripping later without churning call sites.
  return name;
}

export function FileTree() {
  const { state } = useApp();
  const root = useMemo(
    () => buildTree(state.files, state.folders, state.fileOrder),
    [state.files, state.folders, state.fileOrder],
  );

  // Non-empty query → render `/api/search` hits instead of the tree.
  // The action handles debounce + race protection; we just react to
  // whichever state phase the store is in.
  if (state.filterQuery.trim()) {
    return <SearchResults query={state.filterQuery.trim()} />;
  }
  const inputAtRoot = state.newFolderInputOpen && state.activeFolder === '';
  if (root.children.length === 0 && !inputAtRoot) {
    return <div className="empty-list">No notes yet — click + to create one</div>;
  }
  return (
    <>
      {inputAtRoot && <NewFolderInput parentPath="" depth={0} />}
      <TreeNodes nodes={root.children} depth={0} parent="" />
    </>
  );
}

function SearchResults({ query }: { query: string }) {
  const { state } = useApp();
  if (state.searching && state.searchHits === null) {
    return <div className="empty-list">Searching…</div>;
  }
  // searchHits stays at its previous value while a newer query is
  // in-flight — render those instead of flashing back to nothing.
  if (!state.searchHits || state.searchHits.length === 0) {
    return <div className="empty-list">No matches</div>;
  }
  return (
    <div className="search-hits">
      {state.searchHits.map((hit, i) => (
        <SearchHitRow key={`${hit.fileName}#${hit.chunkIndex}#${i}`} hit={hit} query={query} />
      ))}
    </div>
  );
}

/** One search result row. Click opens the source file. Highlight
 *  matches the user's literal query terms (case-insensitive) — coarse
 *  but matches what they typed; we don't have access to the actual
 *  Milvus hit spans. */
function SearchHitRow({ hit, query }: { hit: SearchHit; query: string }) {
  const { actions } = useApp();
  const fileBasename = hit.fileName.split('/').pop() ?? hit.fileName;
  return (
    <div
      className="search-hit"
      onClick={() => {
        // Arm the viewer with the chunk's line range + raw text so it
        // can render a fade overlay (HTML / MD / Code) or do a pdfjs
        // find-controller search (PDF). The viewer consumes the
        // highlight on first render and clears it.
        void actions.selectFileWithHighlight(hit.fileName, {
          startLine: hit.startLine,
          endLine: hit.endLine,
          chunkText: hit.content,
        });
      }}
      title={hit.fileName}
    >
      {hit.heading && <div className="search-hit-heading">{hit.heading}</div>}
      <div className="search-hit-snippet">{highlight(hit.content, query)}</div>
      <div className="search-hit-meta">
        <span className="search-hit-file">{displayName(fileBasename)}</span>
      </div>
    </div>
  );
}

/** Split text on query terms (case-insensitive) and wrap matches in
 *  `<mark>`. Handles multi-word queries by splitting on whitespace and
 *  matching any term. Falls back to plain text if the regex is empty. */
function highlight(text: string, query: string) {
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return text;
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  // Truncate very long chunks so a single hit doesn't blow up the
  // sidebar — full body is one click away in the main pane.
  const trimmed = text.length > 240 ? text.slice(0, 240) + '…' : text;
  // `split` with a capture group alternates non-match / match / non-match
  // — even indices are gaps, odd indices are the matched terms.
  const parts = trimmed.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function TreeNodes({ nodes, depth, parent }: { nodes: TreeNode[]; depth: number; parent: string }) {
  // Current rendered basename order for these siblings — used by
  // drop-to-reorder so it can splice the dragged name into the right
  // position. Matches what `buildTree` produced (manual order + tail).
  const siblings = nodes.map((n) => n.name);
  return (
    <>
      {nodes.map((n) =>
        n.type === 'folder' ? (
          <FolderRow
            key={n.path}
            node={n}
            depth={depth}
            parent={parent}
            siblings={siblings}
          />
        ) : (
          <FileRow
            key={n.path}
            path={n.path}
            format={n.meta.format}
            paddingLeft={depth * 14 + 26}
            parent={parent}
            siblings={siblings}
          />
        ),
      )}
    </>
  );
}

function FolderRow({
  node,
  depth,
  parent,
  siblings,
}: {
  node: FolderNode;
  depth: number;
  parent: string;
  siblings: string[];
}) {
  const { state, dispatch, actions } = useApp();
  const isExpanded = state.expanded.has(node.path);
  const isActive = state.selectedPath === node.path;
  const renaming = useRenameTarget(node.path, 'folder');
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  const rowClass =
    'tree-row folder' +
    (isExpanded ? '' : ' collapsed') +
    (isActive ? ' active-folder' : '') +
    (dropEdge === 'into' ? ' drop-target' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: node.path, kind: 'folder' },
    });
  }

  function onDragStart(e: DragEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.dataTransfer.setData(FOLDER_MIME, node.path);
    e.dataTransfer.effectAllowed = 'move';
    dragSourceParent = parent;
    dragSourceName = node.name;
    dragSourceKind = 'folder';
  }
  function onDragEnd() {
    dragSourceParent = null;
    dragSourceName = null;
    dragSourceKind = null;
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    const t = e.dataTransfer.types;
    const isFile = t.includes(FILE_MIME);
    const isFolder = t.includes(FOLDER_MIME);
    if (!isFile && !isFolder) return; // external OS drop → global handler
    e.preventDefault();
    e.stopPropagation();
    // Self → no indicator.
    if (dragSourceKind === 'folder' && dragSourceName === node.name && dragSourceParent === parent) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const r = (e.clientY - rect.top) / rect.height;
    // Folder zones: 0–25% = above, 25–75% = into, 75–100% = below.
    let edge: DropEdge = r < 0.25 ? 'above' : r >= 0.75 ? 'below' : 'into';
    // Reorder is same-parent only — cross-parent above/below isn't a
    // supported operation. Demote to "into" (only valid for FILE drag;
    // folder-into-folder isn't supported v1).
    if ((edge === 'above' || edge === 'below') && dragSourceParent !== parent) {
      edge = isFile ? 'into' : null;
    }
    if (edge === 'into' && isFolder) edge = null;
    setDropEdge(edge);
    e.dataTransfer.dropEffect = edge ? 'move' : 'none';
  }
  function onDragLeave() { setDropEdge(null); }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const edge = dropEdge;
    setDropEdge(null);
    if (!edge) return;
    if (edge === 'into') {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (filePath) void actions.moveFile(filePath, node.path);
      return;
    }
    // Reorder within the same parent.
    if (dragSourceParent !== parent || !dragSourceName) return;
    const next = reorder(siblings, dragSourceName, node.name, edge);
    void actions.setFolderOrder(parent, next);
  }

  return (
    <>
      <div
        className={rowClass}
        style={{ paddingLeft: depth * 14 + 26 }}
        data-path={node.path}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => {
          if (renaming) return;
          dispatch({ type: 'TOGGLE_FOLDER', path: node.path });
        }}
        onContextMenu={onContextMenu}
      >
        <span className="chev"><ChevronDownIcon /></span>
        {renaming ? (
          <RenameInput
            initialBasename={node.name}
            ext=""
            onCommit={(newName) => { void actions.renameFolder(node.path, newName); }}
            onCancel={() => dispatch({ type: 'RENAMING', renaming: null })}
          />
        ) : (
          <span className="label">{node.name}</span>
        )}
      </div>
      <div
        className={'tree-children' + (isExpanded ? '' : ' collapsed')}
        style={{ '--guide-left': `${depth * 14 + 33}px` } as CSSProperties}
      >
        {state.newFolderInputOpen && state.activeFolder === node.path && (
          <NewFolderInput parentPath={node.path} depth={depth + 1} />
        )}
        <TreeNodes nodes={node.children} depth={depth + 1} parent={node.path} />
      </div>
    </>
  );
}

function FileRow({
  path,
  format,
  paddingLeft,
  parent,
  siblings,
}: {
  path: string;
  format: 'md' | 'html' | 'pdf';
  paddingLeft: number;
  parent: string;
  siblings: string[];
}) {
  const { state, actions, dispatch } = useApp();
  const isActive = state.selectedPath === path;
  const isPending = state.pendingNames.has(path);
  const renaming = useRenameTarget(path, 'file');
  const [dropEdge, setDropEdge] = useState<DropEdge>(null);

  const rowClass =
    `tree-row file format-${format}` +
    (isActive ? ' active' : '') +
    (isPending ? ' not-indexed' : '') +
    (dropEdge === 'above' ? ' drop-edge-above' : '') +
    (dropEdge === 'below' ? ' drop-edge-below' : '');

  const basename = path.split('/').pop() ?? path;
  const display = displayName(basename);
  const extMatch = basename.match(/\.(md|markdown|html|htm)$/i);
  const ext = extMatch ? extMatch[0] : '';

  function onDragStart(e: DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData(FILE_MIME, path);
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'move';
    dragSourceParent = parent;
    dragSourceName = basename;
    dragSourceKind = 'file';
  }
  function onDragEnd() {
    dragSourceParent = null;
    dragSourceName = null;
    dragSourceKind = null;
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    const t = e.dataTransfer.types;
    const isFile = t.includes(FILE_MIME);
    const isFolder = t.includes(FOLDER_MIME);
    if (!isFile && !isFolder) return;
    e.preventDefault();
    e.stopPropagation();
    // File rows accept reorder only — never "into". Cross-parent
    // reorder isn't supported (per design): show no indicator so the
    // user doesn't think the drop will land somewhere it won't.
    if (dragSourceParent !== parent) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    // Self → skip.
    if (dragSourceKind === 'file' && dragSourceName === basename) {
      setDropEdge(null);
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const r = (e.clientY - rect.top) / rect.height;
    setDropEdge(r < 0.5 ? 'above' : 'below');
    e.dataTransfer.dropEffect = 'move';
  }
  function onDragLeave() { setDropEdge(null); }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const edge = dropEdge;
    setDropEdge(null);
    if (!edge || edge === 'into') return;
    if (dragSourceParent !== parent || !dragSourceName) return;
    const next = reorder(siblings, dragSourceName, basename, edge);
    void actions.setFolderOrder(parent, next);
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dispatch({
      type: 'CTX_MENU',
      menu: { x: e.clientX, y: e.clientY, target: path, kind: 'file' },
    });
  }

  return (
    <div
      className={rowClass}
      style={{ paddingLeft }}
      data-path={path}
      title={isPending ? `Indexing… · ${path}` : path}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => {
        if (renaming) return;
        // Single-click → replace the active tab's file (or activate
        // the existing tab that has this file already). The wasteful
        // reload case (clicking the file open in THIS tab) is handled
        // inside `selectFile` — it sees the file is already shown and
        // just re-selects the row.
        const activeTab = state.activeTabId
          ? state.tabs.find((t) => t.id === state.activeTabId)
          : null;
        if (activeTab?.file?.name === path) {
          dispatch({ type: 'SELECT_PATH', path });
        } else {
          void actions.selectFile(path);
        }
      }}
      onDoubleClick={() => {
        if (renaming) return;
        // Double-click → open in a new tab (VS Code semantics).
        void actions.openInNewTab(path);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="icon"><FileTypeIcon format={format} /></span>
      {renaming ? (
        <RenameInput
          initialBasename={ext ? basename.slice(0, -ext.length) : basename}
          ext={ext}
          onCommit={(newBasename) => { void actions.renameFile(path, newBasename); }}
          onCancel={() => dispatch({ type: 'RENAMING', renaming: null })}
        />
      ) : (
        <span className="label">{display}</span>
      )}
    </div>
  );
}

/** Inline input for naming a new folder. Mounts inside the parent
 *  folder's children area (or at the top level when `parentPath`
 *  is `''`), so the affordance reads "the new folder will live
 *  here". Same Enter/Esc/blur/IME semantics as `<RenameInput>`. */
function NewFolderInput({ parentPath, depth }: { parentPath: string; depth: number }) {
  const { actions, dispatch } = useApp();
  const ref = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => { ref.current?.focus(); }, []);

  function commit() {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = ref.current?.value.trim() ?? '';
    dispatch({ type: 'NEW_FOLDER_INPUT', open: false });
    if (!name) return;
    const full = parentPath ? `${parentPath}/${name}` : name;
    void actions.newFolder(full);
  }
  function cancel() {
    if (doneRef.current) return;
    doneRef.current = true;
    dispatch({ type: 'NEW_FOLDER_INPUT', open: false });
  }

  return (
    <input
      ref={ref}
      type="text"
      className="tree-create-input"
      placeholder="New folder name…"
      style={{ marginLeft: depth * 14 + 6 }}
      onKeyDown={(e) => {
        // Skip while IME is composing — Chinese / Japanese / Korean
        // users press Enter to pick a candidate, not to commit.
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onBlur={() => {
        if (doneRef.current) return;
        const name = ref.current?.value.trim() ?? '';
        if (name) commit(); else cancel();
      }}
    />
  );
}

/** Per-format file icon. Both share an outline envelope; the inner
 *  glyph is the format-specific differentiator. Colour is layered on
 *  via the `.format-<x>` CSS class on the row. */
function FileTypeIcon({ format }: { format: 'md' | 'html' | 'pdf' }) {
  if (format === 'pdf') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <text
          x="12"
          y="19"
          textAnchor="middle"
          fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
          fontSize="6"
          fill="currentColor"
          stroke="none"
        >PDF</text>
      </svg>
    );
  }
  if (format === 'html') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <polyline points="10 12 8 14 10 16" />
        <polyline points="14 12 16 14 14 16" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <text
        x="12"
        y="19"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
        fontSize="7"
        fontWeight="800"
        fill="currentColor"
        stroke="none"
      >MD</text>
    </svg>
  );
}
