/**
 * Structured chat view for a Claude (`mode: 'agent'`) tab — the
 * VSCode-extension-style panel. Connects to `/ws/agent` (SDK-backed,
 * see server/agent.ts) and renders the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions KB files.
 *
 * This is Phase 1 of design-docs/chat-panel.md. Codex stays on the raw
 * terminal (ChatTabBody); only Claude routes here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getWindowId } from '../api';
import { FILE_MIME } from '../dragMime';
import { renderMarkdownInline } from '../markdown';
import { useApp } from '../store/AppContext';
import { getActiveTab, type ChatTab } from '../store/state';
import {
  ChevronDownIcon, ClaudeIcon, HistoryIcon, PlusIcon, FileGenericIcon,
} from '../icons';

// ----- block model -------------------------------------------------------

type ToolStatus = 'running' | 'awaiting' | 'done' | 'error' | 'denied';

interface ToolBlock {
  kind: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
  /** Set while a permission prompt for this tool is pending. */
  permId?: string;
  permTitle?: string | null;
}

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }
  | ToolBlock;

// ----- server → client events -------------------------------------------

type ServerEvent =
  | { t: 'ready' }
  | { t: 'turn-start' }
  | { t: 'text'; delta: string }
  | { t: 'thinking'; delta: string }
  | { t: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { t: 'tool-result'; id: string; content: string; isError: boolean }
  | { t: 'permission'; id: string; toolUseId: string; name: string; title: string | null; input: Record<string, unknown> }
  | { t: 'turn-end'; isError: boolean }
  | { t: 'error'; message: string }
  | { t: 'exit' };

let blockSeq = 0;
const nextId = () => `b${++blockSeq}`;

export function AgentView({ active, title }: { active: boolean; title: string }) {
  const { state, dispatch } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [turnActive, setTurnActive] = useState(false);
  // Connection lifecycle. `connecting` → waiting for the session to come
  // up; `live` → session ready, accepting prompts; `closed` → ended or
  // failed (see `fatal`). `nonce` bumps to force a reconnect.
  const [phase, setPhase] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);

  useEffect(() => {
    readyRef.current = false;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent?windowId=${encodeURIComponent(getWindowId())}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    ws.onclose = () => {
      setTurnActive(false);
      // Closing before the session was ever ready is a startup failure,
      // not a normal end — surface it (with a Retry) rather than a quiet
      // "session ended".
      if (!readyRef.current) setFatal((f) => f ?? 'Connection closed before Claude started.');
      setPhase('closed');
    };

    return () => {
      // Detach onclose so the reconnect path's teardown doesn't clobber
      // the fresh 'connecting' state with a stale 'closed'.
      ws.onclose = null;
      try { ws.send(JSON.stringify({ t: 'close' })); } catch { /* gone */ }
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  /** Tear down and start a fresh session (Retry button / after the user
   *  reopens a space). */
  function reconnect() {
    setBlocks([]);
    setFatal(null);
    setTurnActive(false);
    openKind.current = null;
    setPhase('connecting');
    setNonce((n) => n + 1);
  }

  function handleEvent(ev: ServerEvent) {
    switch (ev.t) {
      case 'ready':
        readyRef.current = true;
        setPhase('live');
        break;
      case 'turn-start':
        openKind.current = null;
        setTurnActive(true);
        break;
      case 'text':
        appendStream('assistant', ev.delta);
        break;
      case 'thinking':
        appendStream('thinking', ev.delta);
        break;
      case 'tool':
        openKind.current = null;
        setBlocks((bs) => [...bs, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
        break;
      case 'tool-result':
        setBlocks((bs) => bs.map((b) =>
          b.kind === 'tool' && b.id === ev.id && b.status !== 'denied'
            ? { ...b, status: ev.isError ? 'error' : 'done', result: ev.content }
            : b));
        break;
      case 'permission':
        openKind.current = null;
        setBlocks((bs) => {
          const idx = bs.findIndex((b) => b.kind === 'tool' && b.id === ev.toolUseId);
          if (idx >= 0) {
            const next = bs.slice();
            next[idx] = { ...(next[idx] as ToolBlock), status: 'awaiting', permId: ev.id, permTitle: ev.title };
            return next;
          }
          // Race fallback: permission arrived before the tool card.
          return [...bs, { kind: 'tool', id: ev.toolUseId, name: ev.name, input: ev.input, status: 'awaiting', permId: ev.id, permTitle: ev.title }];
        });
        break;
      case 'turn-end':
        openKind.current = null;
        setTurnActive(false);
        break;
      case 'error':
        openKind.current = null;
        setTurnActive(false);
        // An error before the session is ready is fatal (e.g. no space
        // open / not authenticated); mid-session it's just a notice.
        if (!readyRef.current) {
          setFatal(ev.message);
          setPhase('closed');
        } else {
          setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: ev.message }]);
        }
        break;
      case 'exit':
        setTurnActive(false);
        setPhase('closed');
        break;
    }
  }

  function appendStream(kind: 'assistant' | 'thinking', delta: string) {
    setBlocks((bs) => {
      const last = bs[bs.length - 1];
      if (openKind.current === kind && last && (last.kind === 'assistant' || last.kind === 'thinking')) {
        const next = bs.slice();
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      }
      openKind.current = kind;
      return [...bs, { kind, id: nextId(), text: delta }];
    });
  }

  function send(text: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setBlocks((bs) => [...bs, { kind: 'user', id: nextId(), text }]);
    setTurnActive(true);
    openKind.current = null;
    ws.send(JSON.stringify({ t: 'prompt', text }));
  }

  function stop() {
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** Spawn a fresh Claude chat tab (the in-panel `+`, mirroring the
   *  chrome launcher). */
  function newChat() {
    const same = state.chatTabs.filter((t) => t.agent === 'claude');
    const tabTitle = same.length === 0 ? 'Claude Code' : `Claude Code ${same.length + 1}`;
    const tab: ChatTab = { id: crypto.randomUUID(), agent: 'claude', title: tabTitle, mode: 'agent' };
    dispatch({ type: 'CHAT_TAB_NEW', tab });
  }

  // The document the user is currently looking at — shown as a context
  // chip in the composer (display-only in Phase 1).
  const activeFile = getActiveTab(state)?.file?.name ?? null;

  function replyPermission(toolBlockId: string, permId: string, allow: boolean) {
    wsRef.current?.send(JSON.stringify({ t: 'permission-reply', id: permId, allow }));
    setBlocks((bs) => bs.map((b) =>
      b.kind === 'tool' && b.id === toolBlockId
        ? { ...b, status: allow ? 'running' : 'denied', permId: undefined }
        : b));
  }

  return (
    <div className="agent-view">
      <div className="agent-head">
        <span className="agent-head-title">{title}</span>
        <div className="agent-head-actions">
          <button type="button" className="agent-head-btn" title="History (coming soon)" disabled>
            <HistoryIcon />
          </button>
          <button type="button" className="agent-head-btn" title="New Claude chat" onClick={newChat}>
            <PlusIcon />
          </button>
        </div>
      </div>
      <MessageList blocks={blocks} turnActive={turnActive} phase={phase} onPermission={replyPermission} />
      {phase === 'closed' && (
        fatal
          ? (
            <div className="agent-fatal">
              <span className="agent-fatal-msg">
                {/No space open/i.test(fatal)
                  ? 'No space is open. Open a space, then retry.'
                  : `Couldn't start Claude: ${fatal}`}
              </span>
              <button type="button" className="agent-btn" onClick={reconnect}>Retry</button>
            </div>
          )
          : <div className="agent-ended">Session ended. Reopen Claude from the top bar.</div>
      )}
      <Composer
        disabled={phase !== 'live'}
        turnActive={turnActive}
        active={active}
        activeFile={activeFile}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

/** Rotating hint shown in the empty state. StashBase-flavored — points at
 *  features that actually exist (drag, @, diffs). */
const TIPS = [
  'Drag a file from the sidebar to have Claude work on it',
  'Type @ to reference any file in your KB',
  'Claude works in your current space — changes land on disk',
  'You get a diff to approve before any file is written',
  'Enter to send, Shift+Enter for a new line',
];

// ----- message list ------------------------------------------------------

function MessageList({
  blocks, turnActive, phase, onPermission,
}: {
  blocks: Block[];
  turnActive: boolean;
  phase: 'connecting' | 'live' | 'closed';
  onPermission: (toolBlockId: string, permId: string, allow: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Track whether the user is pinned to the bottom; only autoscroll then.
  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  return (
    <div className="agent-messages" ref={ref} onScroll={onScroll}>
      {blocks.length === 0 && phase === 'live' && <Hero />}
      {phase === 'connecting' && <div className="agent-empty">Connecting to Claude…</div>}
      {blocks.map((b) => <BlockView key={b.id} block={b} onPermission={onPermission} />)}
      {turnActive && <div className="agent-working"><span className="agent-dot" />Claude is working…</div>}
    </div>
  );
}

/** Empty-state hero: Claude Code wordmark, a pixel mascot, and a tip
 *  that rotates every few seconds. */
function Hero() {
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 6000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="agent-hero">
      <div className="agent-hero-wordmark">
        <ClaudeIcon className="agent-hero-mark" />
        <span className="agent-hero-name">Claude Code</span>
      </div>
      <PixelMascot />
      <div className="agent-hero-tip">{TIPS[tip]}</div>
    </div>
  );
}

/** A friendly pixel mascot in the Claude coral — our own little blocky
 *  critter (not the official Claude Code sprite), evoking the same vibe
 *  for the empty state. Pure SVG rects on a 9-wide grid. */
function PixelMascot() {
  // (col, row) coordinates of the lit pixels; eyes are punched out.
  const C = '#D97757';
  const px: Array<[number, number]> = [];
  for (let x = 2; x <= 6; x++) for (let y = 1; y <= 4; y++) px.push([x, y]); // head
  px.push([2, 5], [3, 5], [5, 5], [6, 5]); // two feet
  const eyes = new Set(['3,2', '5,2']);
  return (
    <svg className="agent-hero-sprite" viewBox="0 0 9 7" shapeRendering="crispEdges" aria-hidden="true">
      {px.filter(([x, y]) => !eyes.has(`${x},${y}`)).map(([x, y]) => (
        <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={C} />
      ))}
    </svg>
  );
}

function BlockView({ block, onPermission }: { block: Block; onPermission: (t: string, p: string, a: boolean) => void }) {
  switch (block.kind) {
    case 'user':
      return <div className="agent-msg user"><div className="agent-bubble">{block.text}</div></div>;
    case 'assistant':
      return (
        <div className="agent-msg assistant">
          <div className="agent-prose" dangerouslySetInnerHTML={{ __html: renderMarkdownInline(block.text) }} />
        </div>
      );
    case 'thinking':
      return <ThinkingView text={block.text} />;
    case 'error':
      return <div className="agent-error">{block.text}</div>;
    case 'tool':
      return <ToolCard block={block} onPermission={onPermission} />;
  }
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'agent-thinking' + (open ? ' open' : '')}>
      <button type="button" className="agent-thinking-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-thinking-chev" />
        <span>Thinking</span>
      </button>
      {open && <div className="agent-thinking-body">{text}</div>}
    </div>
  );
}

// ----- tool cards + diffs ------------------------------------------------

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'Running',
  awaiting: 'Review',
  done: 'Done',
  error: 'Error',
  denied: 'Denied',
};

function ToolCard({ block, onPermission }: { block: ToolBlock; onPermission: (t: string, p: string, a: boolean) => void }) {
  const [open, setOpen] = useState(block.status === 'awaiting');
  const diff = useMemo(() => buildDiff(block.name, block.input), [block.name, block.input]);
  const summary = toolSummary(block.name, block.input);

  return (
    <div className={'agent-tool status-' + block.status}>
      <button type="button" className="agent-tool-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-tool-chev" />
        <span className="agent-tool-name">{block.name}</span>
        <span className="agent-tool-summary">{summary}</span>
        <span className={'agent-tool-status s-' + block.status}>
          {block.status === 'running' && <span className="agent-dot" />}
          {STATUS_LABEL[block.status]}
        </span>
      </button>

      {block.status === 'awaiting' && block.permId && (
        <div className="agent-perm">
          <div className="agent-perm-title">{block.permTitle ?? `Allow Claude to run ${block.name}?`}</div>
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && (
            <pre className="agent-bash">{String(block.input.command ?? '')}</pre>
          )}
          <div className="agent-perm-actions">
            <button type="button" className="agent-btn ghost" onClick={() => onPermission(block.id, block.permId!, false)}>Reject</button>
            <button type="button" className="agent-btn primary" onClick={() => onPermission(block.id, block.permId!, true)}>Allow</button>
          </div>
        </div>
      )}

      {open && block.status !== 'awaiting' && (
        <div className="agent-tool-body">
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && <pre className="agent-bash">{String(block.input.command ?? '')}</pre>}
          {!diff && block.name !== 'Bash' && (
            <pre className="agent-tool-input">{JSON.stringify(block.input, null, 2)}</pre>
          )}
          {block.result != null && block.result !== '' && (
            <pre className={'agent-tool-result' + (block.status === 'error' ? ' err' : '')}>{clip(block.result)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

type DiffRow = { type: 'ctx' | 'del' | 'add'; text: string };

function DiffView({ diff }: { diff: { file: string; rows: DiffRow[] } }) {
  return (
    <div className="agent-diff">
      <div className="agent-diff-file">{diff.file}</div>
      <div className="agent-diff-body">
        {diff.rows.map((r, i) => (
          <div key={i} className={'agent-diff-row ' + r.type}>
            <span className="agent-diff-gutter">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
            <span className="agent-diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compute a renderable diff from a file-mutating tool's input, or null
 *  when the tool isn't a file edit. */
function buildDiff(name: string, input: Record<string, unknown>): { file: string; rows: DiffRow[] } | null {
  const file = String(input.file_path ?? input.path ?? '');
  if (name === 'Edit') {
    return { file, rows: lineDiff(String(input.old_string ?? ''), String(input.new_string ?? '')) };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const rows: DiffRow[] = [];
    for (const e of input.edits as Array<Record<string, unknown>>) {
      rows.push(...lineDiff(String(e.old_string ?? ''), String(e.new_string ?? '')));
    }
    return { file, rows };
  }
  if (name === 'Write') {
    return { file, rows: lineDiff('', String(input.content ?? '')) };
  }
  return null;
}

/** Trim shared head/tail lines, show the differing middle as -/+ with a
 *  few lines of dim context. Good enough for Phase 1; not a full LCS. */
function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const o = oldStr === '' ? [] : oldStr.split('\n');
  const n = newStr === '' ? [] : newStr.split('\n');
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;

  const rows: DiffRow[] = [];
  const CTX = 3;
  const headStart = Math.max(0, p - CTX);
  for (let i = headStart; i < p; i++) rows.push({ type: 'ctx', text: o[i] });
  for (let i = p; i < o.length - s; i++) rows.push({ type: 'del', text: o[i] });
  for (let i = p; i < n.length - s; i++) rows.push({ type: 'add', text: n[i] });
  const tailEnd = Math.min(o.length, o.length - s + CTX);
  for (let i = o.length - s; i < tailEnd; i++) rows.push({ type: 'ctx', text: o[i] });
  return rows;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const f = input.file_path ?? input.path;
  if (typeof f === 'string') return baseName(f);
  if (name === 'Bash' && typeof input.command === 'string') return clipInline(input.command, 60);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.url === 'string') return input.url;
  return '';
}

const baseName = (p: string) => p.split('/').pop() || p;
const clipInline = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const clip = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s);

// ----- composer ----------------------------------------------------------

function Composer({
  disabled, turnActive, active, activeFile, onSend, onStop,
}: {
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  activeFile: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { state } = useApp();
  const [mention, setMention] = useState<{ q: string; from: number } | null>(null);

  // Focus when this tab becomes active.
  useEffect(() => { if (active) taRef.current?.focus(); }, [active]);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }
  useEffect(autosize, [text]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return state.files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, state.files]);

  function onChange(v: string, caret: number) {
    setText(v);
    // Detect an `@token` ending at the caret to drive file autocomplete.
    const upto = v.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(upto);
    if (m) setMention({ q: m[2], from: caret - m[2].length });
    else setMention(null);
  }

  function pickMention(path: string) {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const before = text.slice(0, mention.from);
    const after = text.slice(ta.selectionStart);
    const next = before + path + ' ' + after;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => { ta.focus(); const c = (before + path + ' ').length; ta.setSelectionRange(c, c); });
  }

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    setMention(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(suggestions[0].name);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && mention) setMention(null);
  }

  // Dropped sidebar files insert their space-relative path.
  function onDrop(e: React.DragEvent) {
    const path = e.dataTransfer.getData(FILE_MIME);
    if (!path) return;
    e.preventDefault();
    setText((t) => (t ? t + ' ' : '') + path + ' ');
    taRef.current?.focus();
  }
  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes(FILE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  }

  return (
    <div className="agent-composer" onDrop={onDrop} onDragOver={onDragOver}>
      {mention && suggestions.length > 0 && (
        <div className="agent-mention">
          {suggestions.map((f) => (
            <button key={f.name} type="button" className="agent-mention-item" onClick={() => pickMention(f.name)}>
              <span className="agent-mention-name">{baseName(f.name)}</span>
              <span className="agent-mention-path">{f.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="agent-composer-box">
        <textarea
          ref={taRef}
          className="agent-input"
          rows={1}
          placeholder={disabled ? 'Connecting…' : 'Message Claude   (Enter to send, Shift+Enter for newline, @ to mention a file)'}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="agent-composer-bar">
          <button type="button" className="agent-bar-btn" title="Add context (coming soon)" disabled>
            <PlusIcon />
          </button>
          <button type="button" className="agent-bar-btn slash" title="Slash commands (coming soon)" disabled>/</button>
          {activeFile && (
            <span className="agent-ctx-chip" title={activeFile}>
              <FileGenericIcon className="agent-ctx-icon" />
              <span className="agent-ctx-name">{baseName(activeFile)}</span>
            </span>
          )}
          <span className="agent-bar-spacer" />
          <button type="button" className="agent-mode-btn" title="Permission mode (coming soon)" disabled>
            Edit automatically
          </button>
          {turnActive ? (
            <button type="button" className="agent-send stop" title="Stop" onClick={onStop}>■</button>
          ) : (
            <button type="button" className="agent-send" title="Send" disabled={disabled || !text.trim()} onClick={submit}>↑</button>
          )}
        </div>
      </div>
    </div>
  );
}
