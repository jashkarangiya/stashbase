import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  setKbRootConfirming,
  errorMessage,
  type FolderImportPreview,
  type ImportFolderMode,
} from '../api';
import { CubeLogoIcon, FolderIcon, NewFolderIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { ModalShell } from './ModalShell';
import { openSettings } from './SettingsModal';

interface ElectronBridge {
  openFolderDialog?: (opts?: {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    allowCreateDirectory?: boolean;
  }) => Promise<string | null>;
}

/** Shorten an absolute path for display: `/Users/foo/Notes` → `~/Notes`
 *  when it lives under the user's home dir. Falls through unchanged
 *  otherwise (e.g. `/tmp/scratch`). */
function prettifyHome(abs: string, home: string): string {
  if (!home) return abs;
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1);
  return abs;
}

/** Client-side mirror of the server's `validateSpaceName` — same
 *  cross-platform-safe rules (no slashes, no leading/trailing dot, none
 *  of `< > : " | ? *` or control chars), for instant feedback without a
 *  round-trip. The server re-validates; this just avoids the obvious
 *  mistakes. Returns an error message, or null when the name is OK. */
function spaceNameError(n: string): string | null {
  if (!n) return 'Name required';
  if (n === '.' || n === '..' || n.startsWith('.') || n.endsWith('.')) {
    return 'Name cannot start or end with "."';
  }
  // eslint-disable-next-line no-control-regex
  if (/[/\\<>:"|?*\u0000-\u001f]/.test(n)) {
    return 'Name cannot contain / \\ < > : " | ? * or control characters';
  }
  if (n.length > 64) return 'Name too long (max 64 chars)';
  return null;
}

/**
 * Landing overlay shown when no space is open (or after the user
 * explicitly goes home). Spaces are flat under the KB root
 * (`~/Documents/StashBase/` by default) and are identified by name.
 *
 *   - **New space**: text input for a name; server creates the folder
 *     under kbRoot and opens it.
 *   - **Open space**: dropdown of existing direct-child folders under
 *     kbRoot; click to open.
 *   - **Import folder**: native picker to bring an existing folder
 *     (e.g. a repo you cloned yourself) in as a space.
 *
 * New / Open work by name (no system dialog — a single-segment name
 * makes the kbRoot invariant trivial to enforce); Import folder is the
 * exception and uses the native folder picker for a disk path.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [newOpen, setNewOpen] = useState(false);
  const [openOpen, setOpenOpen] = useState(false);
  const [importSource, setImportSource] = useState<string | null>(null);
  const [kbRoot, setKbRoot] = useState('');
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);

  const refreshKbRoot = useCallback(async () => {
    const r = await api.getKbRoot();
    setKbRoot(r.path);
    if (r.needsPicker) setRootPickerOpen(true);
    return r.path;
  }, []);

  // Fetch kbRoot so copy can show `~/Documents/StashBase` as the
  // container path in the hints below the action buttons.
  useEffect(() => {
    void (async () => {
      try {
        await refreshKbRoot();
      } catch (err) {
        dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
      }
    })();
  }, [dispatch, refreshKbRoot]);

  useEffect(() => {
    if (!state.welcomeVisible) return;
    void Promise.all([api.getSpace(), refreshKbRoot()])
      .then(([j]) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
      .catch(() => { /* keep the current welcome state */ });
  }, [dispatch, refreshKbRoot, state.welcomeVisible]);

  function openOpenSpaceModal() {
    void refreshKbRoot().catch((err) => {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    });
    setOpenOpen(true);
  }

  function openNewSpaceModal() {
    void refreshKbRoot().catch((err) => {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    });
    setNewOpen(true);
  }

  function openRecent(path: string) {
    void actions.openSpace(path).catch((e) => {
      const msg = errorMessage(e);
      // Remove the failed entry immediately so a stale/deleted path
      // doesn't remain clickable if the server refresh also fails.
      dispatch({
        type: 'WELCOME_SHOW',
        recent: state.recent.filter((r) => r.path !== path),
        homeDir: state.homeDir,
        error: msg,
      });
      void api.getSpace()
        .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir, error: msg }))
        .catch(() => { /* keep the optimistic removal + original open error */ });
    });
  }

  if (!state.welcomeVisible) return null;

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-logo">
            <CubeLogoIcon />
          </div>
          <div className="welcome-title">StashBase</div>
          <div className="welcome-sub">
            Turn what you save into persistent memory.
          </div>
        </div>

        <div className="welcome-actions">
          <button
            className="welcome-action"
            type="button"
            onClick={openOpenSpaceModal}
            title="Open an existing space in your knowledge base"
          >
            <span className="welcome-action-icon">
              <FolderIcon />
            </span>
            <span className="welcome-action-label">Open space</span>
          </button>
          <button
            className="welcome-action"
            type="button"
            onClick={openNewSpaceModal}
            title="Create a new space in your knowledge base"
          >
            <span className="welcome-action-icon">
              <NewFolderIcon />
            </span>
            <span className="welcome-action-label">New space</span>
          </button>
          <ImportFolderButton onPicked={setImportSource} />
        </div>

        <div className="welcome-mcp">
          <div className="welcome-mcp-text">
            <div className="welcome-mcp-title">Connect AI tools</div>
            <div className="welcome-mcp-sub">
              Use your memory from Claude, ChatGPT, and more.
            </div>
          </div>
          <button
            className="welcome-mcp-btn"
            type="button"
            onClick={() => openSettings('mcp')}
          >
            Open MCP Settings
          </button>
        </div>

        {state.recent.length > 0 && (
          <div className="welcome-recent">
            <div className="welcome-recent-head">
              <span>Recent spaces</span>
              {state.recent.length > 12 && (
                <button
                  className="welcome-recent-more"
                  type="button"
                  onClick={() => setShowAllRecent((v) => !v)}
                >
                  {showAllRecent ? 'Show less' : `Show all (${state.recent.length})`}
                </button>
              )}
            </div>
            <div className="welcome-recent-pills">
              {(showAllRecent ? state.recent : state.recent.slice(0, 12)).map((r) => {
                const name = r.path.split('/').filter(Boolean).pop() || r.path;
                return (
                  <button
                    key={r.path}
                    type="button"
                    className="welcome-recent-pill"
                    title={name}
                    onClick={() => openRecent(r.path)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {state.welcomeError && (
          <div className="welcome-err">{state.welcomeError}</div>
        )}
      </div>
      {importSource && (
        <ImportFolderModal
          source={importSource}
          homeDir={state.homeDir ?? ''}
          onClose={() => setImportSource(null)}
        />
      )}
      {rootPickerOpen && (
        <KbRootPickerModal
          initialPath={kbRoot}
          homeDir={state.homeDir ?? ''}
          onSaved={(path, warnings) => {
            setKbRoot(path);
            setRootPickerOpen(false);
            void api.getSpace()
              .then((j) => dispatch({
                type: 'WELCOME_SHOW',
                recent: j.recent ?? [],
                homeDir: j.homeDir,
                error: warnings?.length ? warnings.join(' ') : undefined,
              }))
              .catch((err) => dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) }));
          }}
        />
      )}
      {newOpen && (
        <NewSpaceModal
          kbRoot={kbRoot}
          homeDir={state.homeDir ?? ''}
          onClose={() => setNewOpen(false)}
        />
      )}
      {openOpen && (
        <OpenSpaceModal
          kbRoot={kbRoot}
          homeDir={state.homeDir ?? ''}
          onClose={() => setOpenOpen(false)}
          onNewSpace={() => {
            setOpenOpen(false);
            setNewOpen(true);
          }}
          onImportFolder={(path) => {
            setOpenOpen(false);
            setImportSource(path);
          }}
        />
      )}
    </div>
  );
}

function KbRootPickerModal({
  initialPath,
  homeDir,
  onSaved,
}: {
  initialPath: string;
  homeDir: string;
  onSaved: (path: string, warnings?: string[]) => void;
}) {
  const { actions } = useApp();
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = path ? prettifyHome(path, homeDir) : '~/Documents/StashBase';

  useEffect(() => setPath(initialPath), [initialPath]);

  async function browse() {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    try {
      const picked = await bridge?.openFolderDialog?.({
        title: 'Choose root folder',
        buttonLabel: 'Use as Root folder',
        defaultPath: path || undefined,
      });
      if (picked) {
        setPath(picked);
        setError(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function submit() {
    const p = path.trim();
    if (!p) { setError('Path required'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await setKbRootConfirming(p, actions.confirm);
      if (r) onSaved(r.path, r.warnings); // null → user declined the non-empty confirm
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell closeOnBackdrop={false} onCancel={() => { /* first-run picker is required */ }}>
      <h3>Choose root folder</h3>
      <p className="modal-hint">
        Spaces will live as folders inside <code>{display}</code>.
      </p>
      <input
        type="text"
        className="modal-input"
        value={path}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setPath(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={() => { void browse(); }} disabled={busy}>
          Browse
        </button>
        <button type="button" className="modal-btn primary" onClick={() => { void submit(); }} disabled={busy || !path.trim()}>
          {busy ? 'Saving…' : 'Use this folder'}
        </button>
      </div>
    </ModalShell>
  );
}

/** "Import folder" action — opens the native folder picker, then asks
 *  the server to copy the chosen directory into <kbRoot>/<basename> as
 *  a brand-new space. Browser fallback (no Electron bridge) hides the
 *  button entirely: there's no portable file-picker we'd trust to
 *  return an absolute path the server can act on. */
function ImportFolderButton({ onPicked }: { onPicked: (path: string) => void }) {
  const { dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const bridge = useMemo<ElectronBridge | undefined>(
    () => (window as { electron?: ElectronBridge }).electron,
    [],
  );
  if (typeof bridge?.openFolderDialog !== 'function') return null;
  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await bridge!.openFolderDialog!({
        title: 'Import folder as space',
        buttonLabel: 'Choose Folder',
        allowCreateDirectory: false,
      });
      if (picked) onPicked(picked);
    } catch (err) {
      dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      className="welcome-action"
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Copy an existing folder on your disk into the knowledge base as a new space"
    >
      <span className="welcome-action-icon">
        <FolderIcon />
      </span>
      <span className="welcome-action-label">{busy ? 'Choosing…' : 'Import folder'}</span>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ImportFolderModal({
  source,
  homeDir,
  onClose,
}: {
  source: string;
  homeDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [preview, setPreview] = useState<FolderImportPreview | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ImportFolderMode>('copy');
  const [largeImportConfirmed, setLargeImportConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a move import finished but left the original behind (see
  // FolderImportResult.warning). The space exists; we keep the modal up
  // to show the cleanup notice and let the user open it deliberately.
  const [doneName, setDoneName] = useState<string | null>(null);
  const previewSeq = useRef(0);
  // Debounce re-previews while the user types the name. A preview scans
  // the source tree (up to the 50k cap); firing one per keystroke would
  // re-scan the whole folder on every character. Only destination /
  // collision depend on the name — debounce keeps it cheap.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One preview path for both the initial scan and every re-preview as
  // the user edits the name. `nameArg === undefined` is the initial call:
  // the server derives the name from the source basename and we adopt it.
  // A monotonic seq guards against a slow earlier scan overwriting a
  // newer one (and against a late response landing after unmount, since
  // the cleanup below bumps the seq).
  const runPreview = useCallback((nameArg?: string) => {
    const seq = ++previewSeq.current;
    void (async () => {
      try {
        const p = await api.previewImportFolder(source, nameArg);
        if (seq !== previewSeq.current) return;
        setPreview(p);
        setError(null);
        if (nameArg === undefined) setName(p.name);
      } catch (err) {
        if (seq !== previewSeq.current) return;
        setError(errorMessage(err));
      }
    })();
  }, [source]);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setLargeImportConfirmed(false);
    runPreview();
    return () => {
      previewSeq.current++; // invalidate any in-flight preview on unmount / source change
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [source, runPreview]);

  useEffect(() => {
    if (!preview?.requiresLargeImportConfirmation) setLargeImportConfirmed(false);
  }, [preview?.requiresLargeImportConfirmation]);

  function refreshName(nextName: string) {
    setName(nextName);
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    if (!nextName.trim()) {
      setPreview(null);
      setError(null);
      return;
    }
    // Debounce: a preview re-scans the source tree (up to the 50k cap),
    // so firing one per keystroke would re-walk the whole folder each
    // time. Only destination / collision depend on the name.
    refreshTimer.current = setTimeout(() => runPreview(nextName), 250);
  }

  async function submit() {
    const n = name.trim();
    const nameErr = spaceNameError(n);
    if (nameErr) { setError(nameErr); return; }
    if (preview?.requiresLargeImportConfirmation && !largeImportConfirmed) {
      setError('This folder is large. Confirm that you want to import it before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.importFolder(source, {
        name: n,
        mode,
        confirmExisting: true,
        confirmLargeImport: !preview?.requiresLargeImportConfirmation || largeImportConfirmed,
      });
      if (result.warning) {
        // Import succeeded but the original couldn't be removed. Keep the
        // modal open so the notice survives; the user opens the space
        // (which unmounts Welcome) only after acknowledging it.
        setDoneName(result.name);
        setError(result.warning);
        setBusy(false);
        return;
      }
      try {
        await actions.openSpaceByName(result.name, { optimisticStashingOnOpen: true });
      } catch (openErr) {
        setDoneName(result.name);
        setError(`Imported "${result.name}", but it could not be opened: ${errorMessage(openErr)}`);
        setBusy(false);
        return;
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const sourceDisplay = prettifyHome(source, homeDir);
  const destinationDisplay = preview ? prettifyHome(preview.destination, homeDir) : '';
  const importActionMessage = mode === 'move'
    ? 'The original folder will be removed after the move.'
    : 'Importing copies this existing folder into your StashBase knowledge base.';
  const serverWarnings = (preview?.warnings ?? []).filter((w) =>
    w !== 'Importing copies this existing folder into your StashBase knowledge base.' &&
    !w.startsWith('Large folder') &&
    // Destination is already shown (prettified) above — drop the server's
    // duplicate absolute-path "Destination will be …" line.
    !w.startsWith('Destination will be'),
  );
  const needsLargeImportConfirmation = preview?.requiresLargeImportConfirmation === true;

  return (
    <ModalShell closeOnBackdrop={false} onCancel={busy ? () => { /* swallow during import */ } : onClose}>
      <h3>Import folder</h3>
      <p className="modal-hint">
        Imports <code>{sourceDisplay}</code> as a new space.
      </p>
      <input
        type="text"
        className="modal-input"
        placeholder="Space name"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(e) => { void refreshName(e.target.value); }}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
        }}
      />
      <label className="modal-check">
        <input
          type="checkbox"
          checked={mode === 'move'}
          disabled={busy}
          onChange={(e) => setMode(e.target.checked ? 'move' : 'copy')}
        />
        <span>Move folder into StashBase instead of copying</span>
      </label>
      {preview && (
        <div className="modal-hint modal-import-preview">
          <div>Destination: <code>{destinationDisplay}</code></div>
          <div className="modal-import-stat">
            {preview.entryCount} item{preview.entryCount === 1 ? '' : 's'} · {formatBytes(preview.totalBytes)}
          </div>
          {preview.exists && mode === 'move' && <div>{importActionMessage}</div>}
          {preview.nameTaken && (
            <div className="modal-import-warn">A space named “{name.trim()}” already exists — pick another name (Import won’t merge into it).</div>
          )}
          {serverWarnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      {needsLargeImportConfirmation && (
        <div className="modal-warning">
          <strong>Large folder selected</strong>
          <div>
            This folder contains {preview.largeImportReason ?? 'a large amount of data'}.
            Importing may copy many files and take a long time.
          </div>
          <label className="modal-check">
            <input
              type="checkbox"
              checked={largeImportConfirmed}
              disabled={busy}
              onChange={(e) => setLargeImportConfirmed(e.target.checked)}
            />
            <span>I understand and want to import this entire folder.</span>
          </label>
        </div>
      )}
      {error && <div className={doneName ? 'modal-warning' : 'modal-error'}>{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          {doneName ? 'Close' : 'Cancel'}
        </button>
        {doneName ? (
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => {
              void actions.openSpaceByName(doneName, { optimisticStashingOnOpen: true })
                .then(onClose)
                .catch((e) => setError(errorMessage(e)));
            }}
          >Open space</button>
        ) : (
          <button
            type="button"
            className="modal-btn primary"
            onClick={() => { void submit(); }}
            disabled={busy || !preview || !name.trim() || preview.nameTaken || (needsLargeImportConfirmation && !largeImportConfirmed)}
          >{busy ? 'Importing…' : mode === 'move' ? 'Move into StashBase' : 'Copy into StashBase'}</button>
        )}
      </div>
    </ModalShell>
  );
}

/** "New space" modal: a single text input. Server creates the folder
 *  under kbRoot and opens it in one shot. Names go through
 *  `validateSpaceName` server-side; we do a quick client-side check
 *  to avoid a round-trip on obvious mistakes. */
function NewSpaceModal({
  kbRoot,
  homeDir,
  onClose,
}: {
  kbRoot: string;
  homeDir: string;
  onClose: () => void;
}) {
  const { actions } = useApp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootDisplay = kbRoot ? prettifyHome(kbRoot, homeDir) : '~/Documents/StashBase';

  async function submit() {
    const n = name.trim();
    const nameErr = spaceNameError(n);
    if (nameErr) { setError(nameErr); return; }
    setBusy(true);
    setError(null);
    try {
      await actions.openSpaceByName(n, { create: true, exclusiveCreate: true });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell closeOnBackdrop={false} onCancel={busy ? () => { /* swallow during create */ } : onClose}>
      <h3>New space</h3>
      <p className="modal-hint">
        Creates{' '}
        <code>
          {rootDisplay}/{name.trim() || '<name>'}
        </code>{' '}
        and opens it. The folder is created if it doesn't exist yet.
      </p>
      <input
        type="text"
        className="modal-input"
        placeholder="e.g. research, notes, cs183b"
        autoComplete="off"
        spellCheck={false}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        autoFocus
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
        }}
      />
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="modal-btn primary"
          onClick={() => { void submit(); }}
          disabled={busy || !name.trim()}
        >{busy ? 'Opening…' : 'Create'}</button>
      </div>
    </ModalShell>
  );
}

/** "Open space" modal: list of direct-child folders under kbRoot,
 *  recently-opened ones first then the rest alphabetically. Includes
 *  everything in the knowledge base — folders the user created via Finder
 *  but never opened still show up. Empty state nudges toward
 *  New space / Import folder. */
function OpenSpaceModal({
  kbRoot,
  homeDir,
  onClose,
  onNewSpace,
  onImportFolder,
}: {
  kbRoot: string;
  homeDir: string;
  onClose: () => void;
  onNewSpace: () => void;
  onImportFolder: (path: string) => void;
}) {
  const { actions } = useApp();
  const [names, setNames] = useState<string[] | null>(null);
  // This modal fetches its own fresh `recent` on mount (below) rather
  // than reading `state.recent` — it needs the available-space list and
  // recents together to build its ordering, current as of open time.
  const [recentNames, setRecentNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootDisplay = kbRoot ? prettifyHome(kbRoot, homeDir) : '~/Documents/StashBase';
  const bridge = useMemo<ElectronBridge | undefined>(
    () => (window as { electron?: ElectronBridge }).electron,
    [],
  );

  const loadSpaces = useCallback(async () => {
    try {
      const [avail, spaceState] = await Promise.all([
        api.listAvailableSpaces(),
        api.getSpace(),
      ]);
      setNames(avail.names);
      // RecentSpace paths are absolute; under the flat invariant
      // the last segment is the space name. Server returns them
      // most-recent-first already.
      setRecentNames(
        (spaceState.recent ?? [])
          .map((r) => r.path.split('/').filter(Boolean).pop() || '')
          .filter(Boolean),
      );
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setNames([]);
    }
  }, []);

  useEffect(() => {
    void loadSpaces();
    const onFocus = () => { void loadSpaces(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [kbRoot, loadSpaces]);

  // Recently-opened first (freshest at top), then everything else
  // alphabetically.
  const ordered = useMemo(() => {
    if (!names) return [];
    const present = new Set(names);
    const seen = new Set<string>();
    const head: string[] = [];
    for (const n of recentNames) {
      if (present.has(n) && !seen.has(n)) {
        head.push(n);
        seen.add(n);
      }
    }
    const rest = names.filter((n) => !seen.has(n));
    return [...head, ...rest];
  }, [names, recentNames]);

  async function pick(n: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.openSpaceByName(n);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function importFolder() {
    if (busy || typeof bridge?.openFolderDialog !== 'function') return;
    setBusy(true);
    setError(null);
    try {
      const picked = await bridge.openFolderDialog({
        title: 'Import folder as space',
        buttonLabel: 'Choose Folder',
        allowCreateDirectory: false,
      });
      if (picked) onImportFolder(picked);
      else setBusy(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell closeOnBackdrop={false} onCancel={busy ? () => { /* swallow during open */ } : onClose}>
      <h3>Open space</h3>
      <p className="modal-hint">
        Spaces in <code>{rootDisplay}</code>.
      </p>
      {names === null ? (
        <div className="modal-hint">Loading…</div>
      ) : names.length === 0 ? (
        <div className="welcome-open-empty">
          <div className="modal-hint">
            No spaces yet.
          </div>
          <div className="modal-actions welcome-open-empty-actions">
            <button type="button" className="modal-btn primary" onClick={onNewSpace} disabled={busy}>
              New space
            </button>
            {typeof bridge?.openFolderDialog === 'function' && (
              <button type="button" className="modal-btn" onClick={() => { void importFolder(); }} disabled={busy}>
                Import folder
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="welcome-open-list">
          {ordered.map((n) => (
            <button
              key={n}
              type="button"
              className="welcome-open-row"
              disabled={busy}
              onClick={() => { void pick(n); }}
            >
              <FolderIcon className="welcome-open-row-icon" />
              <span className="welcome-open-row-name">{n}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
          {busy ? 'Opening…' : 'Cancel'}
        </button>
      </div>
    </ModalShell>
  );
}
