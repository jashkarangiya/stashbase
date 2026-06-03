/**
 * Chrome-row terminal toggle — icon-only. Opens / closes the right-side
 * chat panel; on the first open (when no tabs exist) it spawns one tab
 * against the last-used agent (`state.terminalCli`, defaulting to
 * Claude Code) so the panel doesn't sit empty staring at the user.
 */
import { useEffect, useRef } from 'react';
import { api, type TerminalClisResponse } from '../api';
import { TerminalIcon } from '../icons';
import { useApp } from '../store/AppContext';
import type { TerminalTab } from '../store/state';

export function TerminalToggleButton() {
  const { state, dispatch } = useApp();
  const refreshedRef = useRef(false);

  // Pull the agent registry once per session so the hover title and the
  // chat panel's agent picker reflect what's installed.
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    api.listClis().then((r: TerminalClisResponse) => {
      dispatch({ type: 'TERMINAL_CLIS', current: r.current, clis: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
  }, [dispatch]);

  const current = state.terminalClis.find((c) => c.id === state.terminalCli);
  const label = current?.label ?? 'Claude Code';

  function toggle() {
    const willOpen = !state.terminalOpen;
    dispatch({ type: 'TERMINAL_TOGGLE' });
    // First open ever (or after a space switch) leaves the panel
    // empty — auto-spawn a default tab so it's immediately useful.
    if (willOpen && state.terminalTabs.length === 0) {
      const cliId = state.terminalCli || 'claude';
      const tab: TerminalTab = {
        id: crypto.randomUUID(),
        cli: cliId,
        title: current?.label ?? cliId,
      };
      dispatch({ type: 'TERMINAL_TAB_NEW', tab });
    }
  }

  return (
    <button
      className={'icon-btn terminal-toggle' + (state.terminalOpen ? ' active' : '')}
      type="button"
      title={state.terminalOpen ? `Hide ${label}` : `Open ${label}`}
      onClick={toggle}
    >
      <TerminalIcon />
    </button>
  );
}
