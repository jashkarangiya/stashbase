/**
 * Right-side chat panel — Cursor-style tabbed chats. Each tab in
 * `state.chatTabs` owns its own PTY + xterm; all tabs render at
 * once so switching preserves scrollback (inactive tabs are
 * absolutely-positioned + `visibility: hidden`). New tabs are spawned
 * from the chrome-row agent launchers (see ChatLaunchButtons) — this
 * panel just renders + switches between the tabs they create.
 *
 * Per tab the lifecycle is:
 *   1. agent binary detected → connect WS, shell opens, runs the binary
 *   2. agent missing → install card with "Install for me" + manual copy
 *   3. Installing → SSE-streamed npm log; flips back to (1) on success
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, getWindowId, type Agent, type AgentsResponse } from '../api';
import { FILE_MIME } from '../dragMime';
import { AgentView } from './AgentView';
import { useApp } from '../store/AppContext';

type DetectState =
  | { kind: 'loading' }
  | { kind: 'installed'; agent: Agent }
  | { kind: 'missing'; agent: Agent }
  | { kind: 'installing'; agent: Agent; log: string }
  | { kind: 'install-failed'; agent: Agent; error: string; log: string };

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
            {tab.mode === 'agent'
              ? <AgentView active={tab.id === activeId} title={tab.title} />
              : <ChatTabBody space={space} agentId={tab.agent} active={tab.id === activeId} />}
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

/** Body of a single tab. Owns its agent-detection state + xterm
 *  instance. Detection re-runs only when the space changes — each tab
 *  is locked to its `agentId` at creation. */
function ChatTabBody({
  space,
  agentId,
  active,
}: {
  space: string;
  agentId: string;
  active: boolean;
}) {
  const [detect, setDetect] = useState<DetectState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setDetect({ kind: 'loading' });
    api.listAgents().then((res: AgentsResponse) => {
      if (cancelled) return;
      const agent = res.clis.find((c) => c.id === agentId) ?? res.clis[0];
      if (!agent) return;
      setDetect({ kind: agent.installed ? 'installed' : 'missing', agent });
    }).catch(() => {
      if (!cancelled) {
        setDetect({
          kind: 'missing',
          agent: {
            id: agentId,
            label: agentId,
            vendor: '',
            installHint: '',
            installed: false,
            launchCommand: '',
          },
        });
      }
    });
    // Mirror `skills/<name>/SKILL.md` into the active agent's per-project
    // prompt directory — fire-and-forget, idempotent.
    if (agentId === 'claude' || agentId === 'codex') {
      api.syncSkills(agentId).catch(() => { /* silent */ });
    }
    return () => { cancelled = true; };
  }, [space, agentId]);

  function recheck(agent: Agent) {
    setDetect({ kind: 'loading' });
    api.checkAgent(agent.id).then((r) => {
      setDetect({ kind: r.installed ? 'installed' : 'missing', agent });
    }).catch(() => setDetect({ kind: 'missing', agent }));
  }

  function startInstall(agent: Agent) {
    setDetect({ kind: 'installing', agent, log: '' });
    const es = new EventSource('/api/terminal/install/' + encodeURIComponent(agent.id));
    let log = '';
    const append = (txt: string) => {
      log += txt;
      setDetect({ kind: 'installing', agent, log });
    };
    es.addEventListener('out', (e: MessageEvent) => append(e.data + '\n'));
    es.addEventListener('err', (e: MessageEvent) => append(e.data + '\n'));
    es.addEventListener('exit', (e: MessageEvent) => {
      es.close();
      const payload = JSON.parse(e.data) as { code: number | null };
      if (payload.code === 0) {
        recheck(agent);
      } else {
        setDetect({
          kind: 'install-failed',
          agent,
          error: `npm install exited with code ${payload.code}`,
          log,
        });
      }
    });
  }

  if (detect.kind === 'loading') {
    return <div className="chat-pane status">Checking…</div>;
  }
  if (detect.kind === 'missing' || detect.kind === 'install-failed') {
    return (
      <InstallCard
        agent={detect.agent}
        error={detect.kind === 'install-failed' ? detect.error : null}
        log={detect.kind === 'install-failed' ? detect.log : null}
        onInstall={() => startInstall(detect.agent)}
        onRetry={() => recheck(detect.agent)}
      />
    );
  }
  if (detect.kind === 'installing') {
    return <InstallProgress agent={detect.agent} log={detect.log} />;
  }
  return <XtermView space={space} launchCmd={detect.agent.launchCommand} active={active} />;
}

/** Renders xterm + connects to /ws/terminal. Each tab gets its own
 *  WebSocket → PTY pair. `active` is forwarded so we can refit when
 *  the tab is brought back to the front (a hidden xterm doesn't
 *  receive ResizeObserver hits while its host is visibility:hidden +
 *  absolutely positioned with stale dimensions). */
function XtermView({
  space,
  launchCmd,
  active,
}: {
  space: string;
  launchCmd: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: [
        '"MesloLGS NF"',
        '"FiraCode Nerd Font"',
        '"JetBrainsMono Nerd Font"',
        '"Hack Nerd Font"',
        '"Iosevka Nerd Font"',
        'ui-monospace',
        'SFMono-Regular',
        '"SF Mono"',
        'Menlo',
        'Consolas',
        'monospace',
      ].join(', '),
      cursorBlink: true,
      // Light-background theme to match the rest of the app — StashBase
      // is a knowledge-base, not a developer tool, so a user who isn't
      // a programmer shouldn't get a "VS Code dark terminal" panel
      // popping out beside their notes. The ANSI 16 colours below are
      // re-tuned for legibility on white (xterm.js's defaults are
      // calibrated for dark backgrounds — `brightWhite` ≈ #ffffff
      // disappears entirely, plain `yellow` is illegible). Palette
      // inspired by Atom One Light. The server also exports
      // `COLORFGBG=0;15` so adaptive CLIs (Claude Code, vim, fzf, …)
      // pick the right rendering automatically.
      theme: {
        background: '#fafafa',
        foreground: '#262626',
        cursor: '#0891b2',
        cursorAccent: '#fafafa',
        selectionBackground: 'rgba(8, 145, 178, 0.25)',
        black: '#000000',
        red: '#e45649',
        green: '#50a14f',
        yellow: '#c18401',
        blue: '#4078f2',
        magenta: '#a626a4',
        cyan: '#0184bc',
        // "white" in ANSI = the dim text colour. On a light bg it has
        // to be darker than the background, not lighter — flip it from
        // the conventional #d3d7cf to a mid-grey that reads.
        white: '#a0a1a7',
        brightBlack: '#5c6370',
        brightRed: '#ca1243',
        brightGreen: '#50a14f',
        brightYellow: '#986801',
        brightBlue: '#4078f2',
        brightMagenta: '#a626a4',
        brightCyan: '#0184bc',
        // Same flip as `white`: `brightWhite` on a light bg can't be
        // #ffffff or it vanishes. Map to a deeper grey so apps that
        // use bright-white for "bold neutral text" stay legible.
        brightWhite: '#383a42',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?windowId=${encodeURIComponent(getWindowId())}`;
    const ws = new WebSocket(wsUrl);
    let opened = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'open',
        cols: term.cols,
        rows: term.rows,
        run: launchCmd,
      }));
    };
    ws.onmessage = (e) => {
      let msg: { type: string; data?: string; error?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'data' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'open-ok') {
        opened = true;
      } else if (msg.type === 'open-fail') {
        term.write(`\r\n\x1b[31mFailed to open terminal: ${msg.error ?? ''}\x1b[0m\r\n`);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[2m[shell exited]\x1b[0m\r\n');
      }
    };
    ws.onclose = () => {
      if (!opened) {
        term.write('\r\n\x1b[31mDisconnected before shell started.\x1b[0m\r\n');
      } else {
        // Server-initiated close (most commonly: user switched spaces,
        // which kills the PTY because the cwd is now wrong). Tell the
        // user the next move instead of leaving them with a frozen
        // panel — close this tab and click `+` for a fresh one.
        term.write('\r\n\x1b[2mSession ended. Close this tab and click + to start a new one.\x1b[0m\r\n');
      }
    };

    const stdinDisposer = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }));
      }
    });
    const resizeDisposer = term.onResize(({ cols, rows }) => {
      // Guard against the panel being collapsed (column width → 0).
      // FitAddon happily proposes cols=0 / rows=0 when the host is
      // hidden, and most shells (zsh, bash) treat resize-to-zero as
      // garbage — line editing breaks until the next non-zero resize.
      // We send only sane sizes; xterm's internal state still updates
      // either way, so the next non-zero resize after re-expand fires.
      if (cols < 1 || rows < 1) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* container detached */ }
    });
    ro.observe(host);

    // Drop sidebar files onto the chat panel → insert their
    // space-relative path at the cursor. Same FILE_MIME the sidebar
    // uses for intra-tree moves, so dragging a row from FileTree
    // straight into Claude Code's slash-command prompt drops
    // `/level1 <path>` in one motion.
    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer) return;
      if (!e.dataTransfer.types.includes(FILE_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      // Sidebar's drag source sets `effectAllowed = 'move'`. The
      // browser silently cancels the drop when dropEffect isn't in
      // that allow-list, which is why 'copy' produced dragover-but-
      // no-drop. 'move' is semantically wrong (we're copying text,
      // not consuming the source) but functionally fine since the
      // source has no dragend handler that would react to it.
      e.dataTransfer.dropEffect = 'move';
    }
    function onDrop(e: DragEvent) {
      if (!e.dataTransfer) return;
      const path = e.dataTransfer.getData(FILE_MIME);
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      if (ws.readyState !== WebSocket.OPEN) return;
      const needsQuote = /[\s'"\\$`!*?()<>|&;]/.test(path);
      const safe = needsQuote ? `'${path.replace(/'/g, `'\\''`)}'` : path;
      ws.send(JSON.stringify({ type: 'stdin', data: safe }));
      term.focus();
    }
    // Capture phase so we run BEFORE xterm.js's own drag handlers.
    host.addEventListener('dragover', onDragOver, true);
    host.addEventListener('drop', onDrop, true);

    return () => {
      ro.disconnect();
      stdinDisposer.dispose();
      resizeDisposer.dispose();
      host.removeEventListener('dragover', onDragOver, true);
      host.removeEventListener('drop', onDrop, true);
      try { ws.send(JSON.stringify({ type: 'close' })); } catch { /* gone */ }
      ws.close();
      term.dispose();
      fitRef.current = null;
    };
  }, [space, launchCmd]);

  // When a hidden tab becomes active again, the host's effective size
  // may have changed (panel resized, sibling tabs spawned). Refit on
  // the active→true transition so xterm picks up the new dimensions.
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    if (!fit) return;
    try { fit.fit(); } catch { /* host detached mid-frame */ }
  }, [active]);

  return <div className="chat-pane xterm-host" ref={containerRef} />;
}

function InstallCard({
  agent, error, log, onInstall, onRetry,
}: {
  agent: Agent;
  error: string | null;
  log: string | null;
  onInstall: () => void;
  onRetry: () => void;
}) {
  const cmd = agent.installHint;
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="chat-pane install-card">
      <div className="install-card-title">{agent.label} not found</div>
      <p className="install-card-hint">
        We couldn't find the <code>{agent.id}</code> CLI on your PATH. Install
        it and we'll connect it here.
      </p>
      <div className="install-card-cmd">
        <code>{cmd}</code>
        <button type="button" className="install-card-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {error && (
        <div className="modal-error">{error}</div>
      )}
      {log && (
        <pre className="install-card-log">{log}</pre>
      )}
      <div className="install-card-actions">
        <button type="button" className="modal-btn" onClick={onRetry}>
          I already installed it
        </button>
        <button type="button" className="modal-btn primary" onClick={onInstall}>
          Install for me
        </button>
      </div>
      <p className="install-card-foot">
        "Install for me" runs the command above in the background. You may
        be prompted for your password if npm needs elevated permissions.
      </p>
    </div>
  );
}

function InstallProgress({ agent, log }: { agent: Agent; log: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  return (
    <div className="chat-pane install-progress">
      <div className="install-card-title">Installing {agent.label}…</div>
      <pre ref={ref} className="install-card-log live">{log || '…'}</pre>
    </div>
  );
}
