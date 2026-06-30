/**
 * Pure state machinery for the renderer: types, action union, initial
 * state, the reducer, and a handful of small operate-on-state helpers
 * shared with the action thunks (`getActiveTab`, `patchActiveTab`,
 * `makeTab`).
 *
 * No React, no side effects — everything in this file is plain data /
 * functions. Imports from `AppContext.tsx` flow one-way (Provider
 * pulls types + reducer from here); circular imports are avoided by
 * keeping `AppActions` + `EditorHandle` + the React Context in
 * `AppContext.tsx` next to the Provider that uses them.
 */
import type {
  FileBody,
  FileMeta,
  FolderMeta,
  KeywordSearchResult,
  ConversionFailure,
  ConversionProgress,
  IndexWarning,
  SearchHit,
  Agent,
} from '../api';

export interface SaveStatus {
  text: string;
  cls: '' | 'saved' | 'error';
}

/** Sidebar side-panel resize bounds (px), shared by the reducer and the
 *  drag handle. The 44px activity rail is *not* part of this — it always
 *  stays visible. Dragging the panel narrower than `COLLAPSE_AT`
 *  collapses it (rail-only); between that and `MIN` it snaps to `MIN`. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_COLLAPSE_AT = 100;

/** One chat tab in the right-side chat panel. The tab's `agent` is
 *  locked at creation time so starting a new tab with a different agent
 *  doesn't restart open conversations. */
export interface ChatTab {
  id: string;
  /** Agent id the tab runs (`claude` / `codex` / …). */
  agent: string;
  /** Display name in the tab strip. Default: `"Untitled"` (plus a
   *  `" N"` suffix on duplicates). */
  title: string;
}

export interface OpenFile {
  name: string;
  format: 'md' | 'html' | 'pdf' | 'image';
  /** Last on-disk content — diff target for the autosave path. Empty
   *  string for binary files (PDF / image; the viewer loads them
   *  directly from `/asset/*`). */
  content: string;
  /** Opaque server-side file version used to reject stale autosaves
   *  when another window or external editor changed the same file. */
  version?: string;
}

export interface CtxMenu {
  x: number;
  y: number;
  target: string;
  kind: 'file' | 'folder';
}

/** One open tab. Everything that varies per-document lives here so
 *  switching tabs is just a pointer swap. `file === null` is a blank
 *  tab created by the `+` button — empty pane until the user clicks
 *  a sidebar entry to fill it.
 *
 *  `preview` mirrors VS Code's "preview tab" mode — a tab opened by
 *  single-click from the sidebar is preview, rendered italic, and the
 *  next single-click on a different file REPLACES its content
 *  ("kicks" the preview out) instead of spawning a new tab. Promoted
 *  to a regular pinned tab by: double-clicking the file in the tree,
 *  double-clicking the tab title, or entering edit mode. */
export interface Tab {
  id: string;
  file: OpenFile | null;
  editMode: boolean;
  preview: boolean;
  pendingAnchor: string | null;
  /** Set when a viewer should highlight a specific chunk on next
   *  render — typically after a click on a SearchHitRow. The viewer
   *  reads it, scrolls to the range, paints a fading overlay, and
   *  dispatches PENDING_HIGHLIGHT_CLEAR. Cleared automatically when
   *  the user navigates to a different file. */
  pendingHighlight: PendingHighlight | null;
  saveStatus: SaveStatus;
}

/** Search-hit-derived highlight signal: which lines (for HTML / MD /
 *  code viewers) plus the raw chunk text (for the PDF viewer to do
 *  text-layer search when line numbers don't apply). When
 *  `openFindBar` is true the viewer opens the FindBar pre-seeded with
 *  `chunkText` so the user can walk every in-file match with Cmd+G —
 *  set by the keyword-search hit click so a click on one match opens
 *  navigation across all of them. */
export interface PendingHighlight {
  startLine?: number;
  endLine?: number;
  chunkText: string;
  openFindBar?: boolean;
  pdfPage?: number;
}

/** Data for the rename-cascade confirmation dialog (VSCode "Update N
 *  references in M files?" prompt). `kind` + `oldPath` + `newPath`
 *  fully describe the intent; the action holds the resolver and
 *  blocks until the user picks. */
export interface CascadePrompt {
  kind: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  files: number;
  links: number;
}

export type CascadeDecision = 'update' | 'skip' | 'cancel';

/** Pending alert/confirm payload. We render these inline via a styled
 *  `ModalShell` instead of `window.alert` / `window.confirm` — the
 *  native dialogs steal focus, block the renderer thread on Electron,
 *  and clash visually with the rest of the app's modal aesthetic. */
export interface ModalRequest {
  type: 'alert' | 'confirm';
  message: string;
}

/** A toast notification: lightweight non-blocking feedback the user
 *  can dismiss or just wait out. Use this for "operation succeeded /
 *  failed" feedback where the user can keep working — reserve
 *  `actions.alert` for content that genuinely needs the user to
 *  stop and read. */
export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Optional inline action (e.g. "Retry", "Undo"). The handler runs
   *  in addition to dismissing the toast — the toast tracker takes
   *  care of removing the toast from the stack afterwards. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss. `null` = persistent (must be
   *  clicked away). Defaults: info / success 3000, warning 5000,
   *  error null. */
  ttl: number | null;
  /** How many identical (same level + message) toasts have collapsed
   *  into this one. Absent / 1 = a single occurrence; rendered as a
   *  "×N" badge when >1 so rapid-fire duplicates don't flood the
   *  stack. Maintained by the `TOAST_ADD` reducer. */
  count?: number;
}

export interface State {
  welcomeVisible: boolean;
  welcomeError: string | null;

  /** Human-facing active folder label. Use `folderPath` for API scope /
   *  identity; this value is for titles, sidebar headings, and empty-state
   *  copy. */
  folder: string;
  /** Absolute POSIX path of the active folder. This is the stable identity
   *  for search, sync, conversion retry, uploads, and agent context. */
  folderPath: string;
  recent: { path: string; openedAt: string }[];
  /** OS home directory — used by the Welcome screen to render
   *  `~/foo` instead of the full `/Users/<name>/foo`. */
  homeDir: string;

  files: FileMeta[];
  folders: FolderMeta[];

  /** Manual sidebar ordering — map of `parentPath` → ordered list of
   *  child basenames. Empty map = use default (folders-first +
   *  alphabetical) for every folder. Mutated by drag-to-reorder in the
   *  tree; reset / refetched on folder switch. */
  fileOrder: Record<string, string[]>;

  /** Ordered open tabs. The tab strip renders this array left-to-right.
   *  Empty array = no document open (initial state or after closing the
   *  last tab). The active tab is whichever has `id === activeTabId`. */
  tabs: Tab[];
  activeTabId: string | null;

  expanded: Set<string>;
  activeFolder: string;
  /** The single "focused row" in the sidebar — at most one row (file or
   *  folder) is visually selected at a time. Tracks the open file by
   *  default; explicit clicks (tree row, breadcrumb segment, folder
   *  toggle) override it. `''` = FOLDER root is the focused row. */
  selectedPath: string;
  folderCollapsed: boolean;
  /** True hides the resizable side panel, leaving only the 44px activity
   *  rail visible (VSCode-style — the rail itself never collapses). */
  sidebarCollapsed: boolean;
  /** Width (px) of the resizable side panel — the part right of the
   *  44px activity rail. User-resizable via the drag handle on the
   *  sidebar's right edge; clamped to [SIDEBAR_MIN_WIDTH, MAX]. */
  sidebarWidth: number;
  /** True opens the right-side chat panel. */
  chatOpen: boolean;
  /** Chat panel width in pixels — user-resizable via drag handle. */
  chatWidth: number;
  /** Catalog of available agents from the server, populated on demand. */
  agents: Agent[];
  /** Active chat tabs. Each tab owns its own agent session so switching
   *  tabs preserves that conversation. Cursor-style — the chrome
   *  launchers / in-panel `+` spawn new ones. */
  chatTabs: ChatTab[];
  /** Id of the currently-visible tab. `null` only when `chatTabs`
   *  is empty (panel closed or just initialised). */
  activeChatTabId: string | null;

  /** User-visible paths whose searchable content is still being embedded.
   *  Usually structured notes (md/html). For PDF/image, status reports the
   *  visible source file even though the searchable text is AppData-derived. */
  pendingNames: Set<string>;
  /** Folder-relative paths of PDFs the server is converting right now.
   *  Sidebar shows a "Converting…" row per entry; transition to
   *  empty triggers a `loadFiles` so the produced `.html` shows up
   *  in the tree without waiting for the next user action. */
  pendingConversions: string[];
  /** Current per-file conversion progress for the active folder. Kept
   *  separate from `pendingConversions` so the sidebar stays simple
   *  while rich viewers can show local detail. */
  conversionProgress: Record<string, ConversionProgress>;

  syncRunning: boolean;

  /** Which sidebar view is active. `'files'` shows the file tree +
   *  banners; `'search'` shows the search input + result list (input
   *  visible only in this view). Not persisted — every launch starts on
   *  `'files'`. */
  activeSidebarView: 'files' | 'search';
  /** Sidebar search input. Empty = blank search panel; non-empty =
   *  run search in whichever mode `searchMode` selects. */
  filterQuery: string;
  /** `'semantic'` runs vector + BM25 hybrid via the daemon (`/api/search`).
   *  `'keyword'` runs ripgrep against the active folder dir
   *  (`/api/keyword-search`) — no daemon, no embeddings. The toggle
   *  switches without clearing the input so the user can compare. */
  searchMode: 'semantic' | 'keyword';
  /** Only meaningful in keyword mode. `false` = ripgrep `--smart-case`
   *  (case-insensitive unless the query has uppercase chars); `true` =
   *  `--case-sensitive` regardless. Semantic search ignores case via
   *  embeddings, so this knob is hidden when `searchMode === 'semantic'`. */
  caseStrict: boolean;
  /** Only meaningful in keyword mode. `true` = `--word-regexp` so
   *  "agent" doesn't match "agents". Hidden in semantic mode. */
  wholeWord: boolean;
  /** `null` = not in search mode (query empty or cleared). `[]` = ran
   *  and got nothing. Non-empty array = ranked hits from `/api/search`.
   *  Populated only when `searchMode === 'semantic'`. */
  searchHits: SearchHit[] | null;
  /** Same null / empty / populated convention as `searchHits`, but for
   *  the keyword path. Holds the file-grouped result so the sidebar can
   *  render each file's matches as a collapsible group. */
  keywordResult: KeywordSearchResult | null;
  searching: boolean;
  /** Non-null when the last search failed for a real reason (server /
   *  daemon error, not just "no matches"). Kept separate so the panel
   *  shows the error instead of a misleading empty "No matches". */
  searchError: string | null;
  /** Global OpenAI key availability. `null` = not checked yet. Semantic
   *  search is disabled when this is explicitly false. */
  embedderHasKey: boolean | null;

  /** Non-null when the active folder's background indexing failed.
   *  Cleared by user dismissal or the server reporting a later success. */
  indexWarning: IndexWarning | null;
  /** Folder-relative paths of PDFs / images whose most recent conversion
   *  failed, carried in from `/api/index-status`. Drives the failure
   *  banner inside `PdfPreview` / `ImagePreview` and the context-menu
   *  "Retry conversion" entry. Empty when no failures. */
  conversionFailures: ConversionFailure[];

  ctxMenu: CtxMenu | null;
  renaming: { path: string; kind: 'file' | 'folder' } | null;

  /** Active rename-cascade dialog payload. `null` means hidden. The
   *  caller awaits a separate `resolveCascadePrompt` action to settle
   *  the decision. */
  cascadePrompt: CascadePrompt | null;
  /** Pending in-app alert/confirm. `null` = nothing showing. The
   *  Provider's `actions.alert` / `actions.confirm` set this and resolve
   *  the returned Promise once the user dismisses. */
  modal: ModalRequest | null;
  /** Active toast notifications, rendered as a stack in the bottom-
   *  right corner. Each entry self-dismisses after its ttl; the
   *  Provider trims this list on every `TOAST_DISMISS`. */
  toasts: Toast[];
  /** True while the user is typing a new folder name. The input
   *  renders inside the FileTree at the row matching
   *  `state.activeFolder` so the new folder appears under the
   *  parent the user actually selected (mirrors new-note inline
   *  rename placement). */
  newFolderInputOpen: boolean;

  /** Chrome-style in-document keyword find. Global (not per-tab) to
   *  mirror the browser: opening Cmd+F overlays one bar over whichever
   *  view (editor / md preview / html preview iframe) is active, and
   *  switching tabs carries the bar over. `current` is 1-indexed for
   *  display; 0 means no match selected (empty query or nothing matched). */
  find: {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    current: number;
    total: number;
  };
}

export const initialState: State = {
  welcomeVisible: true,
  welcomeError: null,
  folder: '',
  folderPath: '',
  recent: [],
  homeDir: '',
  files: [],
  folders: [],
  fileOrder: {},
  tabs: [],
  activeTabId: null,
  expanded: new Set(),
  activeFolder: '',
  selectedPath: '',
  folderCollapsed: false,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  chatOpen: false,
  chatWidth: 480,
  agents: [],
  chatTabs: [],
  activeChatTabId: null,
  pendingNames: new Set(),
  pendingConversions: [],
  conversionProgress: {},
  syncRunning: false,
  activeSidebarView: 'files',
  filterQuery: '',
  searchMode: 'semantic',
  caseStrict: false,
  wholeWord: false,
  searchHits: null,
  keywordResult: null,
  searching: false,
  searchError: null,
  embedderHasKey: null,
  indexWarning: null,
  conversionFailures: [],
  ctxMenu: null,
  renaming: null,
  cascadePrompt: null,
  modal: null,
  toasts: [],
  newFolderInputOpen: false,
  find: { open: false, query: '', caseSensitive: false, wholeWord: false, current: 0, total: 0 },
};

export type Action =
  | { type: 'WELCOME_HIDE' }
  | { type: 'WELCOME_SHOW'; recent: State['recent']; homeDir?: string; error?: string | null }
  | { type: 'RECENT_LOADED'; recent: State['recent']; homeDir?: string }
  | { type: 'WELCOME_ERROR'; error: string }
  | { type: 'FOLDER_CONTEXT'; folder: string; folderPath: string }
  | { type: 'FILES_LOADED'; files: FileMeta[]; folders: FolderMeta[]; folder: string; folderPath?: string }
  | { type: 'FILE_ORDER_LOADED'; order: Record<string, string[]> }
  /** Replace one folder's ordered list (optimistic update before the
   *  PUT lands). Names list may include entries that no longer exist
   *  on disk — the tree renderer filters those out. */
  | { type: 'FILE_ORDER_SET'; parentPath: string; names: string[] }
  /** Load a file body into the active tab. `newTab: true` first pushes
   *  a fresh blank tab and switches to it, so the file lands in a new
   *  tab instead of replacing the current one. `preview` overrides the
   *  target tab's preview status: when creating a new tab it sets the
   *  initial value; when replacing an active tab it can flip an
   *  existing pinned tab back to preview (used by the blank-tab reuse
   *  path) or vice versa. Omit to preserve the tab's existing flag —
   *  back/forward and in-place anchor nav rely on that. */
  | { type: 'FILE_OPEN'; body: FileBody; newTab?: boolean; preview?: boolean }
  | { type: 'FILE_PATCH'; patch: Partial<OpenFile> }
  | { type: 'PRUNE_MISSING_FILE_TABS'; names: string[] }
  | { type: 'REMAP_PATHS'; from: string; to: string; kind: 'file' | 'folder' }
  /** Push an empty tab and activate it (Obsidian-style `+`). The next
   *  single-click in the sidebar lands here. */
  | { type: 'NEW_TAB' }
  | { type: 'CLOSE_TAB'; id: string }
  | { type: 'ACTIVATE_TAB'; id: string }
  /** Close every open tab — used on folder switch / "go home". */
  | { type: 'TABS_RESET' }
  | { type: 'EDIT_MODE'; on: boolean }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'EXPAND_FOLDER'; path: string }
  | { type: 'COLLAPSE_ALL_FOLDERS' }
  | { type: 'EXPAND_ALL_FOLDERS'; paths: string[] }
  | { type: 'FOLDER_FOLD_TOGGLE' }
  | { type: 'SIDEBAR_SET_COLLAPSED'; collapsed: boolean }
  | { type: 'SIDEBAR_WIDTH'; width: number }
  | { type: 'CHAT_TOGGLE' }
  | { type: 'CHAT_WIDTH'; width: number }
  | { type: 'AGENTS_LOADED'; agents: State['agents'] }
  | { type: 'CHAT_TAB_NEW'; tab: ChatTab }
  | { type: 'CHAT_TAB_CLOSE'; id: string }
  | { type: 'CHAT_TAB_ACTIVATE'; id: string }
  | { type: 'CHAT_TAB_RENAME'; id: string; title: string }
  | { type: 'CHAT_TABS_RESET' }
  | { type: 'ACTIVE_FOLDER'; path: string }
  /** Move the sidebar's single focus to `path`. Pure visual highlight
   *  — does not touch expand state, activeFolder, or the open file. */
  | { type: 'SELECT_PATH'; path: string }
  | { type: 'PENDING_NAMES'; names: Set<string> }
  | { type: 'PENDING_CONVERSIONS'; paths: string[] }
  | { type: 'CONVERSION_PROGRESS'; progress: Record<string, ConversionProgress> }
  | { type: 'SAVE_STATUS'; status: SaveStatus }
  | { type: 'SYNC_RUNNING'; running: boolean }
  | { type: 'FILTER'; q: string }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_HITS'; hits: SearchHit[] }
  | { type: 'SEARCH_KEYWORD'; result: KeywordSearchResult }
  | { type: 'SEARCH_ERROR'; error: string }
  | { type: 'SEARCH_CLEAR' }
  | { type: 'SEARCH_MODE'; mode: 'semantic' | 'keyword' }
  | { type: 'EMBEDDER_KEY_STATE'; hasKey: boolean }
  | { type: 'SIDEBAR_VIEW'; view: 'files' | 'search' }
  | { type: 'SEARCH_CASE_STRICT'; strict: boolean }
  | { type: 'SEARCH_WHOLE_WORD'; on: boolean }
  | { type: 'INDEX_WARNING'; warning: IndexWarning | null }
  | { type: 'CONVERSION_FAILURES'; failures: ConversionFailure[] }
  | { type: 'CTX_MENU'; menu: CtxMenu | null }
  | { type: 'RENAMING'; renaming: State['renaming'] }
  /** Arm the active tab's pending scroll-to-anchor (cross-file links /
   *  search hits); the viewer consumes it on next render. */
  | { type: 'PENDING_SCROLL'; anchor: string | null }
  | { type: 'PENDING_HIGHLIGHT'; highlight: PendingHighlight | null }
  | { type: 'CASCADE_PROMPT'; prompt: CascadePrompt | null }
  | { type: 'MODAL_OPEN'; request: ModalRequest }
  | { type: 'MODAL_CLOSE' }
  | { type: 'TOAST_ADD'; toast: Toast }
  | { type: 'TOAST_DISMISS'; id: string }
  | { type: 'TOAST_CLEAR' }
  /** Promote a preview tab to a pinned one (sets `preview = false`).
   *  Triggered by double-click on a sidebar file, double-click on the
   *  tab title, or entering edit mode on the tab. */
  | { type: 'PROMOTE_TAB'; id: string }
  /** Move tab `id` to immediately before tab `beforeId` (drag-reorder).
   *  `beforeId === null` appends to the end. No-op when the relative
   *  position wouldn't change — keeps the reducer idempotent so a
   *  hover-and-snap-back drag doesn't churn the React keys. */
  | { type: 'TABS_REORDER'; id: string; beforeId: string | null }
  | { type: 'NEW_FOLDER_INPUT'; open: boolean }
  | { type: 'FIND_OPEN' }
  | { type: 'FIND_CLOSE' }
  | { type: 'FIND_SET'; patch: Partial<State['find']> };

/** Build a fresh empty tab. The id is `crypto.randomUUID` because every
 *  browser shipping in 2024+ (and Electron's bundled Chromium) has it;
 *  Node ≥19 also exposes it. New tabs default to pinned (not preview)
 *  — the `+` button is an explicit "I want a permanent slot" action;
 *  preview tabs are only created by the sidebar-single-click path. */
export function makeTab(): Tab {
  return {
    id: crypto.randomUUID(),
    file: null,
    editMode: false,
    preview: false,
    pendingAnchor: null,
    pendingHighlight: null,
    saveStatus: { text: '', cls: '' },
  };
}

/** Resolve the active tab object, or null if none. Used by both the
 *  reducer and the action thunks. */
export function getActiveTab(s: State): Tab | null {
  if (s.activeTabId == null) return null;
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

function isHiddenStatusPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'));
}

export function isVisibleIndexPending(s: State, path: string): boolean {
  // Without an OpenAI key the embedder is off, so the not-yet-embedded set
  // never drains — those files aren't "in progress", they're as searchable
  // as they'll get (keyword via ripgrep). Only suppress on a known missing
  // key (false); null = not yet checked.
  return s.embedderHasKey !== false
    && s.pendingNames.has(path)
    && !isHiddenStatusPath(path);
}

export function isVisibleStashing(s: State, path: string): boolean {
  return (s.pendingConversions.includes(path) && !isHiddenStatusPath(path))
    || isVisibleIndexPending(s, path);
}

/** Folder-relative paths that count as "stashing" — the work the user is
 *  waiting on before a dropped/imported file is fully searchable. Two
 *  sources, unioned: `pendingConversions` (slow extraction/analysis of PDF /
 *  image / recording sources) and the not-yet-indexed subset of
 *  `pendingNames` (md / html / text / code — fast embedding, but a folder
 *  drop of hundreds still wants a count). Hidden paths are dropped: the
 *  `.stem.md` derived notes conversions produce, and anything under
 *  `.stashbase/`, must never surface (a segment starting with `.` flags
 *  both). Deduped + sorted so the sidebar pill and the per-tab mark agree
 *  on one stable list. */
export function stashingPaths(s: State): string[] {
  const out = new Set<string>();
  for (const p of s.pendingConversions) {
    if (!isHiddenStatusPath(p)) out.add(p);
  }
  for (const p of s.pendingNames) {
    if (isVisibleIndexPending(s, p)) out.add(p);
  }
  return [...out].sort();
}

/** Visible files to mark as "stashing" immediately after the user adds
 *  the first OpenAI key. The server may already be embedding by the time
 *  `/api/index-status` is polled, and the daemon serialises status behind
 *  embeds; this optimistic set keeps the UI from going silent during the
 *  first-key backfill. */
export function optimisticKeyBackfillPaths(files: FileMeta[]): string[] {
  return files
    .filter((f) => f.format === 'md' || f.format === 'html' || f.format === 'pdf' || f.format === 'image')
    .map((f) => f.name)
    .filter((name) => !name.split('/').some((seg) => seg.startsWith('.')))
    .sort();
}

/** Merge `patch` into the active tab in place. Returns the state
 *  unchanged when no tab is active — every caller checks `activeTabId`
 *  first, but the no-op guard keeps the reducer cases short. */
export function patchActiveTab(s: State, patch: Partial<Tab>): State {
  if (s.activeTabId == null) return s;
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t)),
  };
}

function remapOnePath(path: string, from: string, to: string, kind: 'file' | 'folder'): string {
  if (!path) return path;
  if (kind === 'file') return path === from ? to : path;
  if (path === from) return to;
  return path.startsWith(from + '/') ? to + path.slice(from.length) : path;
}

function splitPath(path: string): { parent: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { parent: '', base: path } : { parent: path.slice(0, i), base: path.slice(i + 1) };
}

export function renamedFilePath(oldName: string, newBaseName: string): string {
  const extMatch = oldName.match(/\.(md|markdown|html|htm|pdf|png|jpe?g|webp)$/i);
  const ext = extMatch ? extMatch[0] : '';
  const lastSlash = oldName.lastIndexOf('/');
  const dir = lastSlash >= 0 ? oldName.slice(0, lastSlash + 1) : '';
  return dir + newBaseName + ext;
}

function uniqueOrder(names: string[]): string[] {
  return [...new Set(names)];
}

function remapFileOrder(
  order: Record<string, string[]>,
  from: string,
  to: string,
  kind: 'file' | 'folder',
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [parent, names] of Object.entries(order)) {
    const remappedParent = kind === 'folder' ? remapOnePath(parent, from, to, kind) : parent;
    next[remappedParent] = uniqueOrder([...(next[remappedParent] ?? []), ...names]);
  }

  const oldPart = splitPath(from);
  const newPart = splitPath(to);
  const oldList = next[oldPart.parent] ?? [];
  if (oldList.includes(oldPart.base)) {
    if (oldPart.parent === newPart.parent) {
      next[oldPart.parent] = uniqueOrder(oldList.map((name) => (
        name === oldPart.base ? newPart.base : name
      )));
    } else {
      next[oldPart.parent] = oldList.filter((name) => name !== oldPart.base);
      next[newPart.parent] = uniqueOrder([...(next[newPart.parent] ?? []), newPart.base]);
    }
  }

  for (const [parent, names] of Object.entries(next)) {
    if (names.length === 0) delete next[parent];
  }
  return next;
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'WELCOME_HIDE':
      return { ...s, welcomeVisible: false, welcomeError: null };
    case 'WELCOME_SHOW':
      return {
        ...s,
        welcomeVisible: true,
        recent: a.recent,
        homeDir: a.homeDir ?? s.homeDir,
        welcomeError: a.error ?? null,
      };
    case 'RECENT_LOADED':
      return {
        ...s,
        recent: a.recent,
        homeDir: a.homeDir ?? s.homeDir,
      };
    case 'WELCOME_ERROR':
      return { ...s, welcomeError: a.error };
    case 'FOLDER_CONTEXT':
      return s.folder === a.folder && s.folderPath === a.folderPath
        ? s
        : { ...s, folder: a.folder, folderPath: a.folderPath };
    case 'FILES_LOADED':
      return {
        ...s,
        files: a.files,
        folders: a.folders,
        folder: a.folder,
        folderPath: a.folderPath ?? (a.folder ? s.folderPath : ''),
      };
    case 'FILE_ORDER_LOADED':
      return { ...s, fileOrder: a.order };
    case 'FILE_ORDER_SET': {
      const next = { ...s.fileOrder };
      if (a.names.length === 0) delete next[a.parentPath];
      else next[a.parentPath] = a.names.slice();
      return { ...s, fileOrder: next };
    }
    case 'FILE_OPEN': {
      const file: OpenFile = {
        name: a.body.name,
        format: a.body.format,
        content: a.body.content,
        version: a.body.version,
      };
      // New-tab mode (double-click in tree, `+` then a click): create
      // a fresh tab and load into it. Otherwise replace the active
      // tab's file (VS Code single-click mode). If there's no active
      // tab at all, an open click implicitly creates one.
      if (a.newTab || s.activeTabId == null || !getActiveTab(s)) {
        const tab = makeTab();
        tab.file = file;
        tab.preview = a.preview ?? false;
        return {
          ...s,
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          selectedPath: file.name,
        };
      }
      return {
        ...patchActiveTab(s, {
          file,
          editMode: false,
          saveStatus: { text: '', cls: '' },
          pendingAnchor: null,
          pendingHighlight: null,
          // Only touch `preview` when explicitly asked — in-place anchor
          // nav reuses the same tab and must keep its existing
          // preview/pinned status.
          ...(a.preview != null ? { preview: a.preview } : {}),
        }),
        selectedPath: file.name,
      };
    }
    case 'FILE_PATCH': {
      const tab = getActiveTab(s);
      if (!tab?.file) return s;
      const file = { ...tab.file, ...a.patch };
      const renamed = a.patch.name && s.selectedPath === tab.file.name;
      return {
        ...patchActiveTab(s, { file }),
        selectedPath: renamed ? a.patch.name! : s.selectedPath,
      };
    }
    case 'PRUNE_MISSING_FILE_TABS': {
      const names = new Set(a.names);
      const stale = new Set(
        s.tabs
          .filter((t) => t.file && !t.editMode && !names.has(t.file.name))
          .map((t) => t.id),
      );
      if (stale.size === 0) return s;

      const nextTabs = s.tabs.filter((t) => !stale.has(t.id));
      let activeId = s.activeTabId;
      const activeWasStale = !!activeId && stale.has(activeId);
      if (activeWasStale) {
        const oldIdx = s.tabs.findIndex((t) => t.id === activeId);
        activeId = nextTabs[oldIdx]?.id ?? nextTabs[oldIdx - 1]?.id ?? null;
      }
      const active = activeId ? nextTabs.find((t) => t.id === activeId) : null;
      return {
        ...s,
        tabs: nextTabs,
        activeTabId: activeId,
        selectedPath: activeWasStale ? active?.file?.name ?? '' : s.selectedPath,
      };
    }
    case 'REMAP_PATHS': {
      const files = s.files.map((f) => {
        const name = remapOnePath(f.name, a.from, a.to, a.kind);
        return name === f.name ? f : { ...f, name };
      });
      const folders = s.folders.map((f) => {
        const path = remapOnePath(f.path, a.from, a.to, a.kind);
        return path === f.path ? f : { ...f, path };
      });
      const tabs = s.tabs.map((t) => {
        if (!t.file) return t;
        const nextName = remapOnePath(t.file.name, a.from, a.to, a.kind);
        return nextName === t.file.name ? t : { ...t, file: { ...t.file, name: nextName } };
      });
      const expanded = new Set<string>();
      for (const p of s.expanded) expanded.add(remapOnePath(p, a.from, a.to, a.kind));
      return {
        ...s,
        files,
        folders,
        tabs,
        expanded,
        fileOrder: remapFileOrder(s.fileOrder, a.from, a.to, a.kind),
        activeFolder: remapOnePath(s.activeFolder, a.from, a.to, a.kind),
        selectedPath: remapOnePath(s.selectedPath, a.from, a.to, a.kind),
      };
    }
    case 'NEW_TAB': {
      const tab = makeTab();
      return {
        ...s,
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        selectedPath: '',
      };
    }
    case 'CLOSE_TAB': {
      const idx = s.tabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return s;
      const next = s.tabs.slice(0, idx).concat(s.tabs.slice(idx + 1));
      let activeId = s.activeTabId;
      if (s.activeTabId === a.id) {
        activeId = next.length === 0
          ? null
          : (next[idx] ?? next[idx - 1]).id;
      }
      const active = activeId ? next.find((t) => t.id === activeId) : null;
      return {
        ...s,
        tabs: next,
        activeTabId: activeId,
        selectedPath: active?.file?.name ?? '',
      };
    }
    case 'ACTIVATE_TAB': {
      if (s.activeTabId === a.id) return s;
      const target = s.tabs.find((t) => t.id === a.id);
      if (!target) return s;
      return { ...s, activeTabId: a.id, selectedPath: target.file?.name ?? '' };
    }
    case 'TABS_RESET':
      return { ...s, tabs: [], activeTabId: null, selectedPath: '' };
    case 'EDIT_MODE': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      return patchActiveTab(s, {
        editMode: a.on,
        saveStatus: a.on ? tab.saveStatus : { text: '', cls: '' },
        // Entering edit mode promotes a preview tab — the user is
        // committing to this file; the next sidebar single-click
        // shouldn't kick their in-progress changes out of the tab.
        ...(a.on && tab.preview ? { preview: false } : {}),
      });
    }
    case 'TOGGLE_FOLDER': {
      const next = new Set(s.expanded);
      if (next.has(a.path)) next.delete(a.path); else next.add(a.path);
      // Click on a folder row → it becomes the focused row + the
      // creation anchor.
      return { ...s, expanded: next, activeFolder: a.path, selectedPath: a.path };
    }
    case 'EXPAND_FOLDER': {
      if (s.expanded.has(a.path)) return s;
      const next = new Set(s.expanded);
      next.add(a.path);
      return { ...s, expanded: next };
    }
    case 'COLLAPSE_ALL_FOLDERS':
      return { ...s, expanded: new Set(), activeFolder: '' };
    case 'EXPAND_ALL_FOLDERS':
      return { ...s, expanded: new Set(a.paths) };
    case 'FOLDER_FOLD_TOGGLE':
      return { ...s, folderCollapsed: !s.folderCollapsed };
    case 'SIDEBAR_SET_COLLAPSED':
      return { ...s, sidebarCollapsed: a.collapsed };
    case 'SIDEBAR_WIDTH':
      // Snap into [MIN, MAX]. Dragging below MIN is what triggers a
      // collapse, but that decision lives in the drag handler (it has
      // the raw cursor delta); here we just keep the stored width sane.
      return { ...s, sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(a.width, SIDEBAR_MAX_WIDTH)) };
    case 'CHAT_TOGGLE':
      return { ...s, chatOpen: !s.chatOpen };
    case 'CHAT_WIDTH':
      // Clamp to sensible bounds. Below ~280 the prompt wraps every
      // word; above ~70% of viewport leaves no room for content.
      return { ...s, chatWidth: Math.max(280, Math.min(a.width, 1200)) };
    case 'AGENTS_LOADED':
      return { ...s, agents: a.agents };
    case 'CHAT_TAB_NEW':
      return {
        ...s,
        chatTabs: [...s.chatTabs, a.tab],
        activeChatTabId: a.tab.id,
      };
    case 'CHAT_TAB_CLOSE': {
      const idx = s.chatTabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return s;
      const nextTabs = s.chatTabs.filter((t) => t.id !== a.id);
      // If we just closed the active tab, jump to a neighbor (prefer
      // the one immediately to the right, fall back to the left).
      let nextActive = s.activeChatTabId;
      if (s.activeChatTabId === a.id) {
        nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
      }
      return {
        ...s,
        chatTabs: nextTabs,
        activeChatTabId: nextActive,
        // Closing the last chat window folds the panel — the launchers
        // are the only way back in, and an empty panel is just dead folder.
        chatOpen: nextTabs.length === 0 ? false : s.chatOpen,
      };
    }
    case 'CHAT_TAB_ACTIVATE':
      if (!s.chatTabs.some((t) => t.id === a.id)) return s;
      return { ...s, activeChatTabId: a.id };
    case 'CHAT_TAB_RENAME':
      return {
        ...s,
        chatTabs: s.chatTabs.map((t) => (t.id === a.id ? { ...t, title: a.title } : t)),
      };
    case 'CHAT_TABS_RESET':
      // Wipes ALL tabs — called on folder switch (the server kills every
      // agent session in that flow; the frontend drops its tab list too
      // or we'd render panels bound to the old folder). Fold the panel too,
      // mirroring CHAT_TAB_CLOSE: an empty panel is dead folder and the
      // launchers are the only way back in.
      return { ...s, chatTabs: [], activeChatTabId: null, chatOpen: false };
    case 'ACTIVE_FOLDER':
      // Semantically "make this folder the user's current target" —
      // also moves the visual focus there.
      return { ...s, activeFolder: a.path, selectedPath: a.path };
    case 'SELECT_PATH':
      return { ...s, selectedPath: a.path };
    case 'PENDING_NAMES':
      return { ...s, pendingNames: a.names };
    case 'PENDING_CONVERSIONS':
      return { ...s, pendingConversions: a.paths };
    case 'CONVERSION_PROGRESS':
      return { ...s, conversionProgress: a.progress };
    case 'SAVE_STATUS':
      return patchActiveTab(s, { saveStatus: a.status });
    case 'SYNC_RUNNING':
      return { ...s, syncRunning: a.running };
    case 'FILTER':
      return { ...s, filterQuery: a.q };
    case 'SEARCH_START':
      return { ...s, searching: true, searchHits: null, keywordResult: null, searchError: null };
    case 'SEARCH_HITS':
      return { ...s, searching: false, searchHits: a.hits, keywordResult: null, searchError: null };
    case 'SEARCH_KEYWORD':
      return { ...s, searching: false, keywordResult: a.result, searchHits: null, searchError: null };
    case 'SEARCH_ERROR':
      return { ...s, searching: false, searchError: a.error, searchHits: null, keywordResult: null };
    case 'SEARCH_CLEAR':
      return { ...s, searching: false, searchHits: null, keywordResult: null, searchError: null };
    case 'SEARCH_MODE':
      // Clear prior results so the renderer shows the new mode's empty
      // state immediately; runSearch will repopulate if a query is live.
      return { ...s, searchMode: a.mode, searchHits: null, keywordResult: null, searchError: null };
    case 'EMBEDDER_KEY_STATE':
      return {
        ...s,
        embedderHasKey: a.hasKey,
        ...(a.hasKey ? {} : { searchHits: null }),
      };
    case 'SIDEBAR_VIEW':
      return { ...s, activeSidebarView: a.view };
    case 'SEARCH_CASE_STRICT':
      // Result set semantics change → clear and let runSearch refill.
      return { ...s, caseStrict: a.strict, keywordResult: null };
    case 'SEARCH_WHOLE_WORD':
      return { ...s, wholeWord: a.on, keywordResult: null };
    case 'INDEX_WARNING':
      return { ...s, indexWarning: a.warning };
    case 'CONVERSION_FAILURES':
      return { ...s, conversionFailures: a.failures };
    case 'CTX_MENU':
      return { ...s, ctxMenu: a.menu };
    case 'RENAMING':
      return { ...s, renaming: a.renaming };
    case 'MODAL_OPEN':
      return { ...s, modal: a.request };
    case 'MODAL_CLOSE':
      return { ...s, modal: null };
    case 'TOAST_ADD': {
      // Collapse rapid-fire duplicates: if an identical toast (same
      // level + message) is already on the stack, bump its count in
      // place instead of pushing a new one. Keeps its original id (so
      // React doesn't remount) and position; ToastItem re-arms its
      // auto-dismiss off the count change.
      const dup = s.toasts.findIndex(
        (t) => t.level === a.toast.level && t.message === a.toast.message,
      );
      if (dup !== -1) {
        const next = s.toasts.slice();
        next[dup] = { ...next[dup], count: (next[dup].count ?? 1) + 1 };
        return { ...s, toasts: next };
      }
      return { ...s, toasts: [...s.toasts, a.toast] };
    }
    case 'TOAST_DISMISS':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case 'TOAST_CLEAR':
      return s.toasts.length === 0 ? s : { ...s, toasts: [] };
    case 'PROMOTE_TAB':
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, preview: false } : t)),
      };
    case 'TABS_REORDER': {
      const fromIdx = s.tabs.findIndex((t) => t.id === a.id);
      if (fromIdx < 0) return s;
      const without = s.tabs.filter((t) => t.id !== a.id);
      let insertAt: number;
      if (a.beforeId == null) {
        insertAt = without.length;
      } else {
        insertAt = without.findIndex((t) => t.id === a.beforeId);
        if (insertAt < 0) insertAt = without.length;
      }
      // No-op when the resulting order matches what we have already.
      if (insertAt === fromIdx) return s;
      const next = [...without.slice(0, insertAt), s.tabs[fromIdx], ...without.slice(insertAt)];
      return { ...s, tabs: next };
    }
    case 'PENDING_SCROLL':
      return patchActiveTab(s, { pendingAnchor: a.anchor });
    case 'PENDING_HIGHLIGHT':
      return patchActiveTab(s, { pendingHighlight: a.highlight });
    case 'CASCADE_PROMPT':
      return { ...s, cascadePrompt: a.prompt };
    case 'NEW_FOLDER_INPUT':
      return { ...s, newFolderInputOpen: a.open };
    case 'FIND_OPEN':
      // Re-opening is a no-op on state but lets the bar's effect re-run
      // (e.g. user pressed Cmd+F again to refocus the input).
      return s.find.open ? s : { ...s, find: { ...s.find, open: true } };
    case 'FIND_CLOSE':
      // Keep `query` / `wholeWord` so reopening pre-fills the last term
      // (Chrome behavior). `current`/`total` zero out — they're stale
      // the moment the active controller drops its decorations.
      return { ...s, find: { ...s.find, open: false, current: 0, total: 0 } };
    case 'FIND_SET':
      return { ...s, find: { ...s.find, ...a.patch } };
  }
}
