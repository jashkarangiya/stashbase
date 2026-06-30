import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  errorMessage,
} from '../api';
import { CubeLogoIcon, FolderIcon, NewFolderIcon } from '../icons';
import { useApp } from '../store/AppContext';
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

/**
 * Landing overlay shown when no folder is open (or after the user
 * explicitly goes home). A folder is opened in place from anywhere on
 * disk; there is no configurable folder home.
 *
 *   - **New folder**: native picker opened at `~/Documents/StashBase`,
 *     with the OS "New Folder" affordance available.
 *   - **Open folder**: native picker to open any folder on disk in place.
 *   - **Your Folders**: the member list (recents) — click to reopen.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [folderHome, setFolderHome] = useState('');
  const [sortBy, setSortBy] = useState<'recent' | 'location'>('recent');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Your Folders = the knowledge-base membership. Default order is
  // most-recently-opened (server returns it MRU); "Location" keeps folders
  // from the same parent directory next to each other.
  const folders = useMemo(() => {
    const list = [...state.recent];
    if (sortBy === 'location') {
      list.sort((a, b) => {
        const aSegs = a.path.split('/').filter(Boolean);
        const bSegs = b.path.split('/').filter(Boolean);
        const aName = aSegs.pop() ?? a.path;
        const bName = bSegs.pop() ?? b.path;
        const aParent = aSegs.join('/');
        const bParent = bSegs.join('/');
        const parentOrder = aParent.localeCompare(bParent, undefined, { sensitivity: 'base' });
        return parentOrder || aName.localeCompare(bName, undefined, { sensitivity: 'base' });
      });
    }
    return list;
  }, [state.recent, sortBy]);

  const removeFolder = useCallback((path: string) => {
    setRemoving(true);
    void api.removeFolder(path)
      .then(() => api.getFolder())
      .then((j) => dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir }))
      .catch((e) => dispatch({ type: 'WELCOME_ERROR', error: errorMessage(e) }))
      .finally(() => { setRemoving(false); setConfirmRemove(null); });
  }, [dispatch]);

  const refreshFolderHome = useCallback(async () => {
    const r = await api.getFolderHome();
    setFolderHome(r.path);
    return r.path;
  }, []);

  // Fetch folderHome so copy can show `~/Documents/StashBase` as the
  // container path in the hints below the action buttons.
  useEffect(() => {
    void (async () => {
      try {
        await refreshFolderHome();
      } catch (err) {
        dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
      }
    })();
  }, [dispatch, refreshFolderHome]);

  useEffect(() => {
    if (!state.welcomeVisible) return;
    let cancelled = false;
    void Promise.all([api.getFolder(), refreshFolderHome()])
      .then(([j]) => {
        if (cancelled) return;
        dispatch({ type: 'WELCOME_SHOW', recent: j.recent ?? [], homeDir: j.homeDir });
      })
      .catch(() => { /* keep the current welcome state */ });
    return () => { cancelled = true; };
  }, [dispatch, refreshFolderHome, state.welcomeVisible]);

  function openRecent(path: string) {
    void actions.openFolder(path).catch((e) => {
      const msg = errorMessage(e);
      // Remove the failed entry immediately so a stale/deleted path
      // doesn't remain clickable if the server refresh also fails.
      dispatch({
        type: 'WELCOME_SHOW',
        recent: state.recent.filter((r) => r.path !== path),
        homeDir: state.homeDir,
        error: msg,
      });
      void api.getFolder()
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
            Convert your local files into a knowledge base your Agents can search.
          </div>
        </div>

        <div className="welcome-actions">
          <OpenFolderButton />
          <NewFolderButton folderHome={folderHome} refreshFolderHome={refreshFolderHome} />
        </div>

        <div className="welcome-mcp">
          <div className="welcome-mcp-text">
            <div className="welcome-mcp-title">Connect your Agents</div>
            <div className="welcome-mcp-sub">
              Let Claude, Codex, and other agents search your files.
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
              <span>
                Your Folders <span className="welcome-recent-count">({folders.length})</span>
              </span>
              <div className="welcome-recent-head-right">
                <div className="welcome-recent-sort" role="group" aria-label="Sort folders">
                  <button
                    type="button"
                    className={sortBy === 'recent' ? 'is-active' : ''}
                    onClick={() => setSortBy('recent')}
                  >
                    Recent
                  </button>
                  <button
                    type="button"
                    className={sortBy === 'location' ? 'is-active' : ''}
                    onClick={() => setSortBy('location')}
                  >
                    Location
                  </button>
                </div>
              </div>
            </div>
            <div className="welcome-recent-list">
              {folders.map((r) => {
                const segs = r.path.split('/').filter(Boolean);
                const name = segs.pop() || r.path;
                const parent = prettifyHome(segs.length ? '/' + segs.join('/') : '/', state.homeDir ?? '');
                if (confirmRemove === r.path) {
                  return (
                    <div key={r.path} className="welcome-recent-row welcome-recent-row--confirm">
                      <span className="welcome-recent-confirm-text">
                        Remove <strong>{name}</strong>? Its search index is cleared; the folder and its files are left untouched.
                      </span>
                      <button
                        type="button"
                        className="welcome-recent-confirm-yes"
                        disabled={removing}
                        onClick={() => removeFolder(r.path)}
                      >
                        {removing ? 'Removing…' : 'Remove'}
                      </button>
                      <button
                        type="button"
                        className="welcome-recent-confirm-no"
                        disabled={removing}
                        onClick={() => setConfirmRemove(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  );
                }
                return (
                  <div key={r.path} className="welcome-recent-row">
                    <button
                      type="button"
                      className="welcome-recent-open"
                      title={r.path}
                      onClick={() => openRecent(r.path)}
                    >
                      <FolderIcon />
                      <span className="welcome-recent-name">{name}</span>
                      <span className="welcome-recent-path">{parent}</span>
                    </button>
                    <button
                      type="button"
                      className="welcome-recent-remove"
                      title="Remove from Your Folders"
                      aria-label={`Remove ${name} from Your Folders`}
                      onClick={() => setConfirmRemove(r.path)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {state.welcomeError && (
          <div className="welcome-err">{state.welcomeError}</div>
        )}
      </div>
    </div>
  );
}

/** "Open folder" action — pick ANY folder on disk (anywhere, any nesting
 *  level) and open it in place. Nothing is copied: the folder is indexed
 *  where it lives. Browser fallback (no Electron bridge)
 *  hides the button — no portable absolute-path picker. */
function OpenFolderButton() {
  const { actions, dispatch } = useApp();
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
        title: 'Open folder',
        buttonLabel: 'Open',
        allowCreateDirectory: true,
      });
      if (picked) await actions.openFolder(picked);
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
      title="Open any folder on your disk — indexed in place, not copied"
    >
      <span className="welcome-action-icon">
        <FolderIcon />
      </span>
      <span className="welcome-action-label">{busy ? 'Opening…' : 'Open folder'}</span>
    </button>
  );
}

/** Same native picker as Open folder, but starts at the default StashBase
 *  home so the OS panel's New Folder button lands in the expected place. */
function NewFolderButton({
  folderHome,
  refreshFolderHome,
}: {
  folderHome: string;
  refreshFolderHome: () => Promise<string>;
}) {
  const { actions, dispatch } = useApp();
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
      const defaultPath = folderHome || await refreshFolderHome();
      const picked = await bridge!.openFolderDialog!({
        title: 'New folder',
        buttonLabel: 'Open',
        defaultPath,
        allowCreateDirectory: true,
      });
      if (picked) await actions.openFolder(picked);
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
      title="Create or choose a folder under the default StashBase location"
    >
      <span className="welcome-action-icon">
        <NewFolderIcon />
      </span>
      <span className="welcome-action-label">{busy ? 'Opening…' : 'New folder'}</span>
    </button>
  );
}
