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
  Heading,
  SearchHit,
  TerminalCli,
} from '../api';

export interface SaveStatus {
  text: string;
  cls: '' | 'saved' | 'error';
}

export interface OpenFile {
  name: string;
  format: 'md' | 'html';
  /** Last on-disk content — diff target for the autosave path. */
  content: string;
  /** Server-supplied for HTML; live-extracted for MD (see Outline). */
  headings: Heading[];
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
  saveStatus: SaveStatus;
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
  /** True hides the whole sidebar pane (Cmd+B equivalent in VSCode). */
  sidebarCollapsed: boolean;
  /** True opens the right-side terminal panel. */
  terminalOpen: boolean;
  /** Terminal panel width in pixels — user-resizable via drag handle. */
  terminalWidth: number;
  /** Currently selected AI CLI id (`claude` / `codex` / …). Server is
   *  the source of truth; this mirrors it so the chip can render the
   *  right label / icon without an API hop on every render. */
  terminalCli: string;
  /** Catalog of available CLIs from the server, populated on demand. */
  terminalClis: TerminalCli[];
  /** Monotonic session counter — bumped by the picker's "Start new
   *  session" action. `<XtermView>` includes this in its effect deps,
   *  so incrementing it forces a teardown + respawn of the WS + PTY.
   *  Used because hiding the panel (collapse) no longer kills the
   *  session — the user needs an explicit way to restart it. */
  terminalSessionId: number;

  pendingNames: Set<string>;
  /** Space-relative paths of PDFs the server is converting right now.
   *  Sidebar shows a "Converting…" row per entry; transition to
   *  empty triggers a `loadFiles` so the produced `.html` shows up
   *  in the tree without waiting for the next user action. */
  pendingConversions: string[];

  syncRunning: boolean;

  /** Sidebar search input. Empty = show tree; non-empty = run semantic
   *  search against `/api/search`. The result lands in `searchHits`. */
  filterQuery: string;
  /** `null` = not in search mode (query empty or cleared). `[]` = ran
   *  and got nothing. Non-empty array = ranked hits from `/api/search`. */
  searchHits: SearchHit[] | null;
  searching: boolean;

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
  terminalOpen: false,
  terminalWidth: 480,
  terminalCli: 'claude',
  terminalClis: [],
  terminalSessionId: 0,
  pendingNames: new Set(),
  pendingConversions: [],
  syncRunning: false,
  filterQuery: '',
  searchHits: null,
  searching: false,
  ctxMenu: null,
  renaming: null,
  cascadePrompt: null,
  modal: null,
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
  | { type: 'OUTLINE_HEADINGS'; headings: Heading[] }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'EXPAND_FOLDER'; path: string }
  | { type: 'COLLAPSE_ALL_FOLDERS' }
  | { type: 'EXPAND_ALL_FOLDERS'; paths: string[] }
  | { type: 'SPACE_FOLD_TOGGLE' }
  | { type: 'SIDEBAR_FOLD_TOGGLE' }
  | { type: 'TERMINAL_TOGGLE' }
  | { type: 'TERMINAL_WIDTH'; width: number }
  | { type: 'TERMINAL_CLIS'; current: string; clis: State['terminalClis'] }
  | { type: 'TERMINAL_CLI'; id: string }
  | { type: 'TERMINAL_NEW_SESSION' }
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
  | { type: 'SEARCH_CLEAR' }
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
  | { type: 'CASCADE_PROMPT'; prompt: CascadePrompt | null }
  | { type: 'MODAL_OPEN'; request: ModalRequest }
  | { type: 'MODAL_CLOSE' }
  /** Promote a preview tab to a pinned one (sets `preview = false`).
   *  Triggered by double-click on a sidebar file, double-click on the
   *  tab title, or entering edit mode on the tab. */
  | { type: 'PROMOTE_TAB'; id: string }
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
        headings: a.body.headings ?? [],
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
    case 'OUTLINE_HEADINGS': {
      const tab = getActiveTab(s);
      if (!tab?.file) return s;
      return patchActiveTab(s, { file: { ...tab.file, headings: a.headings } });
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
    case 'TERMINAL_NEW_SESSION':
      return { ...s, terminalSessionId: s.terminalSessionId + 1 };
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
      return { ...s, searching: false, searchHits: a.hits };
    case 'SEARCH_CLEAR':
      return { ...s, searching: false, searchHits: null };
    case 'CTX_MENU':
      return { ...s, ctxMenu: a.menu };
    case 'RENAMING':
      return { ...s, renaming: a.renaming };
    case 'MODAL_OPEN':
      return { ...s, modal: a.request };
    case 'MODAL_CLOSE':
      return { ...s, modal: null };
    case 'PROMOTE_TAB':
      return {
        ...s,
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, preview: false } : t)),
      };
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
