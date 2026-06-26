/**
 * Structured chat view for an agent tab — the VSCode-extension-style
 * panel. Claude connects to `/ws/agent` (Claude Agent SDK, see
 * server/agent.ts); Codex connects to `/ws/codex` (Codex app-server
 * structured session, see server/codex-agent.ts).
 * Both render the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions KB files.
 *
 * This is Phase 1 of design-docs/chat-panel.md.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { api, getWindowId, type AgentContextFile, type SessionInfo } from '../api';
import { FILE_MIME } from '../dragMime';
import { renderMarkdownInline } from '../markdown';
import { useApp } from '../store/AppContext';
import { getActiveTab, type ChatTab } from '../store/state';
import {
  ChevronDownIcon, ClaudeIcon, HistoryIcon, PlusIcon, NewChatIcon, FileGenericIcon, CodeIcon,
  HandIcon, ClipboardListIcon, BoltIcon, CheckIcon, DumbbellIcon, SlashSquareIcon,
  ArrowUpIcon, EditIcon, TrashIcon, CodexIcon,
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
  | { t: 'session-id'; id: string }
  | { t: 'turn-start' }
  | { t: 'text'; delta: string }
  | { t: 'thinking'; delta: string }
  | { t: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { t: 'tool-delta'; id: string; delta: string }
  | { t: 'tool-result'; id: string; content: string; isError: boolean }
  | { t: 'permission'; id: string; toolUseId: string; name: string; title: string | null; input: Record<string, unknown> }
  | { t: 'turn-end'; isError: boolean }
  | { t: 'error'; message: string }
  | { t: 'exit' };

type AgentKind = 'claude' | 'codex';

const AGENT_META: Record<AgentKind, {
  name: string;
  shortName: string;
  endpoint: string;
  supportsHistory: boolean;
  supportsModes: boolean;
  supportsEffort: boolean;
  Icon: ComponentType<{ className?: string }>;
}> = {
  claude: {
    name: 'Claude Code',
    shortName: 'Claude',
    endpoint: '/ws/agent',
    supportsHistory: true,
    supportsModes: true,
    supportsEffort: true,
    Icon: ClaudeIcon,
  },
  codex: {
    name: 'Codex',
    shortName: 'Codex',
    endpoint: '/ws/codex',
    supportsHistory: true,
    supportsModes: false,
    supportsEffort: true,
    Icon: CodexIcon,
  },
};

let blockSeq = 0;
const nextId = () => `b${++blockSeq}`;

/** A chat tab still wearing its auto-generated placeholder name, so we
 *  know it's safe to overwrite with the session's derived title. */
function isDefaultChatTitle(t: string): boolean {
  return /^Untitled( \d+)?$/.test(t.trim());
}

export function AgentView({
  active,
  id,
  title,
  agent = 'claude',
}: {
  active: boolean;
  id: string;
  title: string;
  agent?: AgentKind;
}) {
  const { state, dispatch, actions } = useApp();
  const meta = AGENT_META[agent];
  const spaceRef = useRef(state.space);
  spaceRef.current = state.space;
  const mountedRef = useRef(true);
  const uploadCountRef = useRef(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [turnActive, setTurnActive] = useState(false);
  // Composer attachments (context files) — lifted here so a drop anywhere
  // on the panel, the composer `+`, and the send path all share one list.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
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
  // The live session's SDK id (from the `session-id` event) — lets the
  // History dropdown mark the current session active. `resumeIdRef` holds
  // a session id to resume on the next connect; it rides the connect URL
  // (like effort) and is consumed-and-cleared there.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const resumeIdRef = useRef<string | null>(null);
  // Refs mirror the live session id + this tab's id/title so the WS
  // message handler (bound once per connection) reads current values
  // when it renames the tab on the first turn-end.
  const sessionIdRef = useRef<string | null>(null);
  const idRef = useRef(id); idRef.current = id;
  const titleRef = useRef(title); titleRef.current = title;
  const [historyOpen, setHistoryOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const toolNamesRef = useRef<Map<string, string>>(new Map());
  // Which streaming block kind is currently "open" (so consecutive text
  // deltas append to one bubble; a tool call closes it).
  const openKind = useRef<'assistant' | 'thinking' | null>(null);
  const knownFilePaths = useMemo(() => new Set(state.files.map((f) => f.name)), [state.files]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    readyRef.current = false;
    // Consume-and-clear the resume id: it belongs to this one connection,
    // so a later reconnect (Retry / effort change) starts fresh instead of
    // re-resuming.
    const resume = resumeIdRef.current;
    resumeIdRef.current = null;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${meta.endpoint}`
      + `?windowId=${encodeURIComponent(getWindowId())}&effort=${effortRef.current}`
      + (resume ? `&resume=${encodeURIComponent(resume)}` : '');
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
      if (!readyRef.current) setFatal((f) => f ?? `Connection closed before ${meta.shortName} started.`);
      setPhase('closed');
    };

    return () => {
      // Detach onclose so the reconnect path's teardown doesn't clobber
      // the fresh 'connecting' state with a stale 'closed'.
      ws.onclose = null;
      try { ws.send(JSON.stringify({ t: 'close' })); } catch { /* gone */ }
      ws.close();
    };
  }, [nonce, meta.endpoint, meta.shortName]);

  /** Tear down and start a fresh session (Retry button / after the user
   *  reopens a space). */
  function reconnect() {
    setBlocks([]);
    setFatal(null);
    setTurnActive(false);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    toolNamesRef.current.clear();
    openKind.current = null;
    setPhase('connecting');
    setNonce((n) => n + 1);
  }

  /** Open a past session from the History dropdown: paint its transcript,
   *  then reconnect with `resume` so the SDK appends to it and the user can
   *  keep chatting. Unlike `reconnect`, blocks are pre-populated (not
   *  cleared) with the replayed history. */
  async function resumeSession(id: string) {
    setHistoryOpen(false);
    let hist: Block[] = [];
    try {
      hist = (await api.getSessionMessages(id, agent)) as Block[];
    } catch {
      actions.toast('Could not load that session.', { level: 'error' });
      return;
    }
    setBlocks(hist);
    setFatal(null);
    setTurnActive(false);
    setCurrentSessionId(id);
    sessionIdRef.current = id;
    toolNamesRef.current.clear();
    openKind.current = null;
    resumeIdRef.current = id;
    // Name the tab from the resumed session right away — otherwise a tab
    // opened to a past session stays "Untitled" until the user sends a
    // new prompt (the `turn-end` path that usually renames never fires on
    // a pure load). Safe: `maybeNameTab` only overwrites a placeholder.
    void maybeNameTab();
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
        if (agent === 'claude' && mode !== 'default') wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode }));
        break;
      case 'session-id':
        setCurrentSessionId(ev.id);
        sessionIdRef.current = ev.id;
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
        toolNamesRef.current.set(ev.id, ev.name);
        setBlocks((bs) => [...bs, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
        break;
      case 'tool-delta':
        setBlocks((bs) => bs.map((b) =>
          b.kind === 'tool' && b.id === ev.id && b.status !== 'denied'
            ? { ...b, result: (b.result ?? '') + ev.delta }
            : b));
        break;
      case 'tool-result':
        setBlocks((bs) => bs.map((b) =>
          b.kind === 'tool' && b.id === ev.id && b.status !== 'denied'
            ? { ...b, status: ev.isError ? 'error' : 'done', result: ev.content }
            : b));
        if (!ev.isError) {
          const toolName = toolNamesRef.current.get(ev.id);
          if (shouldRefreshAfterTool(toolName)) {
            const toolSpace = spaceRef.current;
            const createdFile = fileInCurrentSpaceFromToolResult(toolName, ev.content, toolSpace);
            void (async () => {
              await api.sync(toolSpace).catch(() => { /* turn-end / next poll will surface it */ });
              if (spaceRef.current !== toolSpace) return;
              await actions.loadFiles();
              if (spaceRef.current !== toolSpace) return;
              void actions.refreshIndexState();
              if (createdFile) await actions.selectFile(createdFile);
            })().catch((err) => {
              actions.toast(`Could not refresh files: ${errorText(err)}`, { level: 'error' });
            });
          }
        }
        toolNamesRef.current.delete(ev.id);
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
        // Name the tab from the session's derived title (first prompt /
        // SDK summary) once the first turn lands — keeps it in sync with
        // the History list instead of staying "Untitled".
        void maybeNameTab();
        // The agent may have written files via shell during the turn —
        // reconcile now (deterministic, replaces fs.watch). MCP writes
        // already index on their own path; this catches `Bash`/editor
        // writes the moment the turn finishes.
        {
          const turnSpace = spaceRef.current;
          void api.sync(turnSpace || undefined)
            .catch(() => { /* next status poll surfaces it */ })
            .finally(() => {
              if (spaceRef.current === turnSpace) void actions.refreshIndexState();
            });
        }
        break;
      case 'error':
        openKind.current = null;
        // An error before the session is ready is fatal (e.g. no space
        // open / not authenticated); mid-session it's just a notice.
        if (!readyRef.current) {
          setTurnActive(false);
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

  async function send(text: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const atts = attachments;
    setBlocks((bs) => [...bs, { kind: 'user', id: nextId(), text, attachments: atts.length ? atts : undefined }]);
    setTurnActive(true);
    openKind.current = null;
    // Build the wire prompt: the user's text, plus context lines the agent
    // resolves with Read. The file currently open in the viewer rides along
    // as ambient context (like Cursor's "current file"); explicit
    // attachments (temp uploads = absolute, sidebar files = space-relative)
    // are listed too. Both kept out of the displayed header — chips show
    // the attachments; the composer chip signals the active file.
    const ctx = await buildPromptContext(activeFile, atts);
    const wire = ctx.length ? `${text}${text ? '\n\n' : ''}${ctx.join('\n\n')}` : text;
    try {
      ws.send(JSON.stringify({ t: 'prompt', text: wire }));
      setAttachments([]);
    } catch (err) {
      setTurnActive(false);
      setBlocks((bs) => [...bs, { kind: 'error', id: nextId(), text: `Could not send message: ${errorText(err)}` }]);
    }
  }

  async function buildPromptContext(openFile: string | null, atts: Attachment[]): Promise<string[]> {
    const lines: string[] = [];
    if (openFile && !atts.some((a) => a.path === openFile)) {
      lines.push(await formatCurrentFileContext(openFile));
    }
    if (atts.length) {
      const rendered = await Promise.all(atts.map((a) => formatAttachmentContext(a)));
      lines.push(`Attached files:\n${rendered.join('\n')}`);
    }
    return lines;
  }

  async function resolveSpaceContext(path: string): Promise<AgentContextFile | null> {
    if (!knownFilePaths.has(path)) return null;
    try {
      return await api.agentContextFile(spaceRef.current, path);
    } catch {
      return null;
    }
  }

  async function formatCurrentFileContext(path: string): Promise<string> {
    const ctx = await resolveSpaceContext(path);
    if (ctx?.kind === 'derived') {
      return [
        `Current file (open in the viewer): ${ctx.sourcePath}`,
        `For text context, read the extracted Markdown filesystem path first: ${ctx.readPath}`,
        `Only read the original ${ctx.sourceFormat} if you need raw visual or binary detail.`,
      ].join('\n');
    }
    if (ctx && !ctx.available && (ctx.sourceFormat === 'pdf' || ctx.sourceFormat === 'image')) {
      return [
        `Current file (open in the viewer): ${ctx.sourcePath}`,
        `Extracted Markdown is not available yet for this ${ctx.sourceFormat}; read the original only if necessary.`,
      ].join('\n');
    }
    return `Current file (open in the viewer): ${path}`;
  }

  async function formatAttachmentContext(att: Attachment): Promise<string> {
    const ctx = await resolveSpaceContext(att.path);
    if (ctx?.kind === 'derived') {
      return `- ${ctx.sourcePath} (read extracted Markdown filesystem path first: ${ctx.readPath}; use the original ${ctx.sourceFormat} only for raw visual or binary detail)`;
    }
    if (ctx && !ctx.available && (ctx.sourceFormat === 'pdf' || ctx.sourceFormat === 'image')) {
      return `- ${ctx.sourcePath} (extracted Markdown is not available yet; read the original only if necessary)`;
    }
    return `- ${att.path}`;
  }

  /** Attach OS files (dropped from Finder or picked via `+`) as transient
   *  context: they're written to a temp dir OUTSIDE the space (so they
   *  never enter the KB / file tree / index) and referenced by absolute
   *  path, which the agent reads. */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    uploadCountRef.current += 1;
    setUploading(true);
    try {
      const result = await api.attachFiles(files);
      if (!mountedRef.current) return;
      // `result.files` is 1:1 with `files` (server preserves order); pull
      // image dimensions off the original File for the chip label.
      const entries = result.files ?? [];
      const added: Attachment[] = [];
      let failed = 0;
      for (let i = 0; i < entries.length; i++) {
        const r = entries[i];
        if (r.error || !r.path) { failed++; continue; }
        const orig = files[i];
        const dims = orig && orig.type.startsWith('image/') ? await readImageDims(orig) : undefined;
        added.push({ path: r.path, name: r.name, dims });
      }
      if (!mountedRef.current) return;
      if (added.length) setAttachments((a) => mergeAttachments(a, added));
      if (failed) actions.toast(`${failed} file(s) failed to attach.`, { level: 'error' });
    } catch {
      if (!mountedRef.current) return;
      actions.toast('Attach failed.', { level: 'error' });
    } finally {
      uploadCountRef.current = Math.max(0, uploadCountRef.current - 1);
      if (mountedRef.current) setUploading(uploadCountRef.current > 0);
    }
  }

  /** Add chips for files already in the space (dragged from the sidebar);
   *  no upload needed — just reference their existing path. */
  function addSpaceFiles(paths: string[]) {
    const clean = paths.filter((p) => p && knownFilePaths.has(p));
    const skipped = paths.filter((p) => p && !knownFilePaths.has(p)).length;
    if (skipped) actions.toast('Only files from the current space can be attached.', { level: 'warning' });
    const add = clean.map((p) => ({ path: p, name: baseName(p) }));
    if (add.length) setAttachments((a) => mergeAttachments(a, add));
  }

  function removeAttachment(path: string) {
    setAttachments((a) => a.filter((x) => x.path !== path));
  }

  function stop() {
    wsRef.current?.send(JSON.stringify({ t: 'interrupt' }));
  }

  /** Switch permission mode and tell the server to apply it live when
   *  the selected backend supports it. */
  function changeMode(m: PermMode) {
    setMode(m);
    if (agent === 'claude') wsRef.current?.send(JSON.stringify({ t: 'set-mode', mode: m }));
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

  /** Rename this tab from the session's server-derived title once the
   *  first turn lands. Only fires while the tab still wears its
   *  "Untitled" placeholder, so a user-set name (or a later turn) never
   *  clobbers it. Uses the same source as the History list, so the two
   *  stay consistent. */
  async function maybeNameTab() {
    const tabId = idRef.current;
    const sid = sessionIdRef.current;
    if (!tabId || !sid || !isDefaultChatTitle(titleRef.current)) return;
    try {
      const sessions = await api.listSessions(agent);
      const t = sessions.find((x) => x.id === sid)?.title?.trim();
      if (t && !isDefaultChatTitle(t)) {
        dispatch({ type: 'CHAT_TAB_RENAME', id: tabId, title: t.length > 60 ? t.slice(0, 60).trimEnd() + '…' : t });
      }
    } catch { /* leave the placeholder if the lookup fails */ }
  }

  /** Spawn a fresh chat tab for the same agent (the in-panel `+`, mirroring the
   *  chrome launcher). */
  function newChat() {
    const same = state.chatTabs.filter((t) => t.agent === agent);
    const tabTitle = same.length === 0 ? 'Untitled' : `Untitled ${same.length + 1}`;
    const tab: ChatTab = { id: crypto.randomUUID(), agent, title: tabTitle };
    dispatch({ type: 'CHAT_TAB_NEW', tab });
  }

  // The document the user is currently looking at — shown as a context
  // chip in the composer and sent along as ambient context on each
  // message (see `send`), unless it's already an explicit attachment.
  const activeFile = getActiveTab(state)?.file?.name ?? null;

  function replyPermission(toolBlockId: string, permId: string, allow: boolean) {
    wsRef.current?.send(JSON.stringify({ t: 'permission-reply', id: permId, allow }));
    setBlocks((bs) => bs.map((b) =>
      b.kind === 'tool' && b.id === toolBlockId
        ? { ...b, status: allow ? 'running' : 'denied', permId: undefined }
        : b));
  }

  // Drag files anywhere onto the panel to attach them as context: OS files
  // (Finder screenshots / PDFs) become transient attachments (temp dir,
  // NOT the space); sidebar files (FILE_MIME) reference their existing
  // path. `stopPropagation` is load-bearing: it stops the event before it
  // reaches the window-level `useGlobalDragDrop` listener, which would
  // otherwise *also* fire and import the file into the space.
  function dropKinds(dt: DataTransfer): { os: boolean; kb: boolean } {
    return { os: dt.types.includes('Files'), kb: dt.types.includes(FILE_MIME) };
  }
  function onPanelDragOver(e: React.DragEvent) {
    const { os, kb } = dropKinds(e.dataTransfer);
    if (!os && !kb) return;
    e.preventDefault();
    e.stopPropagation();
    // The sidebar drag source sets effectAllowed='move'; match it so the
    // drop isn't silently cancelled (OS files accept 'copy').
    e.dataTransfer.dropEffect = kb && !os ? 'move' : 'copy';
    if (phase === 'live') setDragOver(true);
  }
  function onPanelDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the panel, not when it
    // crosses between child elements.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }
  function onPanelDrop(e: React.DragEvent) {
    const { os, kb } = dropKinds(e.dataTransfer);
    if (!os && !kb) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (phase !== 'live') return;
    const osFiles = Array.from(e.dataTransfer.files ?? []);
    if (osFiles.length) void uploadFiles(osFiles);
    else {
      const kbPath = e.dataTransfer.getData(FILE_MIME);
      if (kbPath) addSpaceFiles([kbPath]);
    }
  }

  return (
    <div
      className="agent-view"
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {dragOver && (
        <div className="agent-drop-overlay">
          <div className="agent-drop-card">Drop files to add as context</div>
        </div>
      )}
      <div className="agent-head">
        <span className="agent-head-title">{title}</span>
        <div className="agent-head-actions">
          {meta.supportsHistory && (
            <HistoryMenu
              open={historyOpen}
              currentSessionId={currentSessionId}
              agent={agent}
              onToggle={() => setHistoryOpen((o) => !o)}
              onClose={() => setHistoryOpen(false)}
              onResume={resumeSession}
              onActiveDeleted={reconnect}
            />
          )}
          <button type="button" className="agent-head-btn" title={`New ${meta.name} chat`} onClick={newChat}>
            <NewChatIcon />
          </button>
        </div>
      </div>
      <MessageList
        blocks={blocks}
        turnActive={turnActive}
        phase={phase}
        agentName={meta.name}
        agentShortName={meta.shortName}
        Icon={meta.Icon}
        onPermission={replyPermission}
      />
      {phase === 'closed' && (
        fatal
          ? (
            <div className="agent-fatal">
              <span className="agent-fatal-msg">
                {/No space open/i.test(fatal)
                  ? 'No space is open. Open a space, then retry.'
                  : `Couldn't start ${meta.shortName}: ${fatal}`}
              </span>
              <button type="button" className="agent-btn" onClick={reconnect}>Retry</button>
            </div>
          )
          : (
            <div className="agent-ended">
              <span>Session ended.</span>
              <button type="button" className="agent-btn" onClick={reconnect}>Reconnect</button>
            </div>
          )
      )}
      <Composer
        phase={phase}
        disabled={phase !== 'live'}
        turnActive={turnActive}
        active={active}
        activeFile={activeFile}
        mode={mode}
        onSetMode={changeMode}
        effort={effort}
        onSetEffort={changeEffort}
        showModeMenu={meta.supportsModes}
        showEffortMenu={meta.supportsEffort && !meta.supportsModes}
        agentShortName={meta.shortName}
        attachments={attachments}
        uploading={uploading}
        onPickFiles={uploadFiles}
        onRemoveAttachment={removeAttachment}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

function shouldRefreshAfterTool(name: string | undefined): boolean {
  if (!name) return false;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  return /^mcp__/.test(name) && /(write|delete|rename|update|set_|create|move)/i.test(name);
}

function fileInCurrentSpaceFromToolResult(toolName: string | undefined, content: string, space: string): string | null {
  if (!toolName || !/write_file$/i.test(toolName) || !space) return null;
  try {
    const parsed = JSON.parse(content) as { path?: unknown; ok?: unknown };
    if (parsed.ok !== true || typeof parsed.path !== 'string') return null;
    const prefix = `${space}/`;
    if (!parsed.path.startsWith(prefix)) return null;
    const rel = parsed.path.slice(prefix.length);
    return isSafeSpaceRelativePath(rel) ? rel : null;
  } catch {
    return null;
  }
}

function isSafeSpaceRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ----- history dropdown --------------------------------------------------

/** Compact relative time for a session row (`31m`, `3h`, `2d`, else a
 *  date). Matches the terse style of the reference picker. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}

/** The History button + its dropdown: lists local agent sessions
 *  (newest first), with client-side search, and per-row open (click) /
 *  rename (pencil) / delete (trash). Local only — no Web tab. Reuses the
 *  ModeMenu outside-click convention. */
function HistoryMenu({
  open, currentSessionId, agent, onToggle, onClose, onResume, onActiveDeleted,
}: {
  open: boolean;
  currentSessionId: string | null;
  agent: AgentKind;
  onToggle: () => void;
  onClose: () => void;
  onResume: (id: string) => void;
  onActiveDeleted: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  async function refresh() {
    setLoading(true);
    try { setSessions(await api.listSessions(agent)); }
    catch { setSessions([]); }
    finally { setLoading(false); }
  }

  // Load (refresh) the list each time the dropdown opens; reset transient
  // search / edit state on close.
  useEffect(() => {
    if (open) { void refresh(); }
    else { setQ(''); setEditingId(null); }
  }, [open, agent]);

  // Close on outside click (same pattern as ModeMenu).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;
  }, [sessions, q]);

  async function commitRename(id: string) {
    const title = editText.trim();
    setEditingId(null);
    if (!title) return;
    try {
      const updated = await api.renameSession(id, title, agent);
      setSessions((ss) => ss.map((s) => (s.id === id ? updated : s)));
    } catch { /* leave list as-is */ }
  }

  async function remove(id: string) {
    try { await api.deleteSession(id, agent); } catch { return; }
    setSessions((ss) => ss.filter((s) => s.id !== id));
    if (id === currentSessionId) onActiveDeleted();
  }

  return (
    <div className="agent-history-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agent-head-btn"
        title="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <HistoryIcon />
      </button>
      {open && (
        <div className="agent-history-menu" role="menu">
          <div className="agent-history-search">
            <input
              type="text"
              autoFocus
              placeholder="Search sessions…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="agent-history-list">
            {loading && <div className="agent-history-empty">Loading…</div>}
            {!loading && shown.length === 0 && (
              <div className="agent-history-empty">{q ? 'No matches.' : 'No sessions yet.'}</div>
            )}
            {!loading && shown.map((s) => (
              <div
                key={s.id}
                className={'agent-history-row' + (s.id === currentSessionId ? ' active' : '')}
              >
                {editingId === s.id ? (
                  <input
                    className="agent-history-rename"
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id); }
                      else if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={() => void commitRename(s.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="agent-history-open"
                    title={s.title}
                    onClick={() => onResume(s.id)}
                  >
                    <span className="agent-history-title">{s.title}</span>
                    <span className="agent-history-time">{relTime(s.lastModified)}</span>
                  </button>
                )}
                <div className="agent-history-row-actions">
                  <button
                    type="button"
                    className="agent-history-act"
                    title="Rename"
                    onClick={() => { setEditingId(s.id); setEditText(s.title); }}
                  >
                    <EditIcon />
                  </button>
                  <button
                    type="button"
                    className="agent-history-act"
                    title="Delete"
                    onClick={() => void remove(s.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ----- message list ------------------------------------------------------

function MessageList({
  blocks, turnActive, phase, agentName, agentShortName, Icon, onPermission,
}: {
  blocks: Block[];
  turnActive: boolean;
  phase: 'connecting' | 'live' | 'closed';
  agentName: string;
  agentShortName: string;
  Icon: ComponentType<{ className?: string }>;
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
      {blocks.length === 0 && phase === 'live' && <Hero name={agentName} Icon={Icon} />}
      {phase === 'connecting' && <div className="agent-empty">Connecting to {agentShortName}…</div>}
      {turns.map((turn) => (
        <div className="agent-turn" key={turn.key}>
          {turn.head && <UserTurnHead block={turn.head} scrollRef={ref} />}
          {turn.body.map((b) => <BlockView key={b.id} block={b} onPermission={onPermission} />)}
        </div>
      ))}
      {turnActive && <div className="agent-working"><span className="agent-dot" />{agentShortName} is working…</div>}
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

/** Full-width, sticky user-message header (the pinned prompt). It sits
 *  flat inside the chat at rest and only lifts (frosted glass + shadow)
 *  once it's actually pinned to the top. A 1px sentinel at the turn's
 *  flow-top tells us when that happens: when the sentinel scrolls above
 *  the scroll container's top edge, the header is stuck. */
function UserTurnHead({
  block, scrollRef,
}: {
  block: Extract<Block, { kind: 'user' }>;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = scrollRef?.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting),
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef]);

  return (
    <>
      <span ref={sentinelRef} className="agent-turn-sentinel" aria-hidden="true" />
      <div className={'agent-turn-head' + (stuck ? ' stuck' : '')}>
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
    </>
  );
}

/** Empty-state hero: agent wordmark + a small pixel mark. */
function Hero({ name, Icon }: { name: string; Icon: ComponentType<{ className?: string }> }) {
  return (
    <div className="agent-hero">
      <div className="agent-hero-wordmark">
        <Icon className="agent-hero-mark" />
        <span className="agent-hero-name">{name}</span>
      </div>
      {name === 'Claude Code' && <PixelMascot />}
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
  const [open, setOpen] = useState(block.status === 'awaiting' || block.name === 'Bash');
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

/** A context file attached to the composer, shown as a removable chip.
 *  `path` is the space-relative path (sent to the agent); `dims` is the
 *  pixel size for images (chip label only). */
interface Attachment { path: string; name: string; dims?: string }

/** Append new attachments, skipping any whose path is already present
 *  (re-dropping the same file is a no-op). */
function mergeAttachments(cur: Attachment[], add: Attachment[]): Attachment[] {
  const have = new Set(cur.map((a) => a.path));
  const fresh = add.filter((a) => !have.has(a.path));
  return fresh.length ? [...cur, ...fresh] : cur;
}

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

function EffortMenu({
  effort, open, disabled, wrapRef, onToggle, onSetEffort,
}: {
  effort: EffortLevel;
  open: boolean;
  disabled: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onSetEffort: (level: EffortLevel) => void;
}) {
  return (
    <div className="agent-mode-wrap" ref={wrapRef}>
      {open && (
        <div className="agent-mode-menu effort-only" role="menu">
          <EffortBar effort={effort} onSet={onSetEffort} />
        </div>
      )}
      <button
        type="button"
        className="agent-mode-btn agent-effort-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Effort"
        onClick={onToggle}
      >
        <DumbbellIcon className="agent-mode-icon" />
        {EFFORT_LABEL[effort]}
      </button>
    </div>
  );
}

function Composer({
  phase, disabled, turnActive, active, activeFile, mode, onSetMode, effort, onSetEffort,
  attachments, uploading, agentShortName, showModeMenu, showEffortMenu, onPickFiles, onRemoveAttachment, onSend, onStop,
}: {
  phase: 'connecting' | 'live' | 'closed';
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  activeFile: string | null;
  mode: PermMode;
  onSetMode: (mode: PermMode) => void;
  effort: EffortLevel;
  onSetEffort: (level: EffortLevel) => void;
  attachments: Attachment[];
  uploading: boolean;
  agentShortName: string;
  showModeMenu: boolean;
  showEffortMenu: boolean;
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { state } = useApp();
  const [mention, setMention] = useState<{ q: string; from: number } | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  // The composer `+` opens this hidden picker; chosen files are handled
  // by the parent (uploaded into the space + shown as chips).
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Focus when this tab becomes active.
  useEffect(() => { if (active) taRef.current?.focus(); }, [active]);

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

  const placeholder = phase === 'connecting'
    ? 'Connecting…'
    : phase === 'closed'
      ? 'Reconnect to continue…'
      : turnActive
        ? `${agentShortName} is working…`
        : `Message ${agentShortName}…`;

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
    // Allow sending with only attachments (no typed text). The parent
    // clears the shared attachment list once the message is sent.
    if ((!t && attachments.length === 0) || disabled || uploading) return;
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
    // ⇧+Tab cycles the permission mode (matches the dropdown's hint).
    if (showModeMenu && e.key === 'Tab' && e.shiftKey && !disabled) {
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

  return (
    <div className="agent-composer">
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
                  onClick={() => onRemoveAttachment(a.path)}
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
          placeholder={placeholder}
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
            onPickFiles(Array.from(e.target.files ?? []));
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
          {showModeMenu && (
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
          )}
          {showEffortMenu && (
            <EffortMenu
              effort={effort}
              open={modeOpen}
              disabled={disabled}
              wrapRef={modeWrapRef}
              onToggle={() => setModeOpen((o) => !o)}
              onSetEffort={onSetEffort}
            />
          )}
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
