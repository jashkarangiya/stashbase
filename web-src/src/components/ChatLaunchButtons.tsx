/**
 * Chrome-row chat launchers — one icon-only button per agent (Claude,
 * Codex), VSCode-style. Each click opens the right-side chat panel and
 * spawns a fresh window (tab) for that agent — clicking repeatedly piles
 * up parallel sessions, the way opening a new editor window does. The
 * panel folds itself back up once the user closes the last tab (handled
 * in the reducer's CHAT_TAB_CLOSE), so there's no separate hide switch.
 *
 */
import { useEffect, useRef } from 'react';
import { api, type AgentsResponse } from '../api';
import { AGENTS, type AgentMeta } from '../agentCatalog';
import { useApp } from '../store/AppContext';
import { useHoverTip } from '../hooks/useHoverTip';
import type { ChatTab } from '../store/state';

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
      dispatch({ type: 'AGENTS_LOADED', agents: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
  }, [dispatch]);

  const activeTab = state.chatTabs.find((t) => t.id === state.activeChatTabId);

  function launch(agentId: string) {
    if (!state.chatOpen) dispatch({ type: 'CHAT_TOGGLE' });
    // Always spawn a fresh window, titled "Untitled" — a real title can
    // come from the conversation later. Duplicates append " 2", " 3", …
    // (mirrors the chat panel's `+` button).
    const base = 'Untitled';
    const sameAgent = state.chatTabs.filter((t) => t.agent === agentId);
    const title = sameAgent.length === 0 ? base : `${base} ${sameAgent.length + 1}`;
    const tab: ChatTab = { id: crypto.randomUUID(), agent: agentId, title };
    dispatch({ type: 'CHAT_TAB_NEW', tab });
  }

  return (
    <div className="chat-launchers">
      {AGENTS.map((agent) => (
        <LaunchButton
          key={agent.id}
          agent={agent}
          active={state.chatOpen && activeTab?.agent === agent.id}
          onClick={() => launch(agent.id)}
        />
      ))}
    </div>
  );
}

/** One launcher. Its own component so `useHoverTip` isn't called in a map
 *  callback. Uses the shared custom tooltip because these live in the
 *  `app-chrome` drag region, where the native `title` tooltip never
 *  appears. Tip drops below — they sit at the top-right of the window. */
function LaunchButton({
  agent,
  active,
  onClick,
}: {
  agent: AgentMeta;
  active: boolean;
  onClick: () => void;
}) {
  const label = `New ${agent.launcherLabel} chat`;
  const Icon = agent.Icon;
  const { tipProps, tip } = useHoverTip(label, 'bottom');
  return (
    <button
      className={'icon-btn chat-launch' + (active ? ' active' : '')}
      type="button"
      aria-label={label}
      onClick={onClick}
      {...tipProps}
    >
      <Icon />
      {tip}
    </button>
  );
}
