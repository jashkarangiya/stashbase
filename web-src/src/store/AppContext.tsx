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
  encodePath,
  errorMessage,
  getWindowId,
} from '../api';
import {
  getActiveTab,
  initialState,
  optimisticKeyBackfillPaths,
  renamedFilePath,
  reducer,
  type Action,
  type CascadeDecision,
  type CascadePrompt,
  type PendingHighlight,
  type State,
} from './state';
import {
  filterGuiSemanticHits,
  isFolderFileTab,
  keywordFindCaseSensitive,
  pickLandingFile,
  shallowEqualConversionFailures,
  shallowEqualConversionProgress,
  shallowEqualIndexWarning,
  waitForNextFrame,
} from './appContextHelpers';

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

const SEMANTIC_SEARCH_CANDIDATES = 30;

/** Per-view find driver. Whichever view is currently rendered (CM
 *  editor, MD preview iframe, HTML preview iframe) registers one of
 *  these on mount so the global FindBar can drive search without
 *  knowing which surface is underneath. All methods may return a
 *  Promise — the HTML preview path is async because it round-trips
 *  through postMessage to the sandboxed iframe. */
export interface MatchInfo { current: number; total: number; }
export interface FindOptions { wholeWord: boolean; caseSensitive: boolean; }
export interface FindController {
  setQuery: (query: string, opts: FindOptions) => MatchInfo | Promise<MatchInfo>;
  next: () => MatchInfo | Promise<MatchInfo>;
  prev: () => MatchInfo | Promise<MatchInfo>;
  /** Tear down highlights / decorations. Called when the bar closes
   *  or when this controller is replaced by a tab/mode switch. */
  close: () => void;
}

export interface AppActions {
  bootstrap: () => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  /** Open/create a folder by name under the default folder home — a
   *  single path segment. `openFolder(path)` opens any folder in place. */
  openFolderByName: (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticStashingOnOpen?: boolean },
  ) => Promise<void>;
  goHome: () => Promise<boolean>;

  loadFiles: (expectedFolderPath?: string) => Promise<State['files']>;
  /** Optimistically mark the current visible files as stashing. Used
   *  after the first embedder key is added and immediately after a
   *  folder import opens the new folder, before daemon status can catch
   *  up. */
  markVisibleFilesStashing: (files?: State['files']) => Promise<void>;
  refreshIndexState: () => Promise<void>;
  runSync: () => Promise<void>;
  /** Run a search. Pass `mode` to force a specific routing — useful
   *  when the caller has just dispatched `SEARCH_MODE` and can't rely
   *  on `stateRef` reflecting that yet (it updates after commit, not
   *  in-line with the dispatch). Default reads from state. */
  runSearch: (
    query: string,
    mode?: 'semantic' | 'keyword',
    opts?: { caseStrict?: boolean; wholeWord?: boolean },
  ) => Promise<void>;
  /** Clear the active folder's background-index warning. */
  dismissIndexWarning: () => Promise<void>;
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
  closeTab: (id: string) => Promise<void>;
  /** Close whichever tab is currently active. Convenience for keyboard
   *  shortcuts (`⌘W`) and UI buttons that don't have a tab id handy. */
  closeActiveTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  /** Cross-file link nav: open `name` (with optional anchor) and push a
   *  new entry into the back/forward stack. Used by preview iframes
   *  forwarding `<a>` clicks. */
  navigateTo: (name: string, anchor?: string) => Promise<void>;
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
   *  (persistent — error toasts only go away when the user dismisses them). */
  toast: (
    message: string,
    opts?: {
      level?: 'info' | 'success' | 'warning' | 'error';
      ttl?: number | null;
      action?: { label: string; onClick: () => void };
    },
  ) => string;
  dismissToast: (id: string) => void;
  /** Clear all toasts at once — backs the "Clear all" control that
   *  appears when the stack has more than one toast (persistent error
   *  toasts otherwise have to be dismissed one by one). */
  clearToasts: () => void;
  toggleEditMode: () => Promise<void>;

  newNote: () => Promise<void>;
  newFolder: (path: string) => Promise<void>;
  deleteFile: (name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  renameFile: (oldName: string, newBaseName: string) => Promise<void>;
  renameFolder: (oldPath: string, newName: string) => Promise<void>;
  moveFile: (oldPath: string, targetDir: string) => Promise<boolean>;
  upload: (items: { file: File; relPath: string }[], dir: string) => Promise<boolean>;

  scheduleSave: () => void;
  flushSave: () => Promise<boolean>;

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
   *  highlighted. Also called implicitly on folder switch / tab close. */
  closeFind: () => void;
  setFindQuery: (q: string) => void;
  toggleFindCaseSensitive: () => void;
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

function isAbsoluteFolderRef(value: string): boolean {
  return value.startsWith('/');
}

export function AppProvider({ children }: { children: ReactNode }) {
  // Sidebar view (Files / Search) is deliberately NOT persisted: every
  // launch lands on Files. The file tree is the canonical landing spot;
  // Search is a task you actively enter, not a state worth restoring.
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
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
  // Same idea for manual sync: switching folders cancels the renderer
  // ownership of the old sync so its `finally` can't clear a newer
  // folder's spinner.
  const syncGen = useRef(0);
  // Opening folders is multi-step (server bind → files/order load →
  // landing file). A newer open/home action invalidates older finishers.
  const openGen = useRef(0);
  // Last `treeVersion` we saw from `/api/index-status`. Any bump means
  // the watcher detected a disk change since last poll → refetch files.
  const lastTreeVersion = useRef<number>(-1);
  /** Optimistically-stashing imports awaiting server confirmation:
   *  folder-relative path → grace deadline (ms). On import we mark a
   *  convertible file stashing immediately, but the server only
   *  registers the conversion *after* responding, so an index poll that
   *  lands in that gap would otherwise report it absent and wipe the
   *  mark. `refreshIndexState` keeps these in `pendingConversions` until
   *  the server starts reporting them (hand-off) or the grace expires. */
  const importStashingGrace = useRef<Map<string, number>>(new Map());
  /** Same idea for indexed (md/html) imports, which never enter
   *  `pendingConversions`. The daemon serialises `status` behind the very
   *  embeds it would report (`indexer.mfs.ts` status note), so a bare
   *  poll right after a drop under-counts and lags — a 4-file drop can
   *  read "3 stashing" because one embed finished while `status` waited
   *  in line. We optimistically mark every imported note as pending and
   *  keep it until the UI-visible pending set settles (the batch is done)
   *  or the grace expires. Unlike conversions we do NOT hand off per-file
   *  — mid-embed `pending` is unreliable, so the server sends a dedicated
   *  `visibleIndexingSettled` signal for this renderer-only state. */
  const importIndexGrace = useRef<Map<string, number>>(new Map());
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
  const clearToasts = useCallback(() => {
    dispatch({ type: 'TOAST_CLEAR' });
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

  const loadFilesFromServer = useCallback(async (expectedFolderPath?: string) => {
    const j = await api.listFiles();
    const files = j.files ?? [];
    if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return null;
    dispatch({
      type: 'FILES_LOADED',
      files,
      folders: j.folders ?? [],
      folder: j.folder ?? 'notes',
    });
    return files;
  }, []);

  const loadFiles = useCallback(async (expectedFolderPath?: string) => {
    try {
      return (await loadFilesFromServer(expectedFolderPath)) ?? [];
    } catch (err: unknown) {
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return [];
      const fallbackFolder = err instanceof ApiError && err.status === 412
        ? ''
        : stateRef.current.folder;
      dispatch({
        type: 'FILES_LOADED',
        files: [],
        folders: [],
        folder: fallbackFolder,
        folderPath: fallbackFolder ? stateRef.current.folderPath : '',
      });
      return [];
    }
  }, [loadFilesFromServer]);

  const markVisibleFilesStashing = useCallback(async (files?: State['files']) => {
    const folderPath = stateRef.current.folderPath;
    const source = files ?? (stateRef.current.files.length ? stateRef.current.files : folderPath ? await loadFiles(folderPath) : []);
    if (stateRef.current.folderPath !== folderPath) return;
    const paths = optimisticKeyBackfillPaths(source);
    if (paths.length === 0) return;
    const merged = new Set(stateRef.current.pendingNames);
    for (const path of paths) merged.add(path);
    dispatch({ type: 'PENDING_NAMES', names: merged });
  }, [loadFiles]);

  /** Fetch the per-folder manual ordering map. Called alongside
   *  `loadFiles` on folder switch and on bootstrap. Errors are
   *  swallowed — the tree falls back to default sort. */
  const loadFileOrder = useCallback(async (expectedFolderPath?: string) => {
    try {
      const order = await api.getFileOrder();
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return;
      dispatch({ type: 'FILE_ORDER_LOADED', order });
    } catch {
      if (expectedFolderPath !== undefined && stateRef.current.folderPath !== expectedFolderPath) return;
      dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
    }
  }, []);

  const setFolderOrder = useCallback(async (parentPath: string, names: string[]) => {
    // Optimistic — render the new order now, persist behind it.
    dispatch({ type: 'FILE_ORDER_SET', parentPath, names });
    try {
      await api.putFileOrder(parentPath, names);
    } catch (err) {
      console.warn('[file-order] PUT failed; will resync on next folder load', err);
    }
  }, []);

  /** Re-fetch the active tab's body from disk and patch the open file
   *  if it changed. Used after the watcher detects an external edit
   *  (typically: Claude Code wrote to the file via its `Edit` tool from
   *  the panel). No-op when nothing's open, when the active tab is in
   *  edit mode (would clobber the unsaved buffer), or when disk + tab
   *  agree. `force` is only for an explicit user reload after a save
   *  conflict; it discards the editor buffer and reopens the tab from
   *  disk. Failures are swallowed — the sidebar reload that runs in
   *  the same poll cycle covers the "file got deleted externally" case. */
  const refreshActiveTabFromDisk = useCallback(async (opts: { force?: boolean } = {}) => {
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file) return;
    if (tab.editMode && !opts.force) return;
    const folderPathAtStart = stateRef.current.folderPath;
    const name = tab.file.name;
    try {
      const body = await api.getFile(name);
      // The active tab may have been swapped (or the file renamed) in
      // the time it took to fetch — re-check before patching.
      if (stateRef.current.folderPath !== folderPathAtStart) return;
      const latestActive = getActiveTab(stateRef.current);
      const latestFile = latestActive?.file;
      if (!latestFile || latestFile.name !== name) return;
      if (opts.force) {
        dispatch({
          type: 'FILE_OPEN',
          body: {
            name,
            format: latestFile.format,
            content: body.content,
            version: 'version' in body ? body.version : undefined,
          },
        });
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
        return;
      }
      if (latestActive?.editMode) return;
      if (body.content === latestFile.content) return;
      dispatch({
        type: 'FILE_PATCH',
        patch: { content: body.content, ...('version' in body ? { version: body.version } : {}) },
      });
    } catch {
      /* swallow — sidebar will reflect a delete on the next poll */
    }
  }, []);

  const refreshIndexState = useCallback(async () => {
    let nextDelay = POLL_IDLE_MS;
    const scheduleNextPoll = (delay: number) => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = setTimeout(() => { void refreshIndexState(); }, delay);
    };
    const folderPathAtStart = stateRef.current.folderPath;
    const openGenAtStart = openGen.current;
    try {
      const s = await api.indexStatus(folderPathAtStart || undefined);
      if (stateRef.current.folderPath !== folderPathAtStart) {
        scheduleNextPoll(nextDelay);
        return;
      }
      const indexReady = s.indexReady !== false;
      const newPending = indexReady ? new Set(s.pending ?? []) : new Set<string>();
      const visibleIndexingSettled =
        stateRef.current.embedderHasKey === false
        || (indexReady && (s.visibleIndexingSettled ?? newPending.size === 0));
      let newConv = s.pendingConversions ?? [];
      // Fold in optimistically-marked imports the server hasn't started
      // reporting yet (it registers the conversion only after responding
      // to the upload). Hand off once the server tracks a path; expire
      // the grace otherwise so a never-converted file doesn't stick.
      if (importStashingGrace.current.size > 0) {
        const now = Date.now();
        const stillGracing: string[] = [];
        for (const [name, deadline] of importStashingGrace.current) {
          if (newConv.includes(name)) {
            importStashingGrace.current.delete(name); // server owns it now
          } else if (now <= deadline) {
            stillGracing.push(name);
          } else {
            importStashingGrace.current.delete(name); // grace expired
          }
        }
        if (stillGracing.length) {
          newConv = [...new Set([...newConv, ...stillGracing])].sort();
        }
      }
      // Same fold for optimistically-marked note imports — but keyed on
      // the renderer-facing visibleIndexingSettled signal, not raw daemon
      // upToDate. The daemon serialises `status` behind in-flight embeds,
      // so a fresh drop's files flicker in and out of `pending`
      // unreliably. Hold every graced import in `newPending` until the
      // UI-visible pending set settles (batch done) or the grace expires.
      if (importIndexGrace.current.size > 0) {
        const now = Date.now();
        for (const [name, deadline] of importIndexGrace.current) {
          if (visibleIndexingSettled) {
            importIndexGrace.current.delete(name); // batch fully indexed
          } else if (now <= deadline) {
            newPending.add(name);
          } else {
            importIndexGrace.current.delete(name); // grace expired
          }
        }
      }
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
      const incomingProgress = s.conversionProgress ?? {};
      if (!shallowEqualConversionProgress(prev.conversionProgress, incomingProgress)) {
        dispatch({ type: 'CONVERSION_PROGRESS', progress: incomingProgress });
      }
      const incomingIndexWarning = s.indexWarning ?? null;
      if (!shallowEqualIndexWarning(prev.indexWarning, incomingIndexWarning)) {
        dispatch({ type: 'INDEX_WARNING', warning: incomingIndexWarning });
      }
      const incomingFailures = s.conversionFailures ?? [];
      if (!shallowEqualConversionFailures(prev.conversionFailures, incomingFailures)) {
        dispatch({ type: 'CONVERSION_FAILURES', failures: incomingFailures });
      }
      if (pendingChanged || convChanged || treeChanged) {
        if (treeChanged) {
              const expectedFolderPath = prev.folderPath;
              void loadFilesFromServer(expectedFolderPath)
            .then((files) => {
              if (!files) return;
              dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
            })
            .catch((err) => {
              console.warn('[files] refresh after tree change failed:', err);
            });
        } else {
          void loadFiles();
        }
      }
      // Tree changed = someone else wrote to disk (Claude Code in the
      // chat panel is the common case). Re-read the active tab's
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
      const busy = !indexReady || !visibleIndexingSettled || newConv.length > 0;
      nextDelay = busy ? POLL_PENDING_MS : POLL_IDLE_MS;
    } catch (err) {
      if (stateRef.current.folderPath !== folderPathAtStart) {
        scheduleNextPoll(nextDelay);
        return;
      }
      if (err instanceof ApiError && err.status === 412) {
        if (folderPathAtStart && openGenAtStart === openGen.current) {
          try {
            // Server restart / dev tsx reload drops the in-memory
            // window → folder binding while the renderer still has the
            // right folder and possibly an unsaved editor buffer. Rebind
            // first; only fall back to Welcome if the folder is truly gone.
            const opened = await api.openFolder(folderPathAtStart);
            if (
              stateRef.current.folderPath === folderPathAtStart
              && opened.current?.path
            ) {
              lastTreeVersion.current = -1;
              dispatch({
                type: 'FOLDER_CONTEXT',
                folder: opened.current.name,
                folderPath: opened.current.path,
              });
              void loadFilesFromServer(folderPathAtStart);
              scheduleNextPoll(POLL_PENDING_MS);
              return;
            }
          } catch {
            // Folder was deleted/renamed, or the server is still not ready.
            // Drop through to the hard reset below.
          }
        }
        // No folder open (e.g. just went home). Clear every folder-scoped
        // indicator so a stale banner from the previous folder doesn't
        // bleed into the welcome / next-folder view.
        syncGen.current += 1;
        openGen.current += 1;
        dispatch({ type: 'PENDING_NAMES', names: new Set() });
        dispatch({ type: 'PENDING_CONVERSIONS', paths: [] });
        dispatch({ type: 'CONVERSION_PROGRESS', progress: {} });
        dispatch({ type: 'INDEX_WARNING', warning: null });
        dispatch({ type: 'CONVERSION_FAILURES', failures: [] });
        dispatch({ type: 'SYNC_RUNNING', running: false });
        lastTreeVersion.current = -1;
        if (stateRef.current.folderPath) {
          // Another window may have deleted/closed the folder. The server
          // has already cleared this window's current-folder context; make
          // the renderer match instead of leaving a stale tree open.
          dispatch({ type: 'TABS_RESET' });
          dispatch({ type: 'CHAT_TABS_RESET' });
          dispatch({ type: 'FILTER', q: '' });
          dispatch({ type: 'SEARCH_CLEAR' });
          dispatch({ type: 'ACTIVE_FOLDER', path: '' });
          dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
          dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
          dispatch({ type: 'WELCOME_SHOW', recent: [] });
          void api.getFolder()
            .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
            .catch(() => { /* welcome can stay empty until bootstrap/focus */ });
        }
      }
    }
    scheduleNextPoll(nextDelay);
  }, [loadFiles, loadFilesFromServer, refreshActiveTabFromDisk]);

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
  const runSearch = useCallback(async (
    query: string,
    modeOverride?: 'semantic' | 'keyword',
    opts?: { caseStrict?: boolean; wholeWord?: boolean },
  ) => {
    const myGen = ++searchGen.current;
    const q = query.trim();
    if (!q) {
      dispatch({ type: 'SEARCH_CLEAR' });
      return;
    }
    const mode = modeOverride ?? stateRef.current.searchMode;
    const folderPathAtStart = stateRef.current.folderPath;
    const isStaleSearch = () => (
      myGen !== searchGen.current ||
      stateRef.current.folderPath !== folderPathAtStart ||
      stateRef.current.filterQuery.trim() !== q
    );
    dispatch({ type: 'SEARCH_START' });
    try {
      if (mode === 'keyword') {
        // Pull case-strict / whole-word / current folder straight from
        // state. The `folder` field is the active folder of THIS window;
        // passing it explicitly avoids the server falling back to the
        // process-wide `currentFolder` singleton, which would pick the
        // wrong folder in multi-window sessions.
        const s = stateRef.current;
        const result = await api.keywordSearch(q, {
          caseStrict: opts?.caseStrict ?? s.caseStrict,
          wholeWord: opts?.wholeWord ?? s.wholeWord,
          folder: folderPathAtStart || undefined,
        });
        if (isStaleSearch()) return;
        dispatch({ type: 'SEARCH_KEYWORD', result });
      } else {
        const embedder = await api.getEmbedder();
        if (isStaleSearch()) return;
        dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: embedder.hasKey });
        if (!embedder.hasKey) {
          dispatch({
            type: 'SEARCH_ERROR',
            error: 'Semantic search is disabled until you add an OpenAI API key. Switch to keyword search to search without embeddings.',
          });
          return;
        }
        const { hits } = await api.search(q, SEMANTIC_SEARCH_CANDIDATES, {
          folder: folderPathAtStart || undefined,
        });
        if (isStaleSearch()) return;
        dispatch({ type: 'SEARCH_HITS', hits: filterGuiSemanticHits(hits) });
      }
    } catch (err) {
      if (isStaleSearch()) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[search:${mode}] failed:`, msg);
      // 412 = no folder open: just clear (there's nothing to search), no
      // error banner. Any other failure is a real error — surface it as
      // such instead of a misleading empty "No matches".
      if (err instanceof ApiError && err.status === 412) {
        dispatch({ type: 'SEARCH_CLEAR' });
      } else {
        dispatch({ type: 'SEARCH_ERROR', error: msg });
      }
    }
  }, []);

  const flushSave = useCallback(async () => {
    const inFlight = saveInFlight.current;
    if (inFlight) {
      const ok = await inFlight;
      if (!ok) return false;
    }

    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const run = (async () => {
      const tabAtStart = getActiveTab(stateRef.current);
      const cur = tabAtStart?.file ?? null;
      const tabId = tabAtStart?.id ?? null;
      const handle = editorRef.current;
      if (!cur || !handle) return true;
      const content = handle.getValue();
      if (content === cur.content) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        return true;
      }
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Saving…', cls: '' } });
      const saveContent = async (baseVersion?: string) => {
        const result = await api.putFile(cur.name, content, baseVersion);
        if (result.indexWarning) toast(result.indexWarning, { level: 'warning' });
        return { version: result.version };
      };
      try {
        let savedVersion: string | undefined;
        try {
          savedVersion = (await saveContent(cur.version)).version;
        } catch (err: unknown) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          const latestTab = getActiveTab(stateRef.current);
          const sameTab =
            latestTab?.id === tabId &&
            latestTab.file?.name === cur.name;
          const liveValue = editorRef.current?.getValue();
          if (!sameTab || liveValue !== content) return false;
          savedVersion = (await saveContent(undefined)).version;
          toast('Saved over a newer disk copy from sync.', { level: 'info' });
        }
        const latestTab = getActiveTab(stateRef.current);
        const sameTab =
          latestTab?.id === tabId &&
          latestTab.file?.name === cur.name;
        if (!sameTab) return true;

        const liveValue = editorRef.current?.getValue();
        dispatch({ type: 'FILE_PATCH', patch: { content, version: savedVersion } });
        if (liveValue === content) {
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
        } else {
          dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
          if (!saveTimer.current) {
            saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
          }
        }
        void loadFiles();
        return true;
      } catch (e: unknown) {
        const latestTab = getActiveTab(stateRef.current);
        const sameTab =
          latestTab?.id === tabId &&
          latestTab.file?.name === cur.name;
        if (!sameTab) return false;
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Save failed: ' + msg, cls: 'error' } });
        return false;
      }
    })();

    saveInFlight.current = run;
    try {
      return await run;
    } finally {
      if (saveInFlight.current === run) saveInFlight.current = null;
    }
  }, [loadFiles, toast]);

  const scheduleSave = useCallback(() => {
    dispatch({ type: 'SAVE_STATUS', status: { text: 'Unsaved', cls: '' } });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  /** Shared file-load. With `newTab=true` (double-click / `+` then click)
   *  the file lands in a freshly-created tab rather than replacing the
   *  active tab's file. `preview` is forwarded to the FILE_OPEN action —
   *  see its docstring in `state.ts` for the create-vs-replace semantics.
   *  `anchor` is a heading id to scroll to after load (cross-file links /
   *  search hits). */
  const loadFile = useCallback(async (
    name: string,
    opts: {
      newTab?: boolean;
      preview?: boolean;
      anchor?: string;
      expectedFolder?: string;
    },
  ) => {
    if (opts.expectedFolder && stateRef.current.folderPath !== opts.expectedFolder) return;
    const cur = getActiveTab(stateRef.current)?.file ?? null;
    if (editorRef.current && cur && cur.name !== name && !opts.newTab) {
      if (!(await flushSave())) return;
    }
    if (opts.expectedFolder && stateRef.current.folderPath !== opts.expectedFolder) return;
    let body;
    if (/\.pdf$/i.test(name)) {
      // PDFs aren't loaded as text — PdfPreview pulls the binary from
      // `/asset/*` directly. We synthesize a FileBody so the rest of
      // the tab / nav / save-status machinery treats it like any
      // other open file.
      try {
        await api.statFile(name);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'SAVE_STATUS', status: { text: msg, cls: 'error' } });
        return;
      }
      body = { name, format: 'pdf' as const, content: '' };
    } else if (/\.(png|jpe?g|webp)$/i.test(name)) {
      // Images, same story as PDFs — ImagePreview loads the binary from
      // `/asset/*`. The searchable text lives in the hidden `.<stem>.md`
      // OCR note, never opened directly.
      try {
        await api.statFile(name);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'SAVE_STATUS', status: { text: msg, cls: 'error' } });
        return;
      }
      body = { name, format: 'image' as const, content: '' };
    } else {
      try {
        body = await api.getFile(name);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'SAVE_STATUS', status: { text: msg, cls: 'error' } });
        return;
      }
    }
    if (opts.expectedFolder && stateRef.current.folderPath !== opts.expectedFolder) return;
    // "Implicit new tab" — first open in a fresh session (no active tab
    // yet) goes through the new-tab path too.
    const noActiveTab = stateRef.current.activeTabId == null || !getActiveTab(stateRef.current);
    const newTabMode = !!opts.newTab || noActiveTab;
    dispatch({
      type: 'FILE_OPEN',
      body,
      newTab: newTabMode ? !noActiveTab : undefined,
      preview: opts.preview,
    });
    dispatch({ type: 'PENDING_SCROLL', anchor: opts.anchor ?? null });
  }, [flushSave]);

  /** Single-click in the sidebar = open as PREVIEW. VS Code semantics:
   *    1. File already in any tab → activate it, keep its preview/
   *       pinned status unchanged.
   *    2. Active tab is blank (no file) → reuse it as preview.
   *    3. Some other tab is already a preview → activate + replace its
   *       content (the previewed file gets "kicked out" — by design).
   *    4. Otherwise → create a fresh preview tab. */
  const selectFile = useCallback(async (name: string) => {
    const expectedFolder = stateRef.current.folderPath;
    // Flush any pending edit FIRST, then read state — so the tab
    // decisions below act on the post-flush snapshot, not one a
    // concurrent poll / loadFiles could invalidate across the await.
    if (editorRef.current && !(await flushSave())) return;
    if (stateRef.current.folderPath !== expectedFolder) return;
    const s = stateRef.current;
    const existing = s.tabs.find((t) => isFolderFileTab(t, name));
    if (existing) {
      if (s.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      return;
    }
    const active = getActiveTab(s);
    if (active && !active.file) {
      await loadFile(name, { preview: true, expectedFolder });
      return;
    }
    const previewTab = s.tabs.find((t) => t.preview);
    if (previewTab) {
      if (s.activeTabId !== previewTab.id) dispatch({ type: 'ACTIVATE_TAB', id: previewTab.id });
      // FILE_OPEN with no `preview` field preserves the tab's existing
      // preview=true status, so the slot stays the "preview slot".
      await loadFile(name, { expectedFolder });
      return;
    }
    await loadFile(name, { newTab: true, preview: true, expectedFolder });
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
    const expectedFolder = stateRef.current.folderPath;
    await selectFile(name);
    if (stateRef.current.folderPath !== expectedFolder) return;
    for (let i = 0; i < 8; i++) {
      if (getActiveTab(stateRef.current)?.file?.name === name) break;
      await waitForNextFrame();
      if (stateRef.current.folderPath !== expectedFolder) return;
    }
    if (getActiveTab(stateRef.current)?.file?.name !== name) return;
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: hit });
    // Keyword-search hits carry `openFindBar: true` so the user can
    // walk every in-file match with Cmd+G. Setting `find.{open, query}`
    // BEFORE the viewer mounts means `registerFindController` sees the
    // pending query and primes the new controller immediately —
    // matches show up without the user re-typing.
    if (hit.openFindBar && hit.chunkText) {
      const s = stateRef.current;
      dispatch({
        type: 'FIND_SET',
        patch: {
          query: hit.chunkText,
          wholeWord: s.wholeWord,
          caseSensitive: keywordFindCaseSensitive(hit.chunkText, s.caseStrict),
        },
      });
      dispatch({ type: 'FIND_OPEN' });
    }
  }, [selectFile]);

  /** Double-click in the sidebar = open PINNED. VS Code semantics:
   *    1. File already open → activate, AND promote it if it was
   *       living in the preview slot (so it stops being kickable).
   *    2. Otherwise → fresh pinned tab. */
  const openInNewTab = useCallback(async (name: string, expectedFolder?: string) => {
    const targetFolder = expectedFolder ?? stateRef.current.folderPath;
    if (targetFolder && stateRef.current.folderPath !== targetFolder) return;
    if (editorRef.current && !(await flushSave())) return;
    if (targetFolder && stateRef.current.folderPath !== targetFolder) return;
    const s = stateRef.current;
    const existing = s.tabs.find((t) => isFolderFileTab(t, name));
    if (existing) {
      if (s.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (existing.preview) dispatch({ type: 'PROMOTE_TAB', id: existing.id });
      return;
    }
    await loadFile(name, { newTab: true, expectedFolder: targetFolder });
  }, [flushSave, loadFile]);

  const newTab = useCallback(async () => {
    if (editorRef.current && !(await flushSave())) return;
    dispatch({ type: 'NEW_TAB' });
  }, [flushSave]);

  const closeTab = useCallback(async (id: string) => {
    const s = stateRef.current;
    if (s.activeTabId === id && editorRef.current && !(await flushSave())) return;
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
      const { query, wholeWord, caseSensitive, open } = stateRef.current.find;
      if (open && query) {
        void applyMatchInfo(c.setQuery(query, { wholeWord, caseSensitive }));
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
    const { wholeWord, caseSensitive } = stateRef.current.find;
    void applyMatchInfo(ctl.setQuery(q, { wholeWord, caseSensitive }));
  }, []);

  const toggleFindCaseSensitive = useCallback(() => {
    const next = !stateRef.current.find.caseSensitive;
    dispatch({ type: 'FIND_SET', patch: { caseSensitive: next } });
    const ctl = findCtlRef.current;
    if (!ctl) return;
    const { query, wholeWord } = stateRef.current.find;
    void applyMatchInfo(ctl.setQuery(query, { wholeWord, caseSensitive: next }));
  }, []);

  const toggleFindWholeWord = useCallback(() => {
    const next = !stateRef.current.find.wholeWord;
    dispatch({ type: 'FIND_SET', patch: { wholeWord: next } });
    const ctl = findCtlRef.current;
    if (!ctl) return;
    const { query, caseSensitive } = stateRef.current.find;
    void applyMatchInfo(ctl.setQuery(query, { wholeWord: next, caseSensitive }));
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
    if (editorRef.current && !(await flushSave())) return;
    dispatch({ type: 'ACTIVATE_TAB', id });
  }, [flushSave]);

  /** Follow a link clicked inside a preview. Same-file `#anchor` jumps
   *  scroll in place; a link to a DIFFERENT file opens in a new tab
   *  (activating it if already open) so following a source link never
   *  replaces what you're reading. */
  const navigateTo = useCallback(async (name: string, anchor?: string) => {
    const expectedFolder = stateRef.current.folderPath;
    const cur = getActiveTab(stateRef.current)?.file ?? null;
    if (cur && cur.name === name) {
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    if (editorRef.current && !(await flushSave())) return;
    if (stateRef.current.folderPath !== expectedFolder) return;
    const existing = stateRef.current.tabs.find((t) => isFolderFileTab(t, name));
    if (existing) {
      if (stateRef.current.activeTabId !== existing.id) dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      if (existing.preview) dispatch({ type: 'PROMOTE_TAB', id: existing.id });
      if (anchor) dispatch({ type: 'PENDING_SCROLL', anchor });
      return;
    }
    await loadFile(name, { newTab: true, anchor, expectedFolder });
  }, [flushSave, loadFile]);

  const consumePendingScroll = useCallback(() => {
    dispatch({ type: 'PENDING_SCROLL', anchor: null });
  }, []);

  const consumePendingHighlight = useCallback(() => {
    dispatch({ type: 'PENDING_HIGHLIGHT', highlight: null });
  }, []);

  const toggleEditMode = useCallback(async () => {
    const tab = getActiveTab(stateRef.current);
    if (!tab?.file) return;
    if (tab.editMode) {
      if (!(await flushSave())) return;
      dispatch({ type: 'EDIT_MODE', on: false });
    } else {
      dispatch({ type: 'EDIT_MODE', on: true });
    }
  }, [flushSave]);

  const registerEditor = useCallback((h: EditorHandle | null) => {
    editorRef.current = h;
  }, []);

  const newNote = useCallback(async () => {
    if (!(await flushSave())) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const dir = stateRef.current.activeFolder;
    try {
      const created = await api.createNote('', dir);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const { name } = created;
      if (created.indexWarning) toast(created.indexWarning, { level: 'warning' });
      if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
      await loadFiles(targetFolderPath);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const body = await api.getFile(name);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'FILE_OPEN', body });
      dispatch({ type: 'EDIT_MODE', on: true });
      dispatch({ type: 'RENAMING', renaming: { path: name, kind: 'file' } });
      void refreshIndexState();
    } catch (e: unknown) {
      toast('Failed to create: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, refreshIndexState, toast]);

  const newFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    try {
      const j = await api.createFolder(path);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      dispatch({ type: 'ACTIVE_FOLDER', path: j.path });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      toast('Failed to create folder: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [loadFiles, toast]);

  const deleteFile = useCallback(async (name: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    // PDFs own a dot-prefixed derived note (`.paper.md`) + image
    // bundle (`.paper_files/`) sitting next to them — say so up front
    // so the user knows the index goes with it. Plain notes just
    // mention "file + index".
    const isPdf = /\.pdf$/i.test(name);
    const prompt = isPdf
      ? `Delete ${name}? This also removes the derived markdown + image bundle and the indexed content.`
      : `Delete ${name}? (removes file + index)`;
    if (!(await askConfirm(prompt))) return;
    if (stateRef.current.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile?.name === name) {
      if (!(await flushSave())) return;
      if (stateRef.current.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFile(name);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name === name) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current;
      const stale = before.tabs.filter((t) => isFolderFileTab(t, name));
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      importStashingGrace.current.delete(name);
      importIndexGrace.current.delete(name);
      dispatch({ type: 'PENDING_NAMES', names: new Set([...before.pendingNames].filter((p) => p !== name)) });
      dispatch({ type: 'PENDING_CONVERSIONS', paths: before.pendingConversions.filter((p) => p !== name) });
      const { [name]: _deletedProgress, ...remainingProgress } = before.conversionProgress;
      dispatch({ type: 'CONVERSION_PROGRESS', progress: remainingProgress });
      dispatch({
        type: 'FILES_LOADED',
        files: before.files.filter((f) => f.name !== name),
        folders: before.folders,
        folder: before.folder,
      });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        const files = await loadFiles(targetFolderPath);
        if (stateRef.current.folderPath !== targetFolderPath) return;
        dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const deleteFolder = useCallback(async (path: string) => {
    if (!path) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    if (!(await askConfirm(`Delete folder "${path}" and everything inside?`))) return;
    if (stateRef.current.folderPath !== targetFolderPath) return;
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile?.name.startsWith(path + '/')) {
      if (!(await flushSave())) return;
      if (stateRef.current.folderPath !== targetFolderPath) return;
    }
    try {
      await api.deleteFolder(path);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (saveTimer.current && activeFile?.name.startsWith(path + '/')) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const before = stateRef.current;
      const stale = before.tabs.filter(
        (t) => t.file && t.file.name.startsWith(path + '/'),
      );
      for (const t of stale) dispatch({ type: 'CLOSE_TAB', id: t.id });
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (before.activeFolder === path || before.activeFolder.startsWith(path + '/')) {
        dispatch({ type: 'ACTIVE_FOLDER', path: parent });
      }
      if (before.selectedPath === path || before.selectedPath.startsWith(path + '/')) {
        dispatch({ type: 'SELECT_PATH', path: parent });
      }
      dispatch({
        type: 'FILES_LOADED',
        files: before.files.filter((f) => !f.name.startsWith(path + '/')),
        folders: before.folders.filter((f) => f.path !== path && !f.path.startsWith(path + '/')),
        folder: before.folder,
      });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        const files = await loadFiles(targetFolderPath);
        if (stateRef.current.folderPath !== targetFolderPath) return;
        dispatch({ type: 'PRUNE_MISSING_FILE_TABS', names: files.map((f) => f.name) });
        return;
      }
      await loadFiles(targetFolderPath);
      toast('Delete failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    }
  }, [flushSave, loadFiles, toast, askConfirm]);

  const renameFile = useCallback(async (oldName: string, newBaseName: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const newName = renamedFilePath(oldName, newBaseName);
    if (newName === oldName) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (
      stateRef.current.files.some((f) => f.name === newName)
      || stateRef.current.folders.some((f) => f.path === newName)
    ) {
      toast('Rename failed: target exists', { level: 'error' });
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const cascade = await askCascadeForRename('file', oldName, newName);
    if (stateRef.current.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current)?.file;
    const wasActive = activeFile?.name === oldName;
    if (wasActive) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Renaming…', cls: '' } });
    }
    dispatch({ type: 'REMAP_PATHS', from: oldName, to: newName, kind: 'file' });
    dispatch({ type: 'RENAMING', renaming: null });
    try {
      const j = await api.renameFile(oldName, newName, { cascade, asyncIndex: true });
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (j.name !== newName) {
        dispatch({ type: 'REMAP_PATHS', from: newName, to: j.name, kind: 'file' });
      }
      if (wasActive && activeFile) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Saved', cls: 'saved' } });
      }
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Renamed. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Renamed. Updating semantic index in the background.', { level: 'info' });
      }
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return;
      dispatch({ type: 'REMAP_PATHS', from: newName, to: oldName, kind: 'file' });
      const msg = e instanceof Error ? e.message : String(e);
      toast('Rename failed: ' + msg, { level: 'error' });
      if (wasActive) {
        dispatch({ type: 'SAVE_STATUS', status: { text: 'Rename failed', cls: 'error' } });
      }
    } finally {
      if (stateRef.current.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const renameFolder = useCallback(async (oldPath: string, newName: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
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
    if (stateRef.current.folderPath !== targetFolderPath) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    if (cascade === null) {
      dispatch({ type: 'RENAMING', renaming: null });
      return;
    }
    const activeFile = getActiveTab(stateRef.current)?.file;
    if (activeFile && activeFile.name.startsWith(oldPath + '/')) {
      if (!(await flushSave())) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
      if (stateRef.current.folderPath !== targetFolderPath) {
        dispatch({ type: 'RENAMING', renaming: null });
        return;
      }
    }
    try {
      const j = await api.renameFolder(oldPath, newName, { cascade });
      if (stateRef.current.folderPath !== targetFolderPath) return;
      const s = stateRef.current;
      // Server has rewritten the on-disk path; mirror the expansion
      // across so the renamed folder stays open after `loadFiles`.
      // The orphan oldPath entry in the set is harmless — no folder
      // row matches it, so it just sits inert until the next reset.
      if (s.expanded.has(oldPath)) {
        dispatch({ type: 'EXPAND_FOLDER', path: j.path });
      }
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.path, kind: 'folder' });
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return;
      toast('Rename failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      if (stateRef.current.folderPath === targetFolderPath) dispatch({ type: 'RENAMING', renaming: null });
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const moveFile = useCallback(async (oldPath: string, targetDir: string) => {
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return false;
    const basename = oldPath.split('/').pop() ?? oldPath;
    const newPath = targetDir ? `${targetDir}/${basename}` : basename;
    if (newPath === oldPath) return true;
    const cascade = await askCascadeForRename('file', oldPath, newPath);
    if (stateRef.current.folderPath !== targetFolderPath) return false;
    if (cascade === null) return false;
    const cur = getActiveTab(stateRef.current)?.file;
    if (cur?.name === oldPath && !(await flushSave())) return false;
    if (stateRef.current.folderPath !== targetFolderPath) return false;
    try {
      const j = await api.renameFile(oldPath, newPath, { cascade, asyncIndex: true });
      if (stateRef.current.folderPath !== targetFolderPath) return true;
      dispatch({ type: 'REMAP_PATHS', from: oldPath, to: j.name, kind: 'file' });
      if (targetDir) dispatch({ type: 'EXPAND_FOLDER', path: targetDir });
      await loadFiles(targetFolderPath);
      if (j.indexWarning) {
        toast('Moved. ' + j.indexWarning, { level: 'warning' });
      } else if (j.indexDeferred) {
        toast('Moved. Updating semantic index in the background.', { level: 'info' });
      }
      return true;
    } catch (e: unknown) {
      if (stateRef.current.folderPath !== targetFolderPath) return false;
      toast('Move failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      return false;
    }
  }, [askCascadeForRename, flushSave, loadFiles, toast]);

  const upload = useCallback(async (
    items: { file: File; relPath: string }[],
    dir: string,
  ): Promise<boolean> => {
    const targetFolderPath = stateRef.current.folderPath;
    const targetFolderLabel = stateRef.current.folder;
    if (!targetFolderPath) {
      toast('Open a folder before importing files.', { level: 'warning' });
      return false;
    }
    if (dir) dispatch({ type: 'EXPAND_FOLDER', path: dir });
    try {
      const j = await api.upload(items, dir, targetFolderPath);
      const stillInTargetFolder = stateRef.current.folderPath === targetFolderPath;
      if (!stillInTargetFolder) {
        const failed = (j.files || []).filter((x) => x.error);
        if (failed.length) {
          console.warn('[upload] failed:', failed);
          toast(`${failed.length} file(s) failed to import into ${targetFolderLabel}.`, { level: 'error' });
        } else {
          toast(`Imported ${j.files?.length ?? items.length} file(s) into ${targetFolderLabel}.`, { level: 'info' });
        }
        return failed.length === 0;
      }
      await loadFiles(targetFolderPath);
      // Optimistically light up the stashing indicator (sidebar pill +
      // the opened tab's logo) the instant the drop lands. The server
      // registers each conversion only *after* it has responded, so the
      // immediate poll below races it — a user-initiated import
      // shouldn't wait a poll round-trip to show it's stashing. Limited
      // to the convertible+viewable formats (PDF / image); md/html are
      // indexed, not converted, so they never enter `pendingConversions`
      // — but they DO surface as stashing the moment the immediate poll
      // below sees them in the indexer's `pending` set (saved to disk
      // before the upload responds, indexed fire-and-forget after), so a
      // markdown folder drop still gets a count via `stashingPaths`.
      // The poll reconciles: it keeps these while in-flight and drops
      // them when the derived note lands. Sorted to match the server's
      // `getInFlightConversions` ordering so the next poll is a no-op.
      const stashing = (j.files || [])
        .filter((x) => !x.error && /\.(pdf|png|jpe?g|webp)$/i.test(x.file))
        .map((x) => x.file);
      if (stashing.length) {
        // Protect the optimistic entries from being wiped by an index
        // poll that lands before the server registers the conversion.
        const deadline = Date.now() + 6000;
        for (const name of stashing) importStashingGrace.current.set(name, deadline);
        const merged = [...new Set([...stateRef.current.pendingConversions, ...stashing])].sort();
        dispatch({ type: 'PENDING_CONVERSIONS', paths: merged });
      }
      // Optimistically mark the indexable imports (md / html, non-hidden)
      // as pending too. These never enter `pendingConversions`; they show
      // via `pendingNames` → `stashingPaths`. The poll alone under-counts
      // and lags here (the daemon serialises `status` behind the embeds),
      // so without this a 4-note drop reads "3 stashing" a beat late.
      // `refreshIndexState` holds these until the folder is up-to-date.
      const indexing = (j.files || [])
        .filter((x) => !x.error && /\.(md|markdown|html?)$/i.test(x.file))
        .filter((x) => !x.file.split('/').some((seg) => seg.startsWith('.')))
        .map((x) => x.file);
      if (indexing.length) {
        const deadline = Date.now() + 60000;
        for (const name of indexing) importIndexGrace.current.set(name, deadline);
        const merged = new Set(stateRef.current.pendingNames);
        for (const name of indexing) merged.add(name);
        dispatch({ type: 'PENDING_NAMES', names: merged });
      }
      // Now the server has fired any PDF conversions and updated its
      // `pendingConversions` set. Poll immediately so the indicator
      // reconciles even when the conversion is fast enough to finish
      // inside the regular poll window.
      void refreshIndexState();
      // Auto-open the first viewable file the drop produced — the
      // import was a deliberate user action, so showing what landed is
      // expected (mirrors dropping a file into an editor). Limited to
      // formats the viewer can actually render (md/html via getFile,
      // pdf + image synthesized in `loadFile`); a dropped PDF/image
      // opens its body immediately and carries the stashing mark on its
      // tab while it converts. Opens at most ONE file, so a batch drop
      // doesn't explode into tabs.
      const first = j.files?.find(
        (x) => !x.error && /\.(md|markdown|html|htm|pdf|png|jpe?g|webp)$/i.test(x.file),
      );
      // Pinned, not preview: a drop is a deliberate, committed gesture
      // (the double-click analog), so the imported file should stay open
      // rather than be a tentative tab the next sidebar click evicts.
      if (first) void openInNewTab(first.file, targetFolderPath);
      const failed = (j.files || []).filter((x) => x.error);
      if (failed.length) {
        console.warn('[upload] failed:', failed);
        toast(`${failed.length} file(s) failed to import. Check console for details.`, { level: 'error' });
      }
      return failed.length === 0;
    } catch (e: unknown) {
      console.warn('[upload] request failed:', e);
      toast(`Upload failed: ${errorMessage(e)}`, { level: 'error' });
      return false;
    }
  }, [loadFiles, refreshIndexState, openInNewTab, toast]);

  const runSync = useCallback(async () => {
    if (stateRef.current.syncRunning) return;
    const targetFolderPath = stateRef.current.folderPath;
    if (!targetFolderPath) return;
    const myGen = ++syncGen.current;
    dispatch({ type: 'SYNC_RUNNING', running: true });
    void refreshIndexState();
    try {
      const result = await api.sync(targetFolderPath);
      if (stateRef.current.folderPath !== targetFolderPath) return;
      if (result.failed?.length || result.cancelled) {
        await refreshIndexState();
      } else {
        dispatch({ type: 'INDEX_WARNING', warning: null });
      }
      await loadFiles(targetFolderPath);
    } catch (e: unknown) {
      toast('Sync failed: ' + (e instanceof Error ? e.message : String(e)), { level: 'error' });
    } finally {
      if (myGen === syncGen.current) dispatch({ type: 'SYNC_RUNNING', running: false });
    }
  }, [loadFiles, refreshIndexState, showAlert]);

  // Clear every piece of UI state scoped to the previous folder. Shared
  // by finishOpenFolder (switching *in*) and goHome (switching *out*) so
  // the two can't drift. Each action targets a disjoint state slice, so
  // call order doesn't matter. Note the server kills every agent session
  // on a folder switch (onSwitch → killActiveAgent); CHAT_TABS_RESET drops
  // our tab list to match so we don't render orphan panels.
  const resetFolderScopedState = useCallback(() => {
    syncGen.current += 1;
    searchGen.current += 1;
    lastTreeVersion.current = -1;
    importStashingGrace.current.clear();
    importIndexGrace.current.clear();
    dispatch({ type: 'TABS_RESET' });
    dispatch({ type: 'CHAT_TABS_RESET' });
    dispatch({ type: 'FILTER', q: '' });
    dispatch({ type: 'SEARCH_CLEAR' });
    dispatch({ type: 'ACTIVE_FOLDER', path: '' });
    dispatch({ type: 'PENDING_NAMES', names: new Set() });
    dispatch({ type: 'PENDING_CONVERSIONS', paths: [] });
    dispatch({ type: 'INDEX_WARNING', warning: null });
    dispatch({ type: 'CONVERSION_FAILURES', failures: [] });
    dispatch({ type: 'SYNC_RUNNING', running: false });
    dispatch({ type: 'FILE_ORDER_LOADED', order: {} });
  }, []);

  const finishOpenFolder = useCallback(async (
    expected: { path: string; name: string },
    generation: number,
    opts: { optimisticStashingOnOpen?: boolean } = {},
  ) => {
    if (generation !== openGen.current) return;
    const expectedFolderPath = expected.path;
    resetFolderScopedState();
    dispatch({ type: 'COLLAPSE_ALL_FOLDERS' });
    // Establish the renderer-side folder identity before the guarded
    // `/api/files` load below. Otherwise the stale-response check sees
    // the previous folder (or Welcome's empty folder) and drops the first
    // legitimate file listing after an open/create/import flow.
    dispatch({
      type: 'FILES_LOADED',
      files: [],
      folders: [],
      folder: expected.name,
      folderPath: expectedFolderPath,
    });
    void refreshIndexState();
    // Load files BEFORE hiding the welcome overlay so the sidebar doesn't
    // briefly flash "NOTES" with an empty tree behind the overlay's fade.
    const [files] = await Promise.all([loadFiles(expectedFolderPath), loadFileOrder(expectedFolderPath)]);
    if (generation !== openGen.current || stateRef.current.folderPath !== expectedFolderPath) return;
    if (opts.optimisticStashingOnOpen && stateRef.current.embedderHasKey !== false) {
      await markVisibleFilesStashing(files);
    }
    dispatch({ type: 'WELCOME_HIDE' });
    // Land on a Welcome/README note instead of a blank tab. `finishOpenFolder`
    // is the fresh-entry path (it just reset tabs above), so no need to guard
    // on tab count — and we use the files loadFiles just returned rather than
    // reading `stateRef`, which may not yet reflect the FILES_LOADED dispatch.
    const landing = pickLandingFile(files);
    if (landing) void selectFile(landing);
  }, [loadFiles, loadFileOrder, markVisibleFilesStashing, refreshIndexState, resetFolderScopedState, selectFile]);

  const refreshRecent = useCallback(async () => {
    const j = await api.getFolder();
    dispatch({ type: 'RECENT_LOADED', recent: j.recent ?? [], homeDir: j.homeDir });
  }, []);

  // These THROW on failure — callers decide how to surface it. Welcome's
  // fire-and-forget callers (recent pills) `.catch` into WELCOME_ERROR;
  // the New/Open/Import modals and the Sidebar folder menu catch in-place
  // to show the error and keep their input. (They used to swallow here,
  // which made every caller's catch dead code and hid in-folder failures.)
  const openFolder = useCallback(async (path: string) => {
    if (editorRef.current && !(await flushSave())) {
      throw new Error('Current file could not be saved. Resolve the save error before switching folders.');
    }
    const generation = ++openGen.current;
    const opened = await api.openFolder(path);
    const current = opened.current;
    if (!current || generation !== openGen.current) return;
    void refreshRecent().catch((err) => {
      console.warn('[recent] refresh after open failed:', err);
    });
    await finishOpenFolder(current, generation);
  }, [finishOpenFolder, flushSave, refreshRecent]);

  const openFolderByName = useCallback(async (
    name: string,
    opts?: { create?: boolean; exclusiveCreate?: boolean; optimisticStashingOnOpen?: boolean },
  ) => {
    if (editorRef.current && !(await flushSave())) {
      throw new Error('Current file could not be saved. Resolve the save error before switching folders.');
    }
    const generation = ++openGen.current;
    const opened = await api.openFolderByName(name, {
      create: opts?.create,
      exclusiveCreate: opts?.exclusiveCreate,
    });
    const current = opened.current;
    if (!current || generation !== openGen.current) return;
    void refreshRecent().catch((err) => {
      console.warn('[recent] refresh after open failed:', err);
    });
    await finishOpenFolder(current, generation, {
      optimisticStashingOnOpen: opts?.optimisticStashingOnOpen,
    });
  }, [finishOpenFolder, flushSave, refreshRecent]);

  const goHome = useCallback(async () => {
    if (editorRef.current && !(await flushSave())) return false;
    openGen.current += 1;
    try {
      await api.closeFolder();
    } catch (err: unknown) {
      toast('Could not close the current folder: ' + (err instanceof Error ? err.message : String(err)), { level: 'error' });
      return false;
    }
    resetFolderScopedState();
    dispatch({ type: 'FILES_LOADED', files: [], folders: [], folder: '', folderPath: '' });
    // Recent entries can disappear or be removed while a folder is
    // open. Show Welcome immediately, but wait for the server-filtered
    // list before rendering pills so stale paths don't flash or stick.
    dispatch({ type: 'WELCOME_SHOW', recent: [] });
    void api.getFolder()
      .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
      .catch(() => { /* keep the empty list if the refresh fails */ });
    return true;
  }, [flushSave, resetFolderScopedState, toast]);

  const bootstrap = useCallback(async () => {
    try {
      const j = await api.getFolder();
      dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir });
      const initialFolder = new URLSearchParams(window.location.search).get('folder');
      if (initialFolder) {
        window.history.replaceState(null, '', window.location.pathname);
        try {
          if (isAbsoluteFolderRef(initialFolder)) {
            await openFolder(initialFolder);
          } else {
            await openFolderByName(initialFolder);
          }
        } catch (err: unknown) {
          dispatch({
            type: 'WELCOME_SHOW',
            recent: j.recent ?? [],
            homeDir: j.homeDir,
            error: `Could not open "${initialFolder}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (j.current) {
        const generation = ++openGen.current;
        await finishOpenFolder(j.current, generation);
        const restoredFolderPath = j.current.path;
        if (generation === openGen.current && stateRef.current.folderPath === restoredFolderPath) {
          void api.sync(restoredFolderPath)
            .catch(() => { /* surfaced by the next status poll */ })
            .finally(() => { void refreshIndexState(); });
        }
      }
    } catch {
      dispatch({ type: 'WELCOME_SHOW', recent: [], error: 'Server unreachable' });
    }
  }, [finishOpenFolder, openFolder, openFolderByName, refreshIndexState]);

  const dismissIndexWarning = useCallback(async () => {
    const folderAtStart = stateRef.current.folderPath;
    dispatch({ type: 'INDEX_WARNING', warning: null });
    try { await api.dismissIndexWarning(folderAtStart || undefined); }
    catch (err) {
      console.warn('[index-warning] dismiss failed:', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const actions = useMemo<AppActions>(() => ({
    bootstrap, openFolder, openFolderByName, goHome,
    loadFiles, markVisibleFilesStashing, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissIndexWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, closeTab, closeActiveTab, activateTab,
    navigateTo, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    alert: showAlert, confirm: askConfirm, resolveModal,
    toast, dismissToast, clearToasts,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
  }), [
    bootstrap, openFolder, openFolderByName, goHome,
    loadFiles, markVisibleFilesStashing, refreshIndexState, runSync, runSearch, setFolderOrder,
    dismissIndexWarning,
    selectFile, selectFileWithHighlight, openInNewTab, newTab, closeTab, closeActiveTab, activateTab,
    navigateTo, consumePendingScroll,
    consumePendingHighlight,
    resolveCascadePrompt,
    showAlert, askConfirm, resolveModal, toast, dismissToast, clearToasts,
    toggleEditMode,
    newNote, newFolder, deleteFile, deleteFolder,
    renameFile, renameFolder, moveFile, upload,
    scheduleSave, flushSave,
    registerEditor,
    registerSearchInput, focusSearch,
    registerFindController, openFind, closeFind, setFindQuery,
    toggleFindCaseSensitive, toggleFindWholeWord, findNext, findPrev,
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

  // Reconcile on window focus — the replacement for the old fs.watch
  // layer. External edits made while StashBase wasn't focused (vim, git
  // checkout, scripts) fold in the moment the user comes back; while the
  // app IS focused, in-app and agent writes index on their own write
  // paths, so nothing is lost by not watching. Throttled so rapid
  // focus/blur cycles don't stack syncs; results surface through the
  // regular index-status poll (treeVersion bumps server-side).
  useEffect(() => {
    let lastFocusSync = 0;
    function onFocus() {
      const focusFolder = stateRef.current.folderPath;
      if (!focusFolder) return;
      const now = Date.now();
      if (now - lastFocusSync < 5000) return;
      lastFocusSync = now;
      void api.sync(focusFolder)
        .catch(() => { /* surfaced by the next status poll */ })
        .finally(() => { void refreshIndexState(); });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshIndexState]);

  // Best-effort flush before unload. `sendBeacon` keeps the POST alive
  // past page teardown.
  useEffect(() => {
    function onUnload() {
      const cur = getActiveTab(stateRef.current)?.file ?? null;
      const h = editorRef.current;
      const liveValue = h?.getValue();
      if (cur && h && liveValue !== undefined && liveValue !== cur.content) {
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        try {
          const qs = `?windowId=${encodeURIComponent(getWindowId())}`;
          const endpoint = `/api/files/${encodePath(cur.name)}${qs}`;
          navigator.sendBeacon?.(
            endpoint,
            new Blob(
              [JSON.stringify({ content: liveValue, ...(cur.version ? { baseVersion: cur.version } : {}) })],
              { type: 'application/json' },
            ),
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
