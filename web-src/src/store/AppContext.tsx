/**
 * React Provider + action thunks for the renderer.
 *
 * All pure state (types, reducer, initialState, helpers) lives in
 * `state.ts`. This file holds:
 *   - the React Context wiring (`AppContext`, `AppProvider`, `useApp`)
 *   - imperative refs for long-lived state (autosave timer, poll timer,
 *     `<CodeEditor>` handle, cascade + modal resolvers)
 *   - the ~30 async action thunks that components call via `actions.*`
 *   - the two `useEffect`s that own bootstrap + before-unload flush
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  api,
  ApiError,
} from '../api';
import {
  getActiveTab,
  initialState,
  reducer,
  type Action,
  type CascadeDecision,
  type CascadePrompt,
  type PendingHighlight,
  type State,
} from './state';

// Re-export the state types from a single barrel so consumers that
// import from `'../store/AppContext'` keep working. The Provider
// itself owns the React-side surface (AppActions, EditorHandle); the
// data shapes live in `state.ts`.
export type {
  Action,
  CascadeDecision,
  CascadePrompt,
  CtxMenu,
  ModalRequest,
  NavEntry,
  OpenFile,
  PendingHighlight,
  SaveStatus,
  State,
  Tab,
} from './state';

/** Imperative handle a `<CodeEditor>` registers on mount so save /
 *  rename / file-switch actions can pull the live buffer. */
export interface EditorHandle {
  getValue: () => string;
  focus: () => void;
}

/** Per-view find driver. Whichever view is currently rendered (CM
 *  editor, MD preview iframe, HTML preview iframe) registers one of
 *  these on mount so the global FindBar can drive search without
 *  knowing which surface is underneath. All methods may return a
 *  Promise — the HTML preview path is async because it round-trips
 *  through postMessage to the sandboxed iframe. */
export interface MatchInfo { current: number; total: number; }
export interface FindController {
  setQuery: (query: string, opts: { wholeWord: boolean }) => MatchInfo | Promise<MatchInfo>;
  next: () => MatchInfo | Promise<MatchInfo>;
  prev: () => MatchInfo | Promise<MatchInfo>;
  /** Tear down highlights / decorations. Called when the bar closes
   *  or when this controller is replaced by a tab/mode switch. */
  close: () => void;
}

export interface AppActions {
  bootstrap: () => Promise<void>;
  openSpace: (path: string) => Promise<void>;
  /** Open a space by name — single segment under the KB root.
   *  Preferred over `openSpace(path)` for new UI flows now that
   *  spaces are flat. */
  openSpaceByName: (name: string, opts?: { create?: boolean }) => Promise<void>;
  goHome: () => void;

  loadFiles: () => Promise<void>;
  refreshIndexState: () => Promise<void>;
  runSync: () => Promise<void>;
  /** Run a search. Pass `mode` to force a specific routing — useful
   *  when the caller has just dispatched `SEARCH_MODE` and can't rely
   *  on `stateRef` reflecting that yet (it updates after commit, not
   *  in-line with the dispatch). Default reads from state. */
  runSearch: (query: string, mode?: 'semantic' | 'keyword') => Promise<void>;
  /** Clear the active space's snapshot-import warning. Fires
   *  `/api/snapshot-warning/dismiss` so the warning doesn't reappear
   *  the next time `/api/index-status` polls. */
  dismissSnapshotWarning: () => Promise<void>;
  /** Replace a folder's ordered child list (manual sidebar ordering).
   *  Optimistic — state updates immediately, then a PUT is fired.
   *  Failure of the PUT rolls the renderer back to whatever the server
   *  has next time we reload. */
  setFolderOrder: (parentPath: string, names: string[]) => Promise<void>;

  selectFile: (name: string) => Promise<void>;
  /** Same as `selectFile` but additionally arms the viewer to highlight
   *  a specific chunk on next render (typically from a search hit
   *  click). HTML / MD / Code viewers use `startLine` / `endLine` for
   *  line-range overlay; PdfPreview uses `chunkText` to find the
   *  passage via pdfjs's find controller. */
  selectFileWithHighlight: (name: string, hit: PendingHighlight) => Promise<void>;
  /** Open a file in a new tab (double-click in sidebar / drag-out
   *  semantics). Always creates a new tab even if the file is already
   *  open in another tab — VS Code does the same with the explicit
   *  "Open in New Tab" command. */
  openInNewTab: (name: string) => Promise<void>;
  newTab: () => Promise<void>;
  /** Open `<kbRoot>/STASHBASE.md` (the agent-maintained KB overview)
   *  in a new tab. Read-only — no save / edit. */
  openKbOverview: () => Promise<void>;
  /** Open `<kbRoot>/STASHBASE.md` (KB-level rules book) as a
   *  kb-kind tab. Same one-tab-only / activate-if-open rule
   *  as `openKbOverview`. */
  openKbRules: () => Promise<void>;
  /** Open `<space>/STASHBASE.md` (per-space rules) as a library-
   *  kind tab. `name` is the space name. */
  openSpaceRules: (name: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** Close whichever tab is currently active. Convenience for keyboard
   *  shortcuts (`⌘W`) and UI buttons that don't have a tab id handy. */
  closeActiveTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  /** Cross-file link nav: open `name` (with optional anchor) and push a
   *  new entry into the back/forward stack. Used by preview iframes
   *  forwarding `<a>` clicks. */
  navigateTo: (name: string, anchor?: string) => Promise<void>;
  navBack: () => Promise<void>;
  navForward: () => Promise<void>;
  /** Called by the preview iframe after it has consumed the pending
   *  anchor / scrollY so a follow-up keystroke / re-render won't
   *  re-scroll. */
  consumePendingScroll: () => void;
  /** Called by the viewer after it has applied a pending-highlight
   *  (rendered the chunk overlay / kicked off the PDF text search)
   *  so a re-render doesn't re-trigger the effect. */
  consumePendingHighlight: () => void;
  /** Settle the pending cascade dialog with the user's choice. The
   *  rename action awaits this. */
  resolveCascadePrompt: (decision: CascadeDecision) => void;
  /** Show a modal alert and resolve once dismissed. Replaces
   *  `window.alert`. */
  alert: (message: string) => Promise<void>;
  /** Show a modal confirm and resolve to true (OK) / false (Cancel).
   *  Replaces `window.confirm`. */
  confirm: (message: string) => Promise<boolean>;
  /** Settle the pending alert/confirm modal with the user's choice.
   *  Called by the rendered modal's buttons. */
  resolveModal: (value: boolean) => void;
  /** Push a toast — lightweight non-blocking feedback. Use this for
   *  "operation succeeded / failed" messages instead of `alert` when
   *  the user can just keep working. Returns the new toast's id so
   *  the caller can dismiss it programmatically (e.g. when a long-
   *  running operation finally settles).
   *
   *  Default ttl: info / success 3000ms, warning 5000ms, error null
   *  (persistent — error toasts only go away when the user clicks
   *  the × or presses Esc / clicks the Reload button on the toast). */
  toast: (
    message: string,
    opts?: {
      level?: 'info' | 'success' | 'warning' | 'error';
      ttl?: number | null;
      action?: { label: string; onClick: () => void };
    },
  ) => string;
  dismissToast: (id: string) => void;
  toggleEditMode: () => Promise<void>;

  newNote: (format?: 'md' | 'html') => Promise<void>;
  newFolder: (path: string) => Promise<void>;
  deleteFile: (name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  renameFile: (oldName: string, newBaseName: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  moveFile: (oldPath: string, targetDir: string) => Promise<void>;
  upload: (items: { file: File; relPath: string }[], dir: string) => Promise<boolean>;

  scheduleSave: () => void;
  flushSave: () => Promise<void>;

  registerEditor: (h: EditorHandle | null) => void;
  /** Sidebar SearchBox registers its input element on mount so
   *  `focusSearch` can reach it without a DOM query. Same shape as
   *  `registerEditor` — pass `null` on unmount. */
  registerSearchInput: (el: HTMLInputElement | null) => void;
  /** Focus + select the sidebar search input. Un-collapses the sidebar
   *  first if hidden; flashes a brief glow so the user can tell where
   *  focus landed. Used by the empty-tab landing and the `⌘O` hotkey. */
  focusSearch: () => void;

  /** A view registers its find driver on mount; `null` on unmount.
   *  Switching tabs / toggling edit mode replaces it. */
  registerFindController: (c: FindController | null) => void;
  /** Open the in-document find bar (Cmd+F). No-op if already open;
   *  the bar's own effect re-focuses the input on re-open. */
  openFind: () => void;
  /** Close the find bar + tear down whatever the active controller
   *  highlighted. Also called implicitly on space switch / tab close. */
  closeFind: () => void;
  setFindQuery: (q: string) => void;
  toggleFindWholeWord: () => void;
  findNext: () => void;
  findPrev: () => void;
}

const AppContext = createContext<{
  state: State;
  actions: AppActions;
  dispatch: (a: Action) => void;
} | null>(null);

const AUTOSAVE_DEBOUNCE_MS = 1200;
const POLL_PENDING_MS = 1500;
const POLL_IDLE_MS = 8000;

function shallowEqualSnapshotWarning(
  a: State['snapshotWarning'],
  b: State['snapshotWarning'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.skipped !== b.skipped) return false;
  if (a.at !== b.at) return false;
  if (a.details.length !== b.details.length) return false;
  return a.details.every((d, i) =>
    d.provider === b.details[i].provider && d.chunks === b.details[i].chunks,
  );
}

function shallowEqualPdfFailures(
  a: State['pdfFailures'],
  b: State['pdfFailures'],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((f, i) =>
    f.path === b[i].path && f.attempts === b[i].attempts && f.lastError === b[i].lastError,
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  // Always boot into the Files view. Earlier we persisted the last
  // sidebar view to localStorage so reload would land back where the
  // user was, but the "what's in this space" tree is the canonical
  // landing surface — search / kb are tasks the user enters on
  // purpose, not states to be restored. Resetting on launch matches
  // user expectation ("打开应用默认选中文件") and side-steps the case
  // where a stale `search` / `kb` value persists past the user
  // remembering they ever picked it.
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  // Sidebar's SearchBox registers its input here so `focusSearch` can
  // reach it without a global DOM query. Mirrors `editorRef`.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Active find driver — whichever view is currently visible (CM
  // editor / MD preview / HTML preview iframe) registers itself here
  // on mount, deregisters on unmount.
  const findCtlRef = useRef<FindController | null>(null);
  // Race protection for `runSearch`: every call bumps this counter and
  // remembers its own value; an older request's response is dropped
  // when it returns after a newer one has been issued.
  const searchGen = useRef(0);
  // Last `treeVersion` we saw from `/api/index-status`. Any bump means
  // the watcher detected a disk change since last poll → refetch files.
  const lastTreeVersion = useRef<number>(-1);
  /** Promise resolver for the pending cascade dialog. Set when the
   *  rename action asks the user; cleared once they pick. */
  const cascadeResolveRef = useRef<((d: CascadeDecision) => void) | null>(null);

  const askCascade = useCallback((prompt: CascadePrompt): Promise<CascadeDecision> => {
    return new Promise<CascadeDecision>((resolve) => {
      // If a previous prompt is still open (shouldn't happen — rename
      // input is single-tracked), cancel it so we don't lose a
      // resolver in the ref.
      if (cascadeResolveRef.current) cascadeResolveRef.current('cancel');
      cascadeResolveRef.current = resolve;
      dispatch({ type: 'CASCADE_PROMPT', prompt });
    });
  }, []);

  const resolveCascadePrompt = useCallback((decision: CascadeDecision) => {
    const r = cascadeResolveRef.current;
    cascadeResolveRef.current = null;
    dispatch({ type: 'CASCADE_PROMPT', prompt: null });
    if (r) r(decision);
  }, []);

  // Modal alert/confirm — single-tracked: a previous open prompt that
  // hasn't been resolved gets a false answer so we don't leak the
  // resolver. The native window.alert blocks the renderer thread in
  // Electron and steals focus; this version is async and themable.
  const modalResolveRef = useRef<((v: boolean) => void) | null>(null);
  const showAlert = useCallback((message: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (modalResolveRef.current) modalResolveRef.current(false);
      modalResolveRef.current = () => resolve();
      dispatch({ type: 'MODAL_OPEN', request: { type: 'alert', message } });
    });
  }, []);
  const askConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      if (modalResolveRef.current) modalResolveRef.current(false);
      modalResolveRef.current = resolve;
      dispatch({ type: 'MODAL_OPEN', request: { type: 'confirm', message } });
    });
  }, []);
  const resolveModal = useCallback((value: boolean) => {
    const r = modalResolveRef.current;
    modalResolveRef.current = null;
    dispatch({ type: 'MODAL_CLOSE' });
    if (r) r(value);
  }, []);

  // Monotonic counter for toast ids — crypto.randomUUID would work
  // too, but a plain counter is enough (toasts are short-lived and
  // never persisted) and keeps test fixtures predictable.
  const toastSeq = useRef(0);
  const toast = useCallback((
    message: string,
    opts?: {
      level?: 'info' | 'success' | 'warning' | 'error';
      ttl?: number | null;
      action?: { label: string; onClick: () => void };
    },
  ): string => {
    const level = opts?.level ?? 'info';
    // Per-level defaults: error is persistent so the user can't miss
    // it; warnings linger a bit longer than success/info; everything
    // else is a brisk 3 s.
    const defaultTtl =
      level === 'error' ? null
      : level === 'warning' ? 5000
      : 3000;
    const id = `toast-${++toastSeq.current}`;
    dispatch({
      type: 'TOAST_ADD',
      toast: {
        id,
        level,
        message,
        action: opts?.action,
        ttl: opts?.ttl !== undefined ? opts.ttl : defaultTtl,
      },
    });
    return id;
  }, []);
  const dismissToast = useCallback((id: string) => {
    dispatch({ type: 'TOAST_DISMISS', id });
  }, []);

  /** Run the rename-preview probe, and if it surfaces cross-references,
   *  pop the cascade dialog. Encodes the decision tri-state once so the
   *  rename / move / folder-rename actions don't each spell it out:
   *
   *    `true`  → cascade-update links
   *    `false` → user wants to skip link updates but still rename
   *    `null`  → user cancelled; caller should bail without side effects
   *
   *  Preview-API failures are swallowed (treated as zero-hit). */
  const askCascadeForRename = useCallback(async (
    kind: 'file' | 'folder',
    oldPath: string,
    newPath: string,
  ): Promise<boolean | null> => {
    try {
      const preview = await api.renamePreview(kind, oldPath, newPath);
      if (preview.files === 0) return true;
      const decision = await askCascade({
        kind, oldPath, newPath,
        files: preview.files, links: preview.links,
      });
      if (decision === 'cancel') return null;
      return decision === 'update';
    } catch (err) {
      console.warn(`[${kind} rename] preview failed:`, err);
      return true;
    }
  }, [askCascade]);

  const loadFiles = useCallback(async () => {
    try {
      const j = await api.listFiles();
      dispatch({
        type: 'FILES_LOADED',
        files: j.files ?? [],
        folders: j.folders ?? [],
        space: j.space ?? 'notes',
      });
    } catch {
      dispatch({ type: 'FILES_LOADED', files: [], folders: [], space: 'notes' });
    }
  }, []);

  /** Fetch the per-space manual ordering map. Called alongside
   *  `loadFiles` on space switch and on bootstrap. Errors are
   *  swallowed — the tree falls back to default sort. */
  const loadFileOrder = useCallback(async () => {
    try {
      const order = await api.getFileOrder();
      dispatch({ type: 'FILE_ORDER_LOADED', order });
    } catch {
      dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
    }
  }, []);

  const setFolderOrder = useCallback(async (parentPath: string, names: string[]) => {
    // Optimistic — render the new order now, persist behind it.
    dispatch({ type: 'FILE_ORDER_SET', parentPath, names });
    try {
      await api.putFileOrder(parentPath, names);
    } catch (err) {
      console.warn('[file-order] PUT failed; will resync on next space load', err);
    }
  }, []);

  /** Re-fetch the active tab's body from disk and patch the open file
   *  if it changed. Used after the watcher detects an external edit
   *  (typically: Claude Code wrote to the file via its `Edit` tool from
   *  the panel). No-op when nothing's open, when the active tab is in
   *  edit mode (would clobber the unsaved buffer), or when disk + tab
   *  agree. Failures are swallowed — the sidebar reload that runs in
   *  the same poll cycle covers the "file got deleted externally" case. */
  const refreshActiveTabFromDisk = useCallback(async () => {
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file) return;
    if (tab.editMode) return;
    const name = tab.file.name;
    try {
      const body = await api.getFile(name);
      // The active tab may have been swapped (or the file renamed) in
      // the time it took to fetch — re-check before patching.
      const stillActive = getActiveTab(stateRef.current)?.file?.name === name;
      if (!stillActive) return;
      if (body.content === tab.file.content) return;
      dispatch({
        type: 'FILE_PATCH',
        patch: { content: body.content },
      });
    } catch {
      /* swallow — sidebar will reflect a delete on the next poll */
    }
  }, []);

  const refreshIndexState = useCallback(async () => {
    let nextDelay = POLL_IDLE_MS;
    try {
      const s = await api.indexStatus();
      const indexReady = s.indexReady !== false;
      const newPending = indexReady ? new Set(s.pending ?? []) : new Set<string>();
      const newConv = s.pendingConversions ?? [];
      const prev = stateRef.current;
      // Trigger a `/api/files` refresh whenever the indexer's
      // awareness of the disk grew or shrank — covers new files
      // landing from the watcher (vim edits) AND `.html` notes
      // appearing after PDF conversion finishes, both of which
      // would otherwise leave the sidebar tree stale until the
      // next user action.
      const pendingChanged =
        newPending.size !== prev.pendingNames.size
        || [...newPending].some((n) => !prev.pendingNames.has(n))
        || [...prev.pendingNames].some((n) => !newPending.has(n));
      const convChanged =
        newConv.length !== prev.pendingConversions.length
        || newConv.some((p, i) => p !== prev.pendingConversions[i]);
      // `treeVersion` covers writes the indexer's `pending` set wouldn't
      // catch — non-indexable files (`.json`, `.csv`, empty dirs) and
      // fast embeds whose pending flips empty between polls. First
      // poll initialises the ref (no spurious reload).
      const newTreeVersion = typeof s.treeVersion === 'number' ? s.treeVersion : -1;
      const treeChanged =
        lastTreeVersion.current >= 0 && newTreeVersion !== lastTreeVersion.current;
      lastTreeVersion.current = newTreeVersion;
      dispatch({ type: 'PENDING_NAMES', names: newPending });
      if (convChanged) dispatch({ type: 'PENDING_CONVERSIONS', paths: newConv });
      // Snapshot warning is sticky until the user dismisses it (or a
      // fresh import wipes it server-side). Always reflect what the
      // server reports so a switch back to a "fixed" space clears the
      // banner.
      const incomingWarning = s.snapshotWarning ?? null;
      if (!shallowEqualSnapshotWarning(prev.snapshotWarning, incomingWarning)) {
        dispatch({ type: 'SNAPSHOT_WARNING', warning: incomingWarning });
      }
      const incomingFailures = s.pdfFailures ?? [];
      if (!shallowEqualPdfFailures(prev.pdfFailures, incomingFailures)) {
        dispatch({ type: 'PDF_FAILURES', failures: incomingFailures });
      }
      if (pendingChanged || convChanged || treeChanged) void loadFiles();
      // Tree changed = someone else wrote to disk (Claude Code in the
      // terminal panel is the common case). Re-read the active tab's
      // body so the preview / read-only editor doesn't keep showing
      // stale content. Skipped while the user is editing — clobbering
      // their unsaved buffer is worse than showing slightly old text;
      // a "this file changed on disk, reload?" prompt belongs here
      // long-term, but for now silent reload-when-safe is the best
      // tradeoff vs. silently stale.
      if (treeChanged) void refreshActiveTabFromDisk();
      // Keep polling fast while a conversion is in flight, even if
      // the index itself is settled — the user is waiting on a file
      // to appear.
      const busy = !indexReady || !s.upToDate || newConv.length > 0;
      nextDelay = busy ? POLL_PENDING_MS : POLL_IDLE_MS;
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        dispatch({ type: 'PENDING_NAMES', names: new Set() });
        dispatch({ type: 'PENDING_CONVERSIONS', paths: [] });
      }
    }
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => { void refreshIndexState(); }, nextDelay);
  }, [loadFiles, refreshActiveTabFromDisk]);

  /** Fire whichever search the current `searchMode` selects and dispatch
   *  the result. Empty query clears (back to tree view). Bails out on
   *  stale responses so fast typing doesn't show flashes of older
   *  results — also covers the case where the user toggled mode while a
   *  prior query was in flight.
   *
   *  `modeOverride` exists because `stateRef.current.searchMode`
   *  updates AFTER React commits, not in-line with a dispatch — so a
   *  caller that just dispatched `SEARCH_MODE` and synchronously calls
   *  `runSearch` would otherwise read the stale mode and fire the
   *  wrong API. Mode-toggle callers pass the new mode explicitly. */
  const runSearch = useCallback(async (query: string, modeOverride?: 'semantic' | 'keyword') => {
    const myGen = ++searchGen.current;
    const q = query.trim();
    if (!q) {
      dispatch({ type: 'SEARCH_CLEAR' });
      return;
    }
    const mode = modeOverride ?? stateRef.current.searchMode;
    dispatch({ type: 'SEARCH_START' });
    try {
      if (mode === 'keyword') {
        // Pull case-strict / whole-word / current space straight from
        // state. The `space` field is the active space of THIS window;
        // passing it explicitly avoids the server falling back to the
        // process-wide `currentSpace` singleton, which would pick the
        // wrong space in multi-window sessions.
        const s = stateRef.current;
        const result = await api.keywordSearch(q, {
          caseStrict: s.caseStrict,
          wholeWord: s.wholeWord,
          space: s.space || undefined,
        });
        if (myGen !== searchGen.current) return;
        dispatch({ type: 'SEARCH_KEYWORD', result });
      } else {
        const { hits } = await api.search(q, 15);
        if (myGen !== searchGen.current) return;
        dispatch({ type: 'SEARCH_HITS', hits });
      }
    } catch (err) {
      if (myGen !== searchGen.current) return;
      // ApiError 412 = no space open. Anything else: surface empty
      // result so the UI says "No matches" instead of hanging on
      // "Searching…".
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[search:${mode}] failed:`, msg);
      if (mode === 'keyword') {
        dispatch({ type: 'SEARCH_KEYWORD', result: { query: q, space: '', files: [], totalMatches: 0, truncated: false } });
      } else {
        dispatch({ type: 'SEARCH_HITS', hits: [] });
      }
    }
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const cur = getActiveTab(stateRef.current)?.file ?? null;
    const handle = editorRef.current;
    if (!cur || !handle) return;
    // KB-overview tab is read-only — even if a CodeMirror handle
    // is registered (edit button hidden but defense-in-depth), don't
    // ever PUT it back to /api/files/STASHBASE.md (which would resolve
    // inside the current space, not at kbRoot).
    if (cur.kind === 'kb') return;
    const content = handle.getValue();
    if (content === cur.content) {
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      return;
    }
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Saving…', cls: '' } });
    try {
      await api.putFile(cur.name, content);
      dispatch({ type: 'FILE_PATCH', patch: { content } });
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      void loadFiles();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Save failed: ' + msg, cls: 'error' } });
    }
  }, [loadFiles]);

  const scheduleSave = useCallback(() => {
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  /** Read the current MD preview's scroll position so the entry we're
   *  about to leave can be restored on back. Only the read-only MD
   *  iframe is `allow-same-origin`; HTML and split-edit previews can't
   *  be read from the parent, so they return null. */
  function captureCurrentScrollY(): number | null {
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file || tab.file.format !== 'md' || tab.editMode) return null;
    const iframe = document.getElementById('previewFrame') as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!doc) return null;
    return doc.documentElement.scrollTop || doc.body.scrollTop || 0;
  }

  /** Shared file-load. Pushes onto the nav stack when `push=true`
   *  (sidebar click, link click); back/forward call this with
   *  `push=false` and provide a precomputed cursor update. With
   *  `newTab=true` (double-click / `+` then click) the file lands in a
   *  freshly-created tab rather than replacing the active tab's file.
   *  `preview` is forwarded to the FILE_OPEN action — see its docstring
   *  in `state.ts` for the create-vs-replace semantics. */
  const loadFile = useCallback(async (
    name: string,
    opts: {
      push: boolean;
      newTab?: boolean;
      preview?: boolean;
      anchor?: string;
      restoreScrollY?: number;
      cursor?: number;
    },
  ) => {
    const cur = getActiveTab(stateRef.current)?.file ?? null;
    if (editorRef.current && cur && cur.name !== name && !opts.newTab) {
      await flushSave();
    }
    let body;
    if (/\.pdf$/i.test(name)) {
      // PDFs aren't loaded as text — PdfPreview pulls the binary from
      // `/asset/*` directly. We synthesize a FileBody so the rest of
      // the tab / nav / save-status machinery treats it like any
      // other open file.
      body = { name, format: 'pdf' as const, content: '' };
    } else {
      try {
        body = await api.getFile(name);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'SAVE_STATUS', status: { text: msg, cls: 'error' } });
        return;
      }
    }
    const scrollY = opts.newTab ? null : captureCurrentScrollY();
    // "Implicit new tab" — first open in a fresh session (no active
    // tab yet) goes through the new-tab path too, so the new tab's
    // navStack gets the initial NAV_PUSH instead of dropping it.
    const noActiveTab = stateRef.current.activeTabId == null || !getActiveTab(stateRef.current);
    const newTabMode = !!opts.newTab || noActiveTab;
    // For new-tab mode we must dispatch FILE_OPEN with newTab=true
    // FIRST — that creates the tab and makes it active — so the
    // subsequent NAV_PUSH writes into the new tab's nav stack.
    if (newTabMode) {
      dispatch({ type: 'FILE_OPEN', body, newTab: !noActiveTab, preview: opts.preview });
      dispatch({
        type: 'NAV_PUSH',
        entry: { name, anchor: opts.anchor },
        currentScrollY: null,
      });
    } else {
      if (opts.push) {
        dispatch({
          type: 'NAV_PUSH',
          entry: { name, anchor: opts.anchor },
          currentScrollY: scrollY,
        });
      } else if (opts.cursor != null) {
        dispatch({ type: 'NAV_GOTO', cursor: opts.cursor, currentScrollY: scrollY });
      }
      dispatch({ type: 'FILE_OPEN', body, preview: opts.preview });
    }
    dispatch({
      type: 'PENDING_SCROLL',
      anchor: opts.anchor ?? null,
      scrollY: opts.restoreScrollY ?? null,
    });
  }, [flushSave]);

  /** Single-click in the sidebar = open as PREVIEW. VS Code semantics:
   *    1. File already in any tab → activate it, keep its preview/
   *       pinned status unchanged.
   *    2. Active tab is blank (no file) → reuse it as preview.
   *    3. Some other tab is already a preview → activate + replace its
   *       content (the previewed file gets "kicked out" — by design).
   *    4. Otherwise → create a fresh preview tab. */
  const selectFile = useCallback(async (name: string) => {
    const s = stateRef.current;
    const existing = s.tabs.find((t) => t.file?.name === name);
    if (existing) {
      if (s.activeTabId !== existing.id) {
        if (editorRef.current) await flushSave();
        dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      }
      return;
    }
    const active = getActiveTab(s);
    if (active && !active.file) {
      await loadFile(name, { push: true, preview: true });
      return;
    }
    const previewTab = s.tabs.find((t) => t.preview);
    if (previewTab) {
      if (s.activeTabId !== previewTab.id) {
        if (editorRef.current) await flushSave();
        dispatch({ type: 'ACTIVATE_TAB', id: previewTab.id });
      }
      // FILE_OPEN with no `preview` field preserves the tab's existing
      // preview=true status, so the slot stays the "preview slot".
      await loadFile(name, { push: true });
      return;
    }
    await loadFile(name, { push: true, newTab: true, preview: true });
  }, [flushSave, loadFile]);

  /** Open `name` (preview-tab semantics like `selectFile`) and arm
   *  the viewer's pending-highlight slot. The viewer consumes it on
   *  next render and then calls `clearPendingHighlight`.
   *
   *  We deliberately do NOT auto-open the PDF split here — the design
   *  doc considered it, but in practice users searching mostly want
   *  to read the structured HTML; auto-mounting a PDF viewer in the
   *  right half is heavy and noisy. The "Show original PDF" toolbar
   *  button lets the user opt in when they actually want to verify
   *  against the source. */
  const selectFileWithHighlight = useCallback(async (name: string, hit: PendingHighlight) => {
    await selectFile(name);
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: hit });
    // Keyword-search hits carry `openFindBar: true` so the user can
    // walk every in-file match with Cmd+G. Setting `find.{open, query}`
    // BEFORE the viewer mounts means `registerFindController` sees the
    // pending query and primes the new controller immediately —
    // matches show up without the user re-typing.
    if (hit.openFindBar && hit.chunkText) {
      dispatch({ type: 'FIND_SET', patch: { query: hit.chunkText } });
      dispatch({ type: 'FIND_OPEN' });
    }
  }, [selectFile]);

  /** Double-click in the sidebar = open PINNED. VS Code semantics:
   *    1. File already open → activate, AND promote it if it was
   *       living in the preview slot (so it stops being kickable).
   *    2. Otherwise → fresh pinned tab. */
  const openInNewTab = useCallback(async (name: string) => {
    const s = stateRef.current;
    const existing = s.tabs.find((t) => t.file?.name === name);
    if (existing) {
      if (s.activeTabId !== existing.id) {
        if (editorRef.current) await flushSave();
        dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      }
      if (existing.preview) dispatch({ type: 'PROMOTE_TAB', id: existing.id });
      return;
    }
    if (editorRef.current) await flushSave();
    await loadFile(name, { push: true, newTab: true });
  }, [flushSave, loadFile]);

  const newTab = useCallback(async () => {
    if (editorRef.current) await flushSave();
    dispatch({ type: 'NEW_TAB' });
  }, [flushSave]);

  const openKbOverview = useCallback(async () => {
    try {
      // If the KB tab is already open, activate it instead of
      // stacking a duplicate — repeated clicks on the chrome button
      // shouldn't spawn endless tabs of the same overview file.
      const s = stateRef.current;
      const existing = s.tabs.find((t) => t.file?.kind === 'kb');
      if (existing) {
        if (existing.id !== s.activeTabId) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
        return;
      }
      if (editorRef.current) await flushSave();
      const r = await api.getKbOverview();
      dispatch({
        type: 'FILE_OPEN',
        body: {
          // Display name matches the actual on-disk file basename
          // (<kbRoot>/.stashbase/space-metadata.md per
          // `server/kb.ts:FILENAME`). STASHBASE.md (KB + per-space)
          // is reserved for the separate rules-book role and opens via
          // `openKbRules` / `openSpaceRules`.
          name: 'space-metadata.md',
          format: 'md',
          content: r.content,
          // Marks the tab as kb-scope: MainPane hides the edit
          // button and the save path is short-circuited for this kind.
          kind: 'kb',
        } as any,
        newTab: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast('Failed to load KB overview: ' + msg, { level: 'error' });
    }
  }, [flushSave, showAlert]);

  /** Shared between `openKbRules` and `openSpaceRules` — fetch some
   *  markdown, open it as a kb-kind tab whose name matches the
   *  on-disk filename (so the user reads "STASHBASE.md" or
   *  "<space>/STASHBASE.md" exactly, no aliasing). Tab dedup is by
   *  `name` since both rule files coexist in the same kind. */
  const openKbFile = useCallback(async (name: string, fetcher: () => Promise<{ content: string }>) => {
    try {
      const s = stateRef.current;
      const existing = s.tabs.find((t) => t.file?.kind === 'kb' && t.file?.name === name);
      if (existing) {
        if (existing.id !== s.activeTabId) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
        return;
      }
      if (editorRef.current) await flushSave();
      const r = await fetcher();
      dispatch({
        type: 'FILE_OPEN',
        body: {
          name,
          format: 'md',
          content: r.content,
          kind: 'kb',
        } as any,
        newTab: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load ${name}: ${msg}`, { level: 'error' });
    }
  }, [flushSave]);

  const openKbRules = useCallback(async () => {
    await openKbFile('STASHBASE.md', () => api.getKbRules());
  }, [openKbFile]);

  const openSpaceRules = useCallback(async (name: string) => {
    await openKbFile(`${name}/STASHBASE.md`, () => api.getSpaceRules(name));
  }, [openKbFile]);

  const closeTab = useCallback(async (id: string) => {
    const s = stateRef.current;
    if (s.activeTabId === id && editorRef.current) await flushSave();
    dispatch({ type: 'CLOSE_TAB', id });
  }, [flushSave]);

  const closeActiveTab = useCallback(async () => {
    const id = stateRef.current.activeTabId;
    if (!id) return;
    await closeTab(id);
  }, [closeTab]);

  const registerSearchInput = useCallback((el: HTMLInputElement | null) => {
    searchInputRef.current = el;
  }, []);

  const focusSearch = useCallback(() => {
    const s = stateRef.current;
    // Un-collapse the sidebar first if hidden — focusing an invisible
    // input is technically valid but reads as "nothing happened".
    if (s.sidebarCollapsed) {
      dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: false });
    }
    // Make sure the search view is the active sidebar panel. The
    // input only renders in the Search panel — without this, hitting
    // ⌘O while the Files panel is up would do nothing.
    if (s.activeSidebarView !== 'search') {
      dispatch({ type: 'SIDEBAR_VIEW', view: 'search' });
    }
    // Defer one frame so the un-collapse / view-switch layout commits
    // before we focus + flash. RAF is more reliable than setTimeout(0)
    // here. Also gives SearchPanel's mount effect time to register
    // the new input ref if we just flipped views.
    requestAnimationFrame(() => {
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
      el.classList.remove('flash-focus');
      void el.offsetWidth; // force reflow so animation restarts
      el.classList.add('flash-focus');
    });
  }, []);

  // Async wrapper: every controller may return either a sync MatchInfo
  // or a Promise (HTML preview is postMessage round-trip). Centralised
  // so the FindBar can call sync-looking actions.
  async function applyMatchInfo(p: MatchInfo | Promise<MatchInfo>): Promise<void> {
    const info = await Promise.resolve(p);
    dispatch({ type: 'FIND_SET', patch: { current: info.current, total: info.total } });
  }

  const registerFindController = useCallback((c: FindController | null) => {
    // Replacing the controller (tab/mode switch while the bar is open):
    // tear down the outgoing one so its highlights don't outlive its
    // owning view, then prime the new one with the current query so a
    // file-switch (or a keyword-hit click that pre-armed the bar) ends
    // up showing matches immediately instead of waiting for the user
    // to re-type.
    const prev = findCtlRef.current;
    if (prev && prev !== c) prev.close();
    findCtlRef.current = c;
    if (c) {
      const { query, wholeWord, open } = stateRef.current.find;
      if (open && query) {
        void applyMatchInfo(c.setQuery(query, { wholeWord }));
      }
    }
  }, []);

  const openFind = useCallback(() => {
    dispatch({ type: 'FIND_OPEN' });
  }, []);

  const closeFind = useCallback(() => {
    findCtlRef.current?.close();
    dispatch({ type: 'FIND_CLOSE' });
  }, []);

  const setFindQuery = useCallback((q: string) => {
    dispatch({ type: 'FIND_SET', patch: { query: q } });
    const ctl = findCtlRef.current;
    if (!ctl) {
      dispatch({ type: 'FIND_SET', patch: { current: 0, total: 0 } });
      return;
    }
    void applyMatchInfo(ctl.setQuery(q, { wholeWord: stateRef.current.find.wholeWord }));
  }, []);

  const toggleFindWholeWord = useCallback(() => {
    const next = !stateRef.current.find.wholeWord;
    dispatch({ type: 'FIND_SET', patch: { wholeWord: next } });
    const ctl = findCtlRef.current;
    if (!ctl) return;
    void applyMatchInfo(ctl.setQuery(stateRef.current.find.query, { wholeWord: next }));
  }, []);

  const findNext = useCallback(() => {
    const ctl = findCtlRef.current;
    if (!ctl) return;
    void applyMatchInfo(ctl.next());
  }, []);

  const findPrev = useCallback(() => {
    const ctl = findCtlRef.current;
    if (!ctl) return;
    void applyMatchInfo(ctl.prev());
  }, []);

  const activateTab = useCallback(async (id: string) => {
    const s = stateRef.current;
    if (s.activeTabId === id) return;
    // Snapshot the outgoing tab's scroll into its current nav entry
    // BEFORE flushSave (which may unmount the editor and lose the read
    // path). MD previews give us a number; HTML / PDF return null
    // because the iframe is cross-realm — we accept that those don't
    // round-trip and just don't snapshot.
    const outgoingScrollY = captureCurrentScrollY();
    if (outgoingScrollY != null) {
      dispatch({ type: 'NAV_SNAPSHOT_SCROLL', scrollY: outgoingScrollY });
    }
    if (editorRef.current) await flushSave();
    dispatch({ type: 'ACTIVATE_TAB', id });
    // After activating, arm the incoming tab's pendingScrollY from its
    // current nav entry so the viewer's mount-time effect restores the
    // position. React batches these two dispatches into a single
    // render so the viewer mounts with pendingScrollY already set.
    const incoming = stateRef.current.tabs.find((t) => t.id === id);
    const entry = incoming?.navStack[incoming.navCursor];
    if (entry?.scrollY != null) {
      dispatch({ type: 'PENDING_SCROLL', anchor: entry.anchor ?? null, scrollY: entry.scrollY });
    }
  }, [flushSave]);

  const navigateTo = useCallback(async (name: string, anchor?: string) => {
    const tab = getActiveTab(stateRef.current);
    const cur = tab?.file ?? null;
    if (cur && cur.name === name && anchor) {
      const scrollY = captureCurrentScrollY();
      if (scrollY != null) dispatch({ type: 'NAV_SNAPSHOT_SCROLL', scrollY });
      dispatch({
        type: 'NAV_PUSH',
        entry: { name, anchor },
        currentScrollY: scrollY,
      });
      dispatch({ type: 'PENDING_SCROLL', anchor, scrollY: null });
      return;
    }
    await loadFile(name, { push: true, anchor });
  }, [loadFile]);

  const navBack = useCallback(async () => {
    const tab = getActiveTab(stateRef.current);
    if (!tab || tab.navCursor <= 0) return;
    const target = tab.navStack[tab.navCursor - 1];
    if (!target) return;
    await loadFile(target.name, {
      push: false,
      anchor: target.anchor,
      restoreScrollY: target.scrollY,
      cursor: tab.navCursor - 1,
    });
  }, [loadFile]);

  const navForward = useCallback(async () => {
    const tab = getActiveTab(stateRef.current);
    if (!tab || tab.navCursor < 0 || tab.navCursor >= tab.navStack.length - 1) return;
    const target = tab.navStack[tab.navCursor + 1];
    if (!target) return;
    await loadFile(target.name, {
      push: false,
      anchor: target.anchor,
      restoreScrollY: target.scrollY,
      cursor: tab.navCursor + 1,
    });
  }, [loadFile]);

  const consumePendingScroll = useCallback(() => {
    dispatch({ type: 'PENDING_SCROLL', anchor: null, scrollY: null });
  }, []);

  const consumePendingHighlight = useCallback(() => {
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: null });
  }, []);

  const toggleEditMode = useCallback(async () => {
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file) return;
    if (tab.editMode) {
      await flushSave();
      dispatch({ type: 'EDIT_MODE', on: false });
    } else {
      dispatch({ type: 'EDIT_MODE', on: true });
    }
  }, [flushSave]);

  const registerEditor = useCallback((h: EditorHandle | null) => {
    editorRef.current = h;
  }, []);

  const newNote = useCallback(async (format: 'md' | 'html' = 'md') => {
    await flushSave();
    const dir = stateRef.current.activeFolder;
    try {
      const { name } = await api.createNote('', dir, format);
      if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
      await loadFiles();
      const body = await api.getFile(name);
      dispatch({ type: 'FILE_OPEN', body });
      // Seed the nav stack with this new note so back/forward inside
      // the tab has a starting point.
      dispatch({ type: 'NAV_PUSH', entry: { name }, currentScrollY: null });
      dispatch({ type: 'EDIT_MODE', on: true });
      dispatch({ type: 'RENAMING', renaming: { path: name, kind: 'file' } });
      void refreshIndexState();
    } catch (e: unknown) {
      toast('Failed to create: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, refreshIndexState, showAlert]);

  const newFolder = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const j = await api.createFolder(path);
      dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      dispatch({ type: 'ACTIVE_FOLDER', path: j.path });
      await loadFiles();
    } catch (e: unknown) {
      toast('Failed to create folder: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, showAlert]);

  const deleteFile = useCallback(async (name: string) => {
    // PDFs own a dot-prefixed derived note (`.paper.md`) + image
    // bundle (`.paper_files/`) sitting next to them — say so up front
    // so the user knows the index goes with it. Plain notes just
    // mention "file + index".
    const isPdf = /\.pdf$/i.test(name);
    const prompt = isPdf
      ? `Delete ${name}? This also removes the derived markdown + image bundle and the indexed content.`
      : `Delete ${name}? (removes file + index)`;
    if (!(await askConfirm(prompt))) return;
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (saveTimer.current && activeFile?.name === name) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await api.deleteFile(name);
      // Close every tab that was showing the deleted file.
      const stale = stateRef.current.tabs.filter((t) => t.file?.name === name);
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      await loadFiles();
    } catch (e: unknown) {
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, showAlert, askConfirm]);

  const deleteFolder = useCallback(async (path: string) => {
    if (!path) return;
    if (!(await askConfirm(`Delete folder "${path}" and everything inside?`))) return;
    try {
      await api.deleteFolder(path);
      const stale = stateRef.current.tabs.filter(
        (t) => t.file && t.file.name.startsWith(path + '/'),
      );
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      await loadFiles();
    } catch (e: unknown) {
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, showAlert, askConfirm]);

  const renameFile = useCallback(async (oldName: string, newBaseName: string) => {
    const extMatch = oldName.match(/\.(md|markdown|html|htm)$/i);
    const ext = extMatch ? extMatch[0] : '';
    const lastSlash = oldName.lastIndexOf('/');
    const dir = lastSlash >= 0 ? oldName.slice(0, lastSlash + 1) : '';
    const newName = dir + newBaseName + ext;
    if (newName === oldName) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('file', oldName, newName);
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current)?.file;
    const wasActive = activeFile?.name === oldName;
    if (wasActive) {
      await flushSave();
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Renaming…', cls: '' } });
    }
    try {
      const j = await api.renameFile(oldName, newName, { cascade });
      if (wasActive && activeFile) {
        dispatch({ type: 'FILE_PATCH', patch: { name: j.name } });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      }
      await loadFiles();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast('Rename failed: ' + msg, { level: 'error' });
      if (wasActive) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Rename failed', cls: 'error' } });
      }
    } finally {
      dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, showAlert]);

  const renameFolder = useCallback(async (oldPath: string, newName: string) => {
    if (!newName || newName.includes('/')) {
      toast('Folder name cannot contain "/".', { level: 'warning' });
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const lastSlash = oldPath.lastIndexOf('/');
    const parent = lastSlash >= 0 ? oldPath.slice(0, lastSlash + 1) : '';
    const newPath = parent + newName;
    if (newPath === oldPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('folder', oldPath, newPath);
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    try {
      const j = await api.renameFolder(oldPath, newName, { cascade });
      const s = stateRef.current;
      // Server has rewritten the on-disk path; mirror the expansion
      // across so the renamed folder stays open after `loadFiles`.
      // The orphan oldPath entry in the set is harmless — no folder
      // row matches it, so it just sits inert until the next reset.
      if (s.expanded.has(oldPath)) {
        dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      }
      if (s.activeFolder === oldPath) dispatch({ type: 'ACTIVE_FOLDER', path: j.path });
      const activeFile = getActiveTab(s)?.file;
      if (activeFile && activeFile.name.startsWith(oldPath + '/')) {
        const newFileName = j.path + activeFile.name.slice(oldPath.length);
        dispatch({ type: 'FILE_PATCH', patch: { name: newFileName } });
      }
      await loadFiles();
    } catch (e: unknown) {
      toast('Rename failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, loadFiles, showAlert]);

  const moveFile = useCallback(async (oldPath: string, targetDir: string) => {
    const basename = oldPath.split('/').pop() ?? oldPath;
    const newPath = targetDir ? `${targetDir}/${basename}` : basename;
    if (newPath === oldPath) return;
    const cascade = await askCascadeForRename('file', oldPath, newPath);
    if (cascade === null) return;
    try {
      const j = await api.renameFile(oldPath, newPath, { cascade });
      const cur = getActiveTab(stateRef.current)?.file;
      if (cur?.name === oldPath) dispatch({ type: 'FILE_PATCH', patch: { name: j.name } });
      if (targetDir) dispatch({ type: 'EXPAND_FOLDER', path: targetDir });
      await loadFiles();
    } catch (e: unknown) {
      toast('Move failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [askCascadeForRename, loadFiles, showAlert]);

  const upload = useCallback(async (
    items: { file: File; relPath: string }[],
    dir: string,
  ): Promise<boolean> => {
    if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
    try {
      const j = await api.upload(items, dir);
      await loadFiles();
      // Now the server has fired any PDF conversions and updated its
      // `pendingConversions` set. Poll immediately so the sidebar
      // banner shows even when the conversion is fast enough to
      // finish inside the regular poll window.
      void refreshIndexState();
      const first = j.files?.find(
        (x) => !x.error && /\.(md|markdown|html|htm)$/i.test(x.file),
      );
      if (first) void selectFile(first.file);
      const failed = (j.files || []).filter((x) => x.error);
      if (failed.length) {
        console.warn('[upload] failed:', failed);
        toast(`${failed.length} file(s) failed to import. Check console for details.`, { level: 'error' });
      }
      return failed.length === 0;
    } catch (e: unknown) {
      console.warn('[upload] request failed:', e);
      toast('Upload failed — see console.', { level: 'error' });
      return false;
    }
  }, [loadFiles, refreshIndexState, selectFile, showAlert]);

  const runSync = useCallback(async () => {
    if (stateRef.current.syncRunning) return;
    dispatch({ type: 'SYNC_RUNNING', running: true });
    void refreshIndexState();
    try {
      await api.sync();
      await loadFiles();
    } catch (e: unknown) {
      toast('Sync failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      dispatch({ type: 'SYNC_RUNNING', running: false });
    }
  }, [loadFiles, refreshIndexState, showAlert]);

  // Clear every piece of UI state scoped to the previous space. Shared
  // by finishOpenSpace (switching *in*) and goHome (switching *out*) so
  // the two can't drift. Each action targets a disjoint state slice, so
  // call order doesn't matter. Note the server kills every PTY on a
  // space switch (onSwitch → killActiveTerminal); TERMINAL_TABS_RESET
  // drops our tab list to match so we don't render orphan xterms.
  const resetSpaceScopedState = useCallback(() => {
    dispatch({ type: 'TABS_RESET' });
    dispatch({ type: 'TERMINAL_TABS_RESET' });
    dispatch({ type: 'FILTER', q: '' });
    dispatch({ type: 'SEARCH_CLEAR' });
    dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
  }, []);

  const finishOpenSpace = useCallback(async () => {
    resetSpaceScopedState();
    dispatch({ type: 'COLLAPSE_ALL_FOLDERS' });
    dispatch({ type: 'NAV_RESET' });
    void refreshIndexState();
    // Load files BEFORE hiding the welcome overlay so the sidebar doesn't
    // briefly flash "NOTES" with an empty tree behind the overlay's fade.
    await Promise.all([loadFiles(), loadFileOrder()]);
    dispatch({ type: 'WELCOME_HIDE' });
  }, [loadFiles, loadFileOrder, refreshIndexState, resetSpaceScopedState]);

  // These THROW on failure — callers decide how to surface it. Welcome's
  // fire-and-forget callers (recent pills) `.catch` into WELCOME_ERROR;
  // the New/Open/Import modals and the Sidebar space menu catch in-place
  // to show the error and keep their input. (They used to swallow here,
  // which made every caller's catch dead code and hid in-space failures.)
  const openSpace = useCallback(async (path: string) => {
    await api.openSpace(path);
    await finishOpenSpace();
  }, [finishOpenSpace]);

  const openSpaceByName = useCallback(async (name: string, opts?: { create?: boolean }) => {
    await api.openSpaceByName(name, opts);
    await finishOpenSpace();
  }, [finishOpenSpace]);

  const goHome = useCallback(() => {
    resetSpaceScopedState();
    dispatch({ type: 'FILES_LOADED', files: [], folders: [], space: '' });
    // Show immediately with the in-memory list (snappy), then refresh from
    // the server: a space just created via New / Import won't be in the
    // stale `state.recent` captured at bootstrap, so without this the
    // Welcome pills don't update until an app restart.
    dispatch({ type: 'WELCOME_SHOW', recent: stateRef.current.recent });
    void api.getSpace()
      .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
      .catch(() => { /* keep the in-memory list if the refresh fails */ });
  }, [resetSpaceScopedState]);

  const bootstrap = useCallback(async () => {
    try {
      const j = await api.getSpace();
      dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir });
      const initialSpace = new URLSearchParams(window.location.search).get('space');
      if (initialSpace) {
        window.history.replaceState(null, '', window.location.pathname);
        await openSpaceByName(initialSpace);
      }
    } catch {
      dispatch({ type: 'WELCOME_SHOW', recent: [], error: 'Server unreachable' });
    }
  }, [openSpaceByName]);

  const dismissSnapshotWarning = useCallback(async () => {
    // Optimistic: blank the banner locally so the click feels instant;
    // server call confirms. If it fails the next poll restores the
    // warning (recordSnapshotWarning is still set server-side) so we
    // don't need to roll back here.
    dispatch({ type: 'SNAPSHOT_WARNING', warning: null });
    try { await api.dismissSnapshotWarning(); }
    catch (err) {
      console.warn('[snapshot-warning] dismiss failed:', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const actions = useMemo<AppActions>(() => ({
    bootstrap, openSpace, openSpaceByName, goHome,
    loadFiles, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissSnapshotWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, openKbOverview, openKbRules, openSpaceRules, closeTab, closeActiveTab, activateTab,
    navigateTo, navBack, navForward, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    alert: showAlert, confirm: askConfirm, resolveModal,
    toast, dismissToast,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindWholeWord, findNext, findPrev,
  }), [
    bootstrap, openSpace, openSpaceByName, goHome,
    loadFiles, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissSnapshotWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, openKbOverview, openKbRules, openSpaceRules, closeTab, closeActiveTab, activateTab,
    navigateTo, navBack, navForward, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    showAlert, askConfirm, resolveModal, toast, dismissToast,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindWholeWord, findNext, findPrev,
  ]);

  // Bootstrap + start polling on first mount.
  useEffect(() => {
    void actions.bootstrap();
    void actions.refreshIndexState();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort flush before unload. `sendBeacon` keeps the PUT alive
  // past page teardown.
  useEffect(() => {
    function onUnload() {
      const cur = getActiveTab(stateRef.current)?.file ?? null;
      const h = editorRef.current;
      if (saveTimer.current && cur && h) {
        clearTimeout(saveTimer.current);
        try {
          navigator.sendBeacon?.(
            '/api/files/' + encodeURIComponent(cur.name),
            new Blob([JSON.stringify({ content: h.getValue() })], { type: 'application/json' }),
          );
        } catch { /* swallow */ }
      }
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const value = useMemo(() => ({ state, actions, dispatch }), [state, actions]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  // Derive the active tab once per render so consumers don't repeat the
  // lookup. `null` when there are no tabs (initial / after closing the
  // last tab) — components that depended on the old `state.current`
  // should now read `activeTab?.file`.
  const activeTab = ctx.state.activeTabId
    ? ctx.state.tabs.find((t) => t.id === ctx.state.activeTabId) ?? null
    : null;
  return { ...ctx, activeTab };
}
