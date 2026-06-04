/**
 * Chrome-row chat launchers — one icon-only button per agent (Claude,
 * Codex), VSCode-style. Each click opens the right-side chat panel and
 * spawns a fresh window (tab) for that agent — clicking repeatedly piles
 * up parallel sessions, the way opening a new editor window does. The
 * panel folds itself back up once the user closes the last tab (handled
 * in the reducer's CHAT_TAB_CLOSE), so there's no separate hide switch.
 *
 * The clicked agent becomes the remembered default (`state.agent`), so
 * the chat panel's split button and a `+` there default to it next.
 */
import { useEffect, useRef } from 'react';
import { api, type AgentsResponse } from '../api';
import { ClaudeIcon, CodexIcon } from '../icons';
import { useApp } from '../store/AppContext';
import type { ChatTab } from '../store/state';

/** Agents that get their own chrome launcher, in left→right display
 *  order. Each pairs an agent id with its brand glyph; the label feeds
 *  the hover title and the spawned tab's name. `mode` picks the render:
 *  Claude gets the structured SDK panel, Codex stays the raw terminal
 *  (see design-docs/chat-panel.md). */
const LAUNCHERS = [
  { id: 'claude', label: 'Claude Code', Icon: ClaudeIcon, mode: 'agent' as const },
  { id: 'codex', label: 'Codex', Icon: CodexIcon, mode: 'terminal' as const },
];

export function ChatLaunchButtons() {
  const { state, dispatch } = useApp();
  const refreshedRef = useRef(false);

  // Pull the agent registry once per session so the chat panel's agent
  // picker reflects what's installed. (The launchers themselves render a
  // fixed Claude + Codex pair regardless.)
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    api.listAgents().then((r: AgentsResponse) => {
      dispatch({ type: 'AGENTS_LOADED', current: r.current, agents: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
  }, [dispatch]);

  const activeTab = state.chatTabs.find((t) => t.id === state.activeChatTabId);

  function launch(agentId: string, label: string, mode: ChatTab['mode']) {
    if (!state.chatOpen) dispatch({ type: 'CHAT_TOGGLE' });
    // Always spawn a fresh window. Title disambiguates duplicates of the
    // same agent — the first gets the bare label, copies append " 2",
    // " 3", … (mirrors the chat panel's `+` button).
    const sameAgent = state.chatTabs.filter((t) => t.agent === agentId);
    const title = sameAgent.length === 0 ? label : `${label} ${sameAgent.length + 1}`;
    const tab: ChatTab = { id: crypto.randomUUID(), agent: agentId, title, mode };
    dispatch({ type: 'CHAT_TAB_NEW', tab });
    // Remember which agent we just opened so the panel's split button
    // defaults to it. Persisted best-effort.
    if (agentId !== state.agent) {
      dispatch({ type: 'AGENT_SET', id: agentId });
      api.setAgent(agentId).catch(() => { /* best-effort */ });
    }
  }

  return (
    <div className="chat-launchers">
      {LAUNCHERS.map(({ id, label, Icon, mode }) => {
        const showing = state.chatOpen && activeTab?.agent === id;
        return (
          <button
            key={id}
            className={'icon-btn chat-launch' + (showing ? ' active' : '')}
            type="button"
            title={`New ${label} chat`}
            onClick={() => launch(id, label, mode)}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
