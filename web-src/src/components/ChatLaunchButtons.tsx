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
import { useEffect, useRef, type ComponentType } from 'react';
import { api, type AgentsResponse } from '../api';
import { ClaudeIcon, CodexIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { useHoverTip } from '../hooks/useHoverTip';
import type { ChatTab } from '../store/state';

/** Agents that get their own chrome launcher, in left→right display
 *  order. Each pairs an agent id with its brand glyph; the label feeds
 *  the hover title and the spawned tab's name. Claude opens the
 *  structured SDK panel; Codex opens a "Coming soon" placeholder until
 *  its panel is built (see design-docs/chat-panel.md). */
const LAUNCHERS = [
  { id: 'claude', label: 'Claude Code', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', Icon: CodexIcon },
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
    // Remember which agent we just opened so the panel's split button
    // defaults to it. Persisted best-effort.
    if (agentId !== state.agent) {
      dispatch({ type: 'AGENT_SET', id: agentId });
      api.setAgent(agentId).catch(() => { /* best-effort */ });
    }
  }

  return (
    <div className="chat-launchers">
      {LAUNCHERS.map(({ id, label, Icon }) => (
        <LaunchButton
          key={id}
          label={`New ${label} chat`}
          Icon={Icon}
          active={state.chatOpen && activeTab?.agent === id}
          onClick={() => launch(id)}
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
  label,
  Icon,
  active,
  onClick,
}: {
  label: string;
  Icon: ComponentType;
  active: boolean;
  onClick: () => void;
}) {
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
