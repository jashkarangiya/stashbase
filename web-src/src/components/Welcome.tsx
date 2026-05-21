import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { CubeLogoIcon, FolderIcon, GitCloneIcon, NewFolderIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { CloneRepoModal } from './CloneRepoModal';
import { openSettings } from './SettingsModal';

interface ElectronAPI {
  openFolderDialog?: (opts: {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
  }) => Promise<string | null>;
}
declare global {
  interface Window { electron?: ElectronAPI }
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

/** Shared canvas context for text measurement. Cached so we don't
 *  pay the alloc per row × per resize. */
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!_measureCtx) {
    _measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  return _measureCtx;
}

/** VSCode-style middle ellipsis: drops chars from the middle, keeping
 *  the prefix and suffix visible (`StashBase/work/…/2024/Q3`). Uses
 *  canvas `measureText` for measurement and `ResizeObserver` to recompute
 *  on width changes. Falls back to the full string when it fits. */
function MiddleEllipsis({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [out, setOut] = useState(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      const w = el.clientWidth;
      if (!w) return;
      const style = window.getComputedStyle(el);
      const ctx = measureCtx();
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (ctx.measureText(text).width <= w) {
        setOut(text);
        return;
      }
      const target = w - ctx.measureText('…').width;
      const len = text.length;
      // Binary search over symmetric prefix+suffix lengths.
      let lo = 0;
      let hi = Math.floor(len / 2);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const probe = text.slice(0, mid) + text.slice(len - mid);
        if (ctx.measureText(probe).width <= target) lo = mid;
        else hi = mid - 1;
      }
      setOut(lo > 0 ? `${text.slice(0, lo)}…${text.slice(len - lo)}` : '…');
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return <span ref={ref} className={className} title={text}>{out}</span>;
}

/** Path label for a recent space row — VSCode-style: shows only the
 *  containing directory chain, not the space's own folder name (that's
 *  the name column to the left):
 *
 *    `<kbRoot>/Notes`            → `StashBase`
 *    `<kbRoot>/work/proj`        → `StashBase/work`
 *    `<kbRoot>/work/2024/proj`   → `StashBase/work/2024`
 *
 *  Falls back to home-relative if the path isn't under kbRoot (legacy
 *  entries, or kbRoot not yet fetched on first paint). */
function spacePathLabel(spaceAbs: string, kbRoot: string, home: string): string {
  if (!kbRoot) return prettifyHome(spaceAbs, home);
  const rootWithSep = kbRoot.endsWith('/') ? kbRoot : kbRoot + '/';
  if (!spaceAbs.startsWith(rootWithSep)) return prettifyHome(spaceAbs, home);
  const rootName = kbRoot.split('/').filter(Boolean).pop() || 'StashBase';
  const parts = spaceAbs.slice(rootWithSep.length).split('/');
  const parent = parts.slice(0, -1).join('/');
  return parent ? `${rootName}/${parent}` : rootName;
}

/**
 * Landing overlay shown when no space is open (or after the user
 * explicitly goes home). All spaces must live under the library root
 * (`~/Documents/StashBase/` by default).
 *
 * Open / New / Clone all use the native OS folder dialog with
 * `defaultPath = kbRoot` so the user lands in the right place and can
 * use the "New Folder" affordance. The picker is unrestricted (it'd
 * be a worse UX to disable the rest of the filesystem), so we
 * validate the pick is under kbRoot client-side; the server
 * re-validates inside `setCurrentSpace`.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [kbRoot, setKbRoot] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);

  // Fetch the kbRoot once the welcome screen mounts so the OS dialog
  // can seed `defaultPath` and so we can validate picks client-side.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api.getKbRoot();
        setKbRoot(r.path);
      } catch (err) {
        dispatch({ type: 'WELCOME_ERROR', error: errorMessage(err) });
      }
    })();
  }, [dispatch]);

  if (!state.welcomeVisible) return null;

  async function pickAndOpen(mode: 'open' | 'new') {
    const bridge = window.electron;
    if (!bridge?.openFolderDialog) {
      dispatch({
        type: 'WELCOME_ERROR',
        error: 'Folder picker requires the desktop app. Run `npm run electron`.',
      });
      return;
    }
    if (!kbRoot) {
      dispatch({ type: 'WELCOME_ERROR', error: 'Library root not loaded yet — try again in a moment.' });
      return;
    }
    // The dialog title hints at which affordance to use; the actual
    // dialog is identical (createDirectory is always enabled).
    const picked = await bridge.openFolderDialog({
      title: mode === 'new' ? 'New space — pick or create a folder' : 'Open a space',
      buttonLabel: mode === 'new' ? 'Use folder' : 'Open',
      defaultPath: kbRoot,
    });
    if (!picked) return;
    // Enforce the kbRoot invariant: must be the root itself's child or
    // deeper (the root itself is a container, not openable as a space).
    const rootWithSep = kbRoot.endsWith('/') ? kbRoot : kbRoot + '/';
    if (picked === kbRoot || !picked.startsWith(rootWithSep)) {
      dispatch({
        type: 'WELCOME_ERROR',
        error: `Spaces must live under ${prettifyHome(kbRoot, state.homeDir ?? '')}.`,
      });
      return;
    }
    await actions.openSpace(picked);
  }

  function openClone() {
    if (!window.electron?.openFolderDialog) {
      dispatch({
        type: 'WELCOME_ERROR',
        error: 'Clone requires the desktop app. Run `npm run electron`.',
      });
      return;
    }
    setCloneOpen(true);
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-logo">
            <CubeLogoIcon />
          </div>
          <div className="welcome-title">StashBase</div>
          <div className="welcome-sub">
            Local knowledge base for you and your AI. Continuously indexed,{' '}
            <span style={{ whiteSpace: 'nowrap' }}>MCP-compatible</span>.
          </div>
        </div>

        <div className="welcome-actions">
          <button
            className="welcome-action"
            type="button"
            onClick={() => pickAndOpen('open')}
            title="Open an existing folder under your library"
          >
            <span className="welcome-action-icon">
              <FolderIcon />
            </span>
            <span className="welcome-action-label">Open space</span>
          </button>
          <button
            className="welcome-action"
            type="button"
            onClick={() => pickAndOpen('new')}
            title="Create a new folder under your library"
          >
            <span className="welcome-action-icon">
              <NewFolderIcon />
            </span>
            <span className="welcome-action-label">New space</span>
          </button>
          <button
            className="welcome-action"
            type="button"
            onClick={openClone}
            title="Clone a git repo (HTTPS or SSH) into your library"
          >
            <span className="welcome-action-icon">
              <GitCloneIcon />
            </span>
            <span className="welcome-action-label">Clone repo</span>
          </button>
        </div>

        <div className="welcome-mcp">
          <div className="welcome-mcp-text">
            <div className="welcome-mcp-title">Connect AI tools</div>
            <div className="welcome-mcp-sub">
              Searchable from Claude, Codex, ChatGPT, and more.
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
              {state.recent.length > 5 && (
                <button
                  className="welcome-recent-more"
                  type="button"
                  onClick={() => setShowAllRecent((v) => !v)}
                >
                  {showAllRecent ? 'Show less' : `Show all (${state.recent.length})`}
                </button>
              )}
            </div>
            <div className="welcome-recent-list">
              {(showAllRecent ? state.recent : state.recent.slice(0, 5)).map((r) => {
                const name = r.path.split('/').filter(Boolean).pop() || r.path;
                return (
                  <div
                    key={r.path}
                    className="welcome-recent-row"
                    onClick={() => { void actions.openSpace(r.path); }}
                  >
                    <span className="welcome-recent-name">{name}</span>
                    <MiddleEllipsis
                      className="welcome-recent-path"
                      text={spacePathLabel(r.path, kbRoot, state.homeDir)}
                    />

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
      {cloneOpen && <CloneRepoModal onClose={() => setCloneOpen(false)} />}
    </div>
  );
}
