import { useState } from 'react';
import { CubeLogoIcon, FolderIcon, GitCloneIcon, NewFolderIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { CloneRepoModal } from './CloneRepoModal';
import { openMcpSettings } from './McpSettingsButton';

interface ElectronAPI {
  openFolderDialog?: (opts: { title?: string; buttonLabel?: string }) => Promise<string | null>;
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

/**
 * Landing overlay shown when no space is open (or after the user
 * explicitly goes home). Calls into the Electron-side folder picker,
 * falling back to a clear "run desktop app" message when the bridge
 * isn't exposed (i.e. when the page is loaded in a plain browser).
 *
 * Three primary actions (matches VS Code's welcome): Open / New / Clone.
 */
export function Welcome() {
  const { state, actions, dispatch } = useApp();
  const [cloneOpen, setCloneOpen] = useState(false);

  if (!state.welcomeVisible) return null;

  async function pickAndOpen(mode: 'open' | 'new') {
    const bridge = window.electron;
    if (!bridge?.openFolderDialog) {
      dispatch({
        type: 'WELCOME_ERROR',
        error:
          'Folder picker requires the desktop app. Run `npm run electron`.',
      });
      return;
    }
    // Both modes call the same OS folder picker — the dialog itself
    // exposes a "New Folder" button at the bottom-left so a "new space"
    // flow doesn't need a separate API. Only the dialog title differs
    // so the user gets a hint that "create new folder here" is expected.
    const picked = await bridge.openFolderDialog({
      title: mode === 'new' ? 'New space — pick or create a folder' : 'Open a space',
      buttonLabel: mode === 'new' ? 'Use folder' : 'Open',
    });
    if (picked) await actions.openSpace(picked);
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
            Your own knowledge base, indexed for AI. Supports HTML and Markdown.
          </div>
        </div>

        <div className="welcome-actions">
          <button className="welcome-action" type="button" onClick={() => pickAndOpen('open')}>
            <span className="welcome-action-icon">
              <FolderIcon />
            </span>
            <span className="welcome-action-label">Open space</span>
          </button>
          <button className="welcome-action" type="button" onClick={() => pickAndOpen('new')}>
            <span className="welcome-action-icon">
              <NewFolderIcon />
            </span>
            <span className="welcome-action-label">New space</span>
          </button>
          <button className="welcome-action" type="button" onClick={openClone}>
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
              Use MCP Settings to connect StashBase to Claude Code, Codex, Cursor, Gemini, and other MCP clients.
            </div>
          </div>
          <button className="welcome-mcp-btn" type="button" onClick={openMcpSettings}>
            Open MCP Settings
          </button>
        </div>

        {state.recent.length > 0 && (
          <div className="welcome-recent">
            <div className="welcome-recent-head">Recent spaces</div>
            <div className="welcome-recent-list">
              {state.recent.map((r) => {
                const name = r.path.split('/').filter(Boolean).pop() || r.path;
                return (
                  <div
                    key={r.path}
                    className="welcome-recent-row"
                    onClick={() => { void actions.openSpace(r.path); }}
                  >
                    <span className="welcome-recent-name">{name}</span>
                    <span className="welcome-recent-path">{prettifyHome(r.path, state.homeDir)}</span>
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
