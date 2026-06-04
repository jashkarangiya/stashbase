/**
 * Chrome-row chat toggle — icon-only. Opens / closes the right-side
 * chat panel; on the first open (when no tabs exist) it spawns one tab
 * against the last-used agent (`state.agent`, defaulting to
 * Claude Code) so the panel doesn't sit empty staring at the user.
 */
import { useEffect, useRef } from 'react';
import { api, type AgentsResponse } from '../api';
import { ChatIcon } from '../icons';
import { useApp } from '../store/AppContext';
import type { ChatTab } from '../store/state';

export function ChatToggleButton() {
  const { state, dispatch } = useApp();
  const refreshedRef = useRef(false);

  // Pull the agent registry once per session so the hover title and the
  // chat panel's agent picker reflect what's installed.
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    api.listAgents().then((r: AgentsResponse) => {
      dispatch({ type: 'AGENTS_LOADED', current: r.current, agents: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
  }, [dispatch]);

  const current = state.agents.find((c) => c.id === state.agent);
  const label = current?.label ?? 'Claude Code';

  function toggle() {
    const willOpen = !state.chatOpen;
    dispatch({ type: 'CHAT_TOGGLE' });
    // First open ever (or after a space switch) leaves the panel
    // empty — auto-spawn a default tab so it's immediately useful.
    if (willOpen && state.chatTabs.length === 0) {
      const agentId = state.agent || 'claude';
      const tab: ChatTab = {
        id: crypto.randomUUID(),
        agent: agentId,
        title: current?.label ?? agentId,
      };
      dispatch({ type: 'CHAT_TAB_NEW', tab });
    }
  }

  return (
    <button
      className={'icon-btn chat-toggle' + (state.chatOpen ? ' active' : '')}
      type="button"
      title={state.chatOpen ? `Hide ${label}` : `Open ${label}`}
      onClick={toggle}
    >
      <ChatIcon />
    </button>
  );
}
