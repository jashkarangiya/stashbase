/**
 * Structured chat view for a Claude tab — the VSCode-extension-style
 * panel. Connects to `/ws/agent` (SDK-backed,
 * see server/agent.ts) and renders the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions KB files.
 *
 * This is Phase 1 of design-docs/chat-panel.md. Only Claude routes here;
 * Codex shows a "Coming soon" placeholder (CodexView).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getWindowId } from '../api';
import { FILE_MIME } from '../dragMime';
import { renderMarkdownInline } from '../markdown';
import { useApp } from '../store/AppContext';
import { getActiveTab, type ChatTab } from '../store/state';
import {
  ChevronDownIcon, ClaudeIcon, HistoryIcon, PlusIcon, NewChatIcon, FileGenericIcon, CodeIcon,
  HandIcon, ClipboardListIcon, BoltIcon, CheckIcon, DumbbellIcon, SlashSquareIcon,
  ArrowUpIcon,
} from '../icons';

// ----- permission modes (composer "Modes" dropdown) ----------------------

/** The permission modes we expose, mapped 1:1 to the Agent SDK's
 *  `permissionMode`. Switching one sends `{ t: 'set-mode' }` → the server
 *  calls `query.setPermissionMode` live (see server/agent.ts). We omit the
 *  SDK's dangerous `bypassPermissions` / `dontAsk`. */
type PermMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

const MODES: { id: PermMode; label: string; desc: string; Icon: typeof HandIcon }[] = [
  { id: 'default', label: 'Ask before edits', desc: 'Claude will ask for approval before making each edit', Icon: HandIcon },
  { id: 'acceptEdits', label: 'Edit automatically', desc: 'Claude will apply edits without asking each time', Icon: CodeIcon },
  { id: 'plan', label: 'Plan mode', desc: 'Claude will explore and present a plan before editing', Icon: ClipboardListIcon },
  { id: 'auto', label: 'Auto mode', desc: 'Claude automatically chooses the best permission mode for each task', Icon: BoltIcon },
];

/** Thinking effort, mapped 1:1 to the SDK's `effort` option (low … max,
 *  default 'high'). Unlike permission mode there's no live setter, so
 *  effort is fixed per session — changing it reconnects (see AgentView). */
type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max',
};

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
  | { kind: 'user'; id: string; text: string; attachments?: Attachment[] }
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
  // Permission mode for this session — drives the composer's Modes
  // dropdown. Switching it sends `set-mode` so the SDK applies it live.
  const [mode, setMode] = useState<PermMode>('default');
  // Thinking effort — fixed per session (no live SDK setter), so it rides
  // the connect URL. `effortRef` lets the connect effect read the latest
  // value without resubscribing on every change.
  const [effort, setEffort] = useState<EffortLevel>('high');
  const effortRef = useRef<EffortLevel>('high');
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);

  useEffect(() => {
    readyRef.current = false;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent?windowId=${encodeURIComponent(getWindowId())}&effort=${effortRef.current}`;
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
        // A fresh session always starts at permissionMode 'default'; if the
        // user had picked a non-default mode, re-apply it so a reconnect
        // (Retry / effort change) doesn't silently reset it.
        if (mode !== 'default') wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode }));
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

  function send(text: string, attachments: Attachment[] = []) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setBlocks((bs) => [...bs, { kind: 'user', id: nextId(), text, attachments: attachments.length ? attachments : undefined }]);
    setTurnActive(true);
    openKind.current = null;
    // Attached files live in the space (cwd); list their paths so the
    // agent knows to read them. Kept out of the displayed header text —
    // the header renders them as chips instead.
    const wire = attachments.length
      ? `${text}${text ? '\n\n' : ''}Attached files (in this space):\n${attachments.map((a) => `- ${a.path}`).join('\n')}`
      : text;
    ws.send(JSON.stringify({ t: 'prompt', text: wire }));
  }

  function stop() {
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** Switch permission mode and tell the server to apply it live. */
  function changeMode(m: PermMode) {
    setMode(m);
    wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: m }));
  }

  /** Change thinking effort. The SDK fixes effort at session construction
   *  (no live setter), so we apply it by reconnecting — but only when the
   *  chat is still empty, so we never discard a real conversation. With
   *  history present it takes effect on the next new chat. */
  function changeEffort(level: EffortLevel) {
    setEffort(level);
    effortRef.current = level;
    if (blocks.length === 0) reconnect();
  }

  /** Spawn a fresh Claude chat tab (the in-panel `+`, mirroring the
   *  chrome launcher). */
  function newChat() {
    const same = state.chatTabs.filter((t) => t.agent === 'claude');
    const tabTitle = same.length === 0 ? 'Untitled' : `Untitled ${same.length + 1}`;
    const tab: ChatTab = { id: crypto.randomUUID(), agent: 'claude', title: tabTitle };
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
            <NewChatIcon />
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
        mode={mode}
        onSetMode={changeMode}
        effort={effort}
        onSetEffort={changeEffort}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

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

  // Group the flat block stream into turns: each user message starts a
  // turn and owns every following block until the next user message.
  // The user message renders as a full-width header that sticks to the
  // top of the scroll area while its turn's reply scrolls past
  // (VSCode-style) — the next user message pushes it up.
  const turns = useMemo(() => groupTurns(blocks), [blocks]);

  return (
    <div className="agent-messages" ref={ref} onScroll={onScroll}>
      {blocks.length === 0 && phase === 'live' && <Hero />}
      {phase === 'connecting' && <div className="agent-empty">Connecting to Claude…</div>}
      {turns.map((turn) => (
        <div className="agent-turn" key={turn.key}>
          {turn.head && <UserTurnHead block={turn.head} />}
          {turn.body.map((b) => <BlockView key={b.id} block={b} onPermission={onPermission} />)}
        </div>
      ))}
      {turnActive && <div className="agent-working"><span className="agent-dot" />Claude is working…</div>}
    </div>
  );
}

interface Turn { key: string; head: Extract<Block, { kind: 'user' }> | null; body: Block[] }

/** Slice the block list into turns at each user message. Blocks before
 *  the first user message (rare — e.g. a startup error) form a headless
 *  leading turn. */
function groupTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === 'user') {
      cur = { key: b.id, head: b, body: [] };
      turns.push(cur);
    } else {
      if (!cur) { cur = { key: `lead-${b.id}`, head: null, body: [] }; turns.push(cur); }
      cur.body.push(b);
    }
  }
  return turns;
}

/** Full-width, sticky user-message header (the pinned prompt). */
function UserTurnHead({ block }: { block: Extract<Block, { kind: 'user' }> }) {
  return (
    <div className="agent-turn-head">
      {block.attachments && block.attachments.length > 0 && (
        <div className="agent-turn-attach">
          {block.attachments.map((a) => (
            <span key={a.path} className="agent-attach-chip" title={a.path}>
              <FileGenericIcon className="agent-attach-icon" />
              <span className="agent-attach-name">{a.name}</span>
              {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
            </span>
          ))}
        </div>
      )}
      {block.text && <span className="agent-turn-text">{block.text}</span>}
    </div>
  );
}

/** Empty-state hero: Claude Code wordmark + a pixel mascot. */
function Hero() {
  return (
    <div className="agent-hero">
      <div className="agent-hero-wordmark">
        <ClaudeIcon className="agent-hero-mark" />
        <span className="agent-hero-name">Claude Code</span>
      </div>
      <PixelMascot />
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
      // User messages normally render as the turn's sticky header (see
      // MessageList/groupTurns); this branch is just a fallback.
      return <UserTurnHead block={block} />;
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

/** A file uploaded via the composer `+`, shown as a removable chip.
 *  `path` is the space-relative path (sent to the agent); `dims` is the
 *  pixel size for images (chip label only). */
interface Attachment { path: string; name: string; dims?: string }

/** Read an image File's natural pixel dimensions for the chip label
 *  (e.g. `2162×4000`). Resolves undefined if it isn't a decodable image. */
function readImageDims(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(`${img.naturalWidth}×${img.naturalHeight}`); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(undefined); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/** The composer's "Modes" control: a button showing the active mode that
 *  opens a dropdown to switch permission mode (Ask / Edit auto / Plan /
 *  Auto). The active mode gets a check; ⇧+Tab cycles (handled in the
 *  composer's keydown). */
function ModeMenu({
  mode, effort, open, disabled, wrapRef, onToggle, onPick, onSetEffort,
}: {
  mode: PermMode;
  effort: EffortLevel;
  open: boolean;
  disabled: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onPick: (m: PermMode) => void;
  onSetEffort: (level: EffortLevel) => void;
}) {
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  const ActiveIcon = active.Icon;
  return (
    <div className="agent-mode-wrap" ref={wrapRef}>
      {open && (
        <div className="agent-mode-menu" role="menu">
          <div className="agent-mode-menu-head">
            <span>Modes</span>
          </div>
          {MODES.map((m) => {
            const Icon = m.Icon;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                className={'agent-mode-opt' + (m.id === mode ? ' active' : '')}
                onClick={() => onPick(m.id)}
              >
                <Icon className="agent-mode-opt-icon" />
                <span className="agent-mode-opt-text">
                  <span className="agent-mode-opt-title">{m.label}</span>
                  <span className="agent-mode-opt-desc">{m.desc}</span>
                </span>
                {m.id === mode && <CheckIcon className="agent-mode-opt-check" />}
              </button>
            );
          })}
          <EffortBar effort={effort} onSet={onSetEffort} />
        </div>
      )}
      <button
        type="button"
        className="agent-mode-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Permission mode (⇧+Tab)"
        onClick={onToggle}
      >
        <ActiveIcon className="agent-mode-icon" />
        {active.label}
      </button>
    </div>
  );
}

/** Effort (thinking depth) slider in the Modes dropdown footer. Five
 *  notches (low … max); click one to set. The fill runs up to the current
 *  level, with the top "max" notch tinted to read as the ceiling. */
function EffortBar({ effort, onSet }: { effort: EffortLevel; onSet: (l: EffortLevel) => void }) {
  const cur = EFFORTS.indexOf(effort);
  return (
    <div className="agent-effort">
      <DumbbellIcon className="agent-effort-icon" />
      <span className="agent-effort-label">
        Effort <span className="agent-effort-level">({EFFORT_LABEL[effort]})</span>
      </span>
      <div className="agent-effort-track" role="group" aria-label="Effort">
        {EFFORTS.map((lv, i) => (
          <button
            key={lv}
            type="button"
            className={
              'agent-effort-notch'
              + (i <= cur ? ' on' : '')
              + (lv === effort ? ' cur' : '')
              + (lv === 'max' ? ' max' : '')
            }
            aria-label={EFFORT_LABEL[lv]}
            aria-pressed={lv === effort}
            title={EFFORT_LABEL[lv]}
            onClick={() => onSet(lv)}
          />
        ))}
      </div>
    </div>
  );
}

function Composer({
  disabled, turnActive, active, activeFile, mode, onSetMode, effort, onSetEffort, onSend, onStop,
}: {
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  activeFile: string | null;
  mode: PermMode;
  onSetMode: (mode: PermMode) => void;
  effort: EffortLevel;
  onSetEffort: (level: EffortLevel) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { state, actions } = useApp();
  const [mention, setMention] = useState<{ q: string; from: number } | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  // Local-file upload via the composer `+`: a hidden picker whose chosen
  // files are imported into the current space and shown as removable
  // attachment chips (VSCode-style), referenced by path on send.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Focus when this tab becomes active.
  useEffect(() => { if (active) taRef.current?.focus(); }, [active]);

  /** Upload picked local files into the current space (at the active
   *  folder), then add an attachment chip per file. The agent reads them
   *  by the server-authoritative path (it de-dups colliding names). */
  async function uploadLocalFiles(files: FileList | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setUploading(true);
    try {
      const items = list.map((file) => ({ file, relPath: file.name }));
      const result = await api.upload(items, state.activeFolder);
      // Refresh the tree + index banner so the new files show up.
      await actions.loadFiles();
      void actions.refreshIndexState();
      // `result.files` is 1:1 with `list` (server preserves order); pull
      // image dimensions off the original File for the chip label.
      const entries = result.files ?? [];
      const added: Attachment[] = [];
      let failed = 0;
      for (let i = 0; i < entries.length; i++) {
        const r = entries[i];
        if (r.error) { failed++; continue; }
        const orig = list[i];
        const dims = orig && orig.type.startsWith('image/') ? await readImageDims(orig) : undefined;
        added.push({ path: r.file, name: baseName(r.file), dims });
      }
      if (added.length) setAttachments((a) => [...a, ...added]);
      if (failed) actions.toast(`${failed} file(s) failed to upload.`, { level: 'error' });
    } catch {
      actions.toast('Upload failed.', { level: 'error' });
    } finally {
      setUploading(false);
      taRef.current?.focus();
    }
  }

  function removeAttachment(path: string) {
    setAttachments((a) => a.filter((x) => x.path !== path));
  }

  // Close the Modes dropdown on an outside click.
  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) {
      if (!modeWrapRef.current?.contains(e.target as Node)) setModeOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modeOpen]);

  /** Cycle to the next permission mode (⇧+Tab in the composer). */
  function cycleMode() {
    const i = MODES.findIndex((m) => m.id === mode);
    onSetMode(MODES[(i + 1) % MODES.length].id);
  }

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
    // Allow sending with only attachments (no typed text).
    if ((!t && attachments.length === 0) || disabled || uploading) return;
    onSend(t, attachments);
    setText('');
    setMention(null);
    setAttachments([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(suggestions[0].name);
      return;
    }
    // ⇧+Tab cycles the permission mode (matches the dropdown's hint).
    if (e.key === 'Tab' && e.shiftKey && !disabled) {
      e.preventDefault();
      cycleMode();
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
        {(attachments.length > 0 || uploading) && (
          <div className="agent-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
                <button
                  type="button"
                  className="agent-attach-x"
                  title="Remove attachment"
                  onClick={() => removeAttachment(a.path)}
                >×</button>
              </span>
            ))}
            {uploading && <span className="agent-attach-loading">Uploading…</span>}
          </div>
        )}
        <textarea
          ref={taRef}
          className="agent-input"
          rows={1}
          placeholder={disabled ? 'Connecting…' : 'Message Claude…'}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void uploadLocalFiles(e.target.files);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
        <div className="agent-composer-bar">
          <button
            type="button"
            className="agent-bar-btn"
            title={uploading ? 'Uploading…' : 'Upload local files'}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <PlusIcon />
          </button>
          <button type="button" className="agent-bar-btn slash" title="Slash commands (coming soon)" disabled>
            <SlashSquareIcon />
          </button>
          {activeFile && (
            <>
              <span className="agent-bar-divider" />
              <span className="agent-ctx-chip" title={activeFile}>
                <FileGenericIcon className="agent-ctx-icon" />
                <span className="agent-ctx-name">{baseName(activeFile)}</span>
              </span>
            </>
          )}
          <span className="agent-bar-spacer" />
          <ModeMenu
            mode={mode}
            effort={effort}
            open={modeOpen}
            disabled={disabled}
            wrapRef={modeWrapRef}
            onToggle={() => setModeOpen((o) => !o)}
            onPick={(m) => { onSetMode(m); setModeOpen(false); }}
            onSetEffort={onSetEffort}
          />
          {turnActive ? (
            <button type="button" className="agent-send stop" title="Stop" onClick={onStop}>■</button>
          ) : (
            <button type="button" className="agent-send" title="Send" disabled={disabled || uploading || (!text.trim() && attachments.length === 0)} onClick={submit}><ArrowUpIcon /></button>
          )}
        </div>
      </div>
    </div>
  );
}
