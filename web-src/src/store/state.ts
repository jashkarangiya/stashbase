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
  PdfFailure,
  SearchHit,
  SnapshotWarning,
  TerminalCli,
} from '../api';

export interface SaveStatus {
  text: string;
  cls: '' | 'saved' | 'error';
}

/** Sidebar side-panel resize bounds (px), shared by the reducer and the
 *  drag handle. The 44px activity rail is *not* part of this — it always
 *  stays visible. Dragging the panel narrower than `COLLAPSE_AT`
 *  collapses it (rail-only); between that and `MIN` it snaps to `MIN`. */
export const SIDEBAR_MIN_WIDTH = 170;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_COLLAPSE_AT = 100;

/** One chat tab in the right-side terminal panel. The tab's `cli` is
 *  locked at creation time so starting a new tab with a different agent
 *  doesn't restart open conversations. */
export interface TerminalTab {
  id: string;
  /** CLI id the PTY runs (`claude` / `codex` / …). */
  cli: string;
  /** Display name in the tab strip. Default: `"<CLI label>"` (plus a
   *  `" N"` suffix on duplicates). */
  title: string;
}

export interface OpenFile {
  name: string;
  format: 'md' | 'html' | 'pdf';
  /** Last on-disk content — diff target for the autosave path. Empty
   *  string for PDF (binary file; PdfPreview loads it directly). */
  content: string;
  /** `'kb'` for the `<kbRoot>/STASHBASE.md` special tab — read-only,
   *  no edit button, no save path. Default (omitted) means a regular
   *  per-space file. */
  kind?: 'space' | 'kb';
}

export interface CtxMenu {
  x: number;
  y: number;
  target: string;
  kind: 'file' | 'folder';
}

/** One entry in the back/forward stack. `anchor` is the slug to scroll
 *  to on revisit (cross-file `[..](file.md#slug)` clicks set this);
 *  `scrollY` snapshots where the user was when they navigated away
 *  (MD only — HTML preview is cross-origin sandboxed). */
export interface NavEntry {
  name: string;
  anchor?: string;
  scrollY?: number;
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
  navStack: NavEntry[];
  navCursor: number;
  pendingAnchor: string | null;
  pendingScrollY: number | null;
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
}

export interface State {
  welcomeVisible: boolean;
  welcomeError: string | null;

  space: string;
  recent: { path: string; openedAt: string }[];
  /** OS home directory — used by the Welcome screen to render
   *  `~/foo` instead of the full `/Users/<name>/foo`. */
  homeDir: string;

  files: FileMeta[];
  folders: FolderMeta[];

  /** Manual sidebar ordering — map of `parentPath` → ordered list of
   *  child basenames. Empty map = use default (folders-first +
   *  alphabetical) for every folder. Mutated by drag-to-reorder in the
   *  tree; reset / refetched on space switch. */
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
   *  toggle) override it. `''` = SPACE root is the focused row. */
  selectedPath: string;
  spaceCollapsed: boolean;
  /** True hides the resizable side panel, leaving only the 44px activity
   *  rail visible (VSCode-style — the rail itself never collapses). */
  sidebarCollapsed: boolean;
  /** Width (px) of the resizable side panel — the part right of the
   *  44px activity rail. User-resizable via the drag handle on the
   *  sidebar's right edge; clamped to [SIDEBAR_MIN_WIDTH, MAX]. */
  sidebarWidth: number;
  /** True opens the right-side terminal panel. */
  terminalOpen: boolean;
  /** Terminal panel width in pixels — user-resizable via drag handle. */
  terminalWidth: number;
  /** **Last-used** agent id — the agent the chat panel's split button
   *  and the chrome toggle default to for a new tab. Updated (and
   *  persisted server-side) each time a tab is started, so it follows
   *  the user's latest pick. Existing tabs keep running their own
   *  agent — this only affects future tabs. */
  terminalCli: string;
  /** Catalog of available agents from the server, populated on demand. */
  terminalClis: TerminalCli[];
  /** Active chat tabs. Each tab owns its own PTY + xterm instance so
   *  switching tabs preserves scrollback. Cursor-style — a `+` button
   *  in the tab strip spawns a new one against the default CLI. */
  terminalTabs: TerminalTab[];
  /** Id of the currently-visible tab. `null` only when `terminalTabs`
   *  is empty (panel closed or just initialised). */
  activeTerminalTabId: string | null;

  pendingNames: Set<string>;
  /** Space-relative paths of PDFs the server is converting right now.
   *  Sidebar shows a "Converting…" row per entry; transition to
   *  empty triggers a `loadFiles` so the produced `.html` shows up
   *  in the tree without waiting for the next user action. */
  pendingConversions: string[];

  syncRunning: boolean;

  /** Which sidebar view is active. `'files'` shows the file tree +
   *  banners; `'search'` shows the search
   *  input + result list (input visible only in this view).
   *  Persisted to localStorage via the AppProvider so the user lands
   *  back where they left off. */
  activeSidebarView: 'files' | 'search' | 'kb';
  /** Sidebar search input. Empty = blank search panel; non-empty =
   *  run search in whichever mode `searchMode` selects. */
  filterQuery: string;
  /** `'semantic'` runs vector + BM25 hybrid via the daemon (`/api/search`).
   *  `'keyword'` runs ripgrep against the active space dir
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

  /** Non-null while the active space's most recent snapshot import
   *  surfaced a provider-mismatch warning. Cleared by user dismissal
   *  (`SNAPSHOT_WARNING_DISMISS`) or by the server reporting null. */
  snapshotWarning: SnapshotWarning | null;
  /** Space-relative paths of PDFs whose most recent conversion failed,
   *  carried in from `/api/index-status`. Drives both the failures
   *  banner inside `PdfPreview` and the context-menu "Retry
   *  conversion" entry. Empty when no failures. */
  pdfFailures: PdfFailure[];

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
    wholeWord: boolean;
    current: number;
    total: number;
  };
}

export const initialState: State = {
  welcomeVisible: true,
  welcomeError: null,
  space: '',
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
  spaceCollapsed: false,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  terminalOpen: false,
  terminalWidth: 480,
  terminalCli: 'claude',
  terminalClis: [],
  terminalTabs: [],
  activeTerminalTabId: null,
  pendingNames: new Set(),
  pendingConversions: [],
  syncRunning: false,
  activeSidebarView: 'files',
  filterQuery: '',
  searchMode: 'semantic',
  caseStrict: false,
  wholeWord: false,
  searchHits: null,
  keywordResult: null,
  searching: false,
  snapshotWarning: null,
  pdfFailures: [],
  ctxMenu: null,
  renaming: null,
  cascadePrompt: null,
  modal: null,
  toasts: [],
  newFolderInputOpen: false,
  find: { open: false, query: '', wholeWord: false, current: 0, total: 0 },
};

export type Action =
  | { type: 'WELCOME_HIDE' }
  | { type: 'WELCOME_SHOW'; recent: State['recent']; homeDir?: string; error?: string | null }
  | { type: 'WELCOME_ERROR'; error: string }
  | { type: 'FILES_LOADED'; files: FileMeta[]; folders: FolderMeta[]; space: string }
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
  /** Push an empty tab and activate it (Obsidian-style `+`). The next
   *  single-click in the sidebar lands here. */
  | { type: 'NEW_TAB' }
  | { type: 'CLOSE_TAB'; id: string }
  | { type: 'ACTIVATE_TAB'; id: string }
  /** Close every open tab — used on space switch / "go home". */
  | { type: 'TABS_RESET' }
  | { type: 'EDIT_MODE'; on: boolean }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'EXPAND_FOLDER'; path: string }
  | { type: 'COLLAPSE_ALL_FOLDERS' }
  | { type: 'EXPAND_ALL_FOLDERS'; paths: string[] }
  | { type: 'SPACE_FOLD_TOGGLE' }
  | { type: 'SIDEBAR_FOLD_TOGGLE' }
  | { type: 'SIDEBAR_SET_COLLAPSED'; collapsed: boolean }
  | { type: 'SIDEBAR_WIDTH'; width: number }
  | { type: 'TERMINAL_TOGGLE' }
  | { type: 'TERMINAL_WIDTH'; width: number }
  | { type: 'TERMINAL_CLIS'; current: string; clis: State['terminalClis'] }
  | { type: 'TERMINAL_CLI'; id: string }
  | { type: 'TERMINAL_TAB_NEW'; tab: TerminalTab }
  | { type: 'TERMINAL_TAB_CLOSE'; id: string }
  | { type: 'TERMINAL_TAB_ACTIVATE'; id: string }
  | { type: 'TERMINAL_TABS_RESET' }
  | { type: 'ACTIVE_FOLDER'; path: string }
  /** Move the sidebar's single focus to `path`. Pure visual highlight
   *  — does not touch expand state, activeFolder, or the open file. */
  | { type: 'SELECT_PATH'; path: string }
  | { type: 'PENDING_NAMES'; names: Set<string> }
  | { type: 'PENDING_CONVERSIONS'; paths: string[] }
  | { type: 'SAVE_STATUS'; status: SaveStatus }
  | { type: 'SYNC_RUNNING'; running: boolean }
  | { type: 'FILTER'; q: string }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_HITS'; hits: SearchHit[] }
  | { type: 'SEARCH_KEYWORD'; result: KeywordSearchResult }
  | { type: 'SEARCH_CLEAR' }
  | { type: 'SEARCH_MODE'; mode: 'semantic' | 'keyword' }
  | { type: 'SIDEBAR_VIEW'; view: 'files' | 'search' | 'kb' }
  | { type: 'SEARCH_CASE_STRICT'; strict: boolean }
  | { type: 'SEARCH_WHOLE_WORD'; on: boolean }
  | { type: 'SNAPSHOT_WARNING'; warning: SnapshotWarning | null }
  | { type: 'PDF_FAILURES'; failures: PdfFailure[] }
  | { type: 'CTX_MENU'; menu: CtxMenu | null }
  | { type: 'RENAMING'; renaming: State['renaming'] }
  /** Push a new entry, truncating any forward history. Updates the
   *  current entry's `scrollY` snapshot first via `currentScrollY`. */
  | { type: 'NAV_PUSH'; entry: NavEntry; currentScrollY: number | null }
  /** Move cursor to a specific index (used by back/forward). The
   *  caller is responsible for issuing the file load. */
  | { type: 'NAV_GOTO'; cursor: number; currentScrollY: number | null }
  /** Update only the scrollY snapshot on the current entry — fired
   *  just before the file is replaced when no anchor is in play. */
  | { type: 'NAV_SNAPSHOT_SCROLL'; scrollY: number }
  | { type: 'NAV_RESET' }
  | { type: 'PENDING_SCROLL'; anchor: string | null; scrollY: number | null }
  | { type: 'PENDING_HIGHLIGHT'; highlight: PendingHighlight | null }
  | { type: 'CASCADE_PROMPT'; prompt: CascadePrompt | null }
  | { type: 'MODAL_OPEN'; request: ModalRequest }
  | { type: 'MODAL_CLOSE' }
  | { type: 'TOAST_ADD'; toast: Toast }
  | { type: 'TOAST_DISMISS'; id: string }
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
    navStack: [],
    navCursor: -1,
    pendingAnchor: null,
    pendingScrollY: null,
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
    case 'WELCOME_ERROR':
      return { ...s, welcomeError: a.error };
    case 'FILES_LOADED':
      return { ...s, files: a.files, folders: a.folders, space: a.space };
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
        // Carried through for the kb-overview tab so MainPane
        // can hide the edit button and the save path can skip it.
        ...((a.body as any).kind ? { kind: (a.body as any).kind } : {}),
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
          pendingScrollY: null,
          pendingHighlight: null,
          // Only touch `preview` when explicitly asked — back/forward
          // and in-place anchor nav reuse the same tab and must keep
          // its existing preview/pinned status.
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
    case 'SPACE_FOLD_TOGGLE':
      return { ...s, spaceCollapsed: !s.spaceCollapsed };
    case 'SIDEBAR_FOLD_TOGGLE':
      return { ...s, sidebarCollapsed: !s.sidebarCollapsed };
    case 'SIDEBAR_SET_COLLAPSED':
      return { ...s, sidebarCollapsed: a.collapsed };
    case 'SIDEBAR_WIDTH':
      // Snap into [MIN, MAX]. Dragging below MIN is what triggers a
      // collapse, but that decision lives in the drag handler (it has
      // the raw cursor delta); here we just keep the stored width sane.
      return { ...s, sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(a.width, SIDEBAR_MAX_WIDTH)) };
    case 'TERMINAL_TOGGLE':
      return { ...s, terminalOpen: !s.terminalOpen };
    case 'TERMINAL_WIDTH':
      // Clamp to sensible bounds. Below ~280 the prompt wraps every
      // word; above ~70% of viewport leaves no room for content.
      return { ...s, terminalWidth: Math.max(280, Math.min(a.width, 1200)) };
    case 'TERMINAL_CLIS':
      return { ...s, terminalCli: a.current, terminalClis: a.clis };
    case 'TERMINAL_CLI':
      return { ...s, terminalCli: a.id };
    case 'TERMINAL_TAB_NEW':
      return {
        ...s,
        terminalTabs: [...s.terminalTabs, a.tab],
        activeTerminalTabId: a.tab.id,
      };
    case 'TERMINAL_TAB_CLOSE': {
      const idx = s.terminalTabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return s;
      const nextTabs = s.terminalTabs.filter((t) => t.id !== a.id);
      // If we just closed the active tab, jump to a neighbor (prefer
      // the one immediately to the right, fall back to the left).
      let nextActive = s.activeTerminalTabId;
      if (s.activeTerminalTabId === a.id) {
        nextActive = nextTabs[idx]?.id ?? nextTabs[idx - 1]?.id ?? null;
      }
      return { ...s, terminalTabs: nextTabs, activeTerminalTabId: nextActive };
    }
    case 'TERMINAL_TAB_ACTIVATE':
      if (!s.terminalTabs.some((t) => t.id === a.id)) return s;
      return { ...s, activeTerminalTabId: a.id };
    case 'TERMINAL_TABS_RESET':
      // Wipes ALL tabs — called on space switch (the server kills every
      // PTY in that flow; the frontend has to drop its tab list too or
      // we'd render dead xterms pointing at the old cwd).
      return { ...s, terminalTabs: [], activeTerminalTabId: null };
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
    case 'SAVE_STATUS':
      return patchActiveTab(s, { saveStatus: a.status });
    case 'SYNC_RUNNING':
      return { ...s, syncRunning: a.running };
    case 'FILTER':
      return { ...s, filterQuery: a.q };
    case 'SEARCH_START':
      return { ...s, searching: true };
    case 'SEARCH_HITS':
      return { ...s, searching: false, searchHits: a.hits, keywordResult: null };
    case 'SEARCH_KEYWORD':
      return { ...s, searching: false, keywordResult: a.result, searchHits: null };
    case 'SEARCH_CLEAR':
      return { ...s, searching: false, searchHits: null, keywordResult: null };
    case 'SEARCH_MODE':
      // Clear prior results so the renderer shows the new mode's empty
      // state immediately; runSearch will repopulate if a query is live.
      return { ...s, searchMode: a.mode, searchHits: null, keywordResult: null };
    case 'SIDEBAR_VIEW':
      return { ...s, activeSidebarView: a.view };
    case 'SEARCH_CASE_STRICT':
      // Result set semantics change → clear and let runSearch refill.
      return { ...s, caseStrict: a.strict, keywordResult: null };
    case 'SEARCH_WHOLE_WORD':
      return { ...s, wholeWord: a.on, keywordResult: null };
    case 'SNAPSHOT_WARNING':
      return { ...s, snapshotWarning: a.warning };
    case 'PDF_FAILURES':
      return { ...s, pdfFailures: a.failures };
    case 'CTX_MENU':
      return { ...s, ctxMenu: a.menu };
    case 'RENAMING':
      return { ...s, renaming: a.renaming };
    case 'MODAL_OPEN':
      return { ...s, modal: a.request };
    case 'MODAL_CLOSE':
      return { ...s, modal: null };
    case 'TOAST_ADD':
      return { ...s, toasts: [...s.toasts, a.toast] };
    case 'TOAST_DISMISS':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
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
    case 'NAV_PUSH': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      const trimmed = tab.navStack.slice(0, tab.navCursor + 1);
      if (a.currentScrollY != null && trimmed.length > 0) {
        const last = trimmed[trimmed.length - 1];
        trimmed[trimmed.length - 1] = { ...last, scrollY: a.currentScrollY };
      }
      trimmed.push(a.entry);
      return patchActiveTab(s, { navStack: trimmed, navCursor: trimmed.length - 1 });
    }
    case 'NAV_GOTO': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      if (a.cursor < 0 || a.cursor >= tab.navStack.length) return s;
      let next = tab.navStack;
      if (a.currentScrollY != null && tab.navCursor >= 0 && tab.navCursor < tab.navStack.length) {
        next = tab.navStack.slice();
        next[tab.navCursor] = { ...next[tab.navCursor], scrollY: a.currentScrollY };
      }
      return patchActiveTab(s, { navStack: next, navCursor: a.cursor });
    }
    case 'NAV_SNAPSHOT_SCROLL': {
      const tab = getActiveTab(s);
      if (!tab) return s;
      if (tab.navCursor < 0 || tab.navCursor >= tab.navStack.length) return s;
      const next = tab.navStack.slice();
      next[tab.navCursor] = { ...next[tab.navCursor], scrollY: a.scrollY };
      return patchActiveTab(s, { navStack: next });
    }
    case 'NAV_RESET':
      // Space-switch resets ALL tabs' nav stacks.
      return {
        ...s,
        tabs: s.tabs.map((t) => ({
          ...t,
          navStack: [],
          navCursor: -1,
          pendingAnchor: null,
          pendingScrollY: null,
        })),
      };
    case 'PENDING_SCROLL':
      return patchActiveTab(s, { pendingAnchor: a.anchor, pendingScrollY: a.scrollY });
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
