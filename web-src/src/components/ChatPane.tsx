/**
 * Right-side chat panel — Cursor-style tabbed chats. Each tab in
 * `state.chatTabs` renders a structured agent panel. Claude routes to the
 * Claude Agent SDK bridge; Codex routes to the Codex app-server bridge.
 * All tabs stay mounted at once so switching preserves each session's
 * state (inactive tabs are absolutely-positioned + `visibility: hidden`).
 * New tabs are spawned from the chrome-row agent launchers (see
 * ChatLaunchButtons) — this panel just renders + switches between them.
 */
import { AgentView } from './AgentView';
import { agentMeta, isAgentKind } from '../agentCatalog';
import { useApp } from '../store/AppContext';

/** Brand glyph for a tab's agent, shown before its title. */
function AgentGlyph({ agent }: { agent: string }) {
  const Icon = agentMeta(agent).Icon;
  return <Icon className="chat-tab-icon" />;
}

export function ChatPane() {
  const { state, dispatch } = useApp();
  const space = state.space;
  const tabs = state.chatTabs;
  const activeId = state.activeChatTabId;

  if (!space) return null;

  return (
    <div className="chat-pane-shell">
      <div className="chat-tabs">
        <div className="chat-tabs-list">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={'chat-tab' + (tab.id === activeId ? ' active' : '')}
              role="tab"
              aria-selected={tab.id === activeId}
              onClick={() => dispatch({ type: 'CHAT_TAB_ACTIVATE', id: tab.id })}
              title={tab.title}
            >
              <AgentGlyph agent={tab.agent} />
              <span className="chat-tab-label">{tab.title}</span>
              <button
                type="button"
                className="chat-tab-close"
                aria-label={`Close ${tab.title}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'CHAT_TAB_CLOSE', id: tab.id });
                }}
              >×</button>
            </div>
          ))}
        </div>
      </div>
      <div className="chat-tabs-body">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={'chat-tab-pane' + (tab.id === activeId ? ' active' : '')}
            role="tabpanel"
            aria-hidden={tab.id !== activeId}
          >
            <AgentView
              active={tab.id === activeId}
              id={tab.id}
              title={tab.title}
              agent={isAgentKind(tab.agent) ? tab.agent : 'claude'}
            />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="chat-pane status">
            No active chat. Click the <strong>Claude</strong> or
            {' '}<strong>Codex</strong> button in the top bar to start one.
          </div>
        )}
      </div>
    </div>
  );
}
