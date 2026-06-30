/**
 * Structured chat view for an agent tab — the VSCode-extension-style
 * panel. Claude connects to `/ws/agent` (Claude Agent SDK, see
 * server/agent.ts); Codex connects to `/ws/codex` (Codex app-server
 * structured session, see server/codex-agent.ts).
 * Both render the event stream as ordered blocks:
 * user / assistant bubbles, collapsible thinking, tool cards with
 * inline diffs + approve/reject, and error notices. A composer at the
 * bottom sends prompts, stops a running turn, takes dropped files, and
 * `@`-mentions library files.
 *
 * This is Phase 1 of design-docs/chat-panel.md.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { api, getWindowId, type AgentContextFile } from '../api';
import { FILE_MIME } from '../dragMime';
import { acceptsAgentContextDrop, dragPayloadKinds } from '../dragRouting';
import { useApp } from '../store/AppContext';
import { getActiveTab, type ChatTab } from '../store/state';
import { ClaudeIcon, CodexIcon, NewChatIcon } from '../icons';
import { AgentComposer } from './agent/AgentComposer';
import { AgentHistoryMenu } from './agent/AgentHistoryMenu';
import { MessageList } from './agent/AgentMessages';
import { baseName, mergeAttachments, readImageDims } from './agent/attachments';
import type { AgentKind, Attachment, Block, EffortLevel, PermMode, ServerEvent, ToolBlock } from './agent/types';

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
  const folderPathRef = useRef(state.folderPath);
  folderPathRef.current = state.folderPath;
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
   *  reopens a folder). */
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
            const toolFolder = folderPathRef.current;
            const createdFile = fileInCurrentFolderFromToolResult(toolName, ev.content, toolFolder);
            void (async () => {
              await api.sync(toolFolder).catch(() => { /* turn-end / next poll will surface it */ });
              if (folderPathRef.current !== toolFolder) return;
              await actions.loadFiles();
              if (folderPathRef.current !== toolFolder) return;
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
          const turnFolder = folderPathRef.current;
          void api.sync(turnFolder || undefined)
            .catch(() => { /* next status poll surfaces it */ })
            .finally(() => {
              if (folderPathRef.current === turnFolder) void actions.refreshIndexState();
            });
        }
        break;
      case 'error':
        openKind.current = null;
        // An error before the session is ready is fatal (e.g. no folder
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
    // attachments (temp uploads = absolute, sidebar files = folder-relative)
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

  async function resolveFolderContext(path: string): Promise<AgentContextFile | null> {
    if (!knownFilePaths.has(path)) return null;
    try {
      return await api.agentContextFile(folderPathRef.current, path);
    } catch {
      return null;
    }
  }

  async function formatCurrentFileContext(path: string): Promise<string> {
    const ctx = await resolveFolderContext(path);
    if (ctx?.kind === 'derived') {
      return [
        `Current file (open in the viewer): ${ctx.sourcePath}`,
        `For text context, read the extracted Markdown filesystem path first: ${ctx.readPath}`,
        `Only read the original ${ctx.sourceFormat} if you need raw visual or binary detail.`,
      ].join('\n');
    }
    if (ctx && !ctx.available && ctx.sourceFormat === 'pdf') {
      return [
        `Current file (open in the viewer): ${ctx.sourcePath}`,
        `Extracted Markdown is not available yet for this ${ctx.sourceFormat}; read the original only if necessary.`,
      ].join('\n');
    }
    return `Current file (open in the viewer): ${path}`;
  }

  async function formatAttachmentContext(att: Attachment): Promise<string> {
    const ctx = await resolveFolderContext(att.path);
    if (ctx?.kind === 'derived') {
      return `- ${ctx.sourcePath} (read extracted Markdown filesystem path first: ${ctx.readPath}; use the original ${ctx.sourceFormat} only for raw visual or binary detail)`;
    }
    if (ctx && !ctx.available && ctx.sourceFormat === 'pdf') {
      return `- ${ctx.sourcePath} (extracted Markdown is not available yet; read the original only if necessary)`;
    }
    return `- ${att.path}`;
  }

  /** Attach OS files (dropped from Finder or picked via `+`) as transient
   *  context: they're written to a temp dir OUTSIDE the folder (so they
   *  never enter the library / file tree / index) and referenced by absolute
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

  /** Add chips for files already in the folder (dragged from the sidebar);
   *  no upload needed — just reference their existing path. */
  function addFolderFiles(paths: string[]) {
    const clean = paths.filter((p) => p && knownFilePaths.has(p));
    const skipped = paths.filter((p) => p && !knownFilePaths.has(p)).length;
    if (skipped) actions.toast('Only files from the current folder can be attached.', { level: 'warning' });
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
  // NOT the folder); sidebar files (FILE_MIME) reference their existing
  // path. `stopPropagation` is load-bearing: it stops the event before it
  // reaches the window-level `useGlobalDragDrop` listener, which would
  // otherwise *also* fire and import the file into the folder.
  function onPanelDragOver(e: React.DragEvent) {
    const kinds = dragPayloadKinds(e.dataTransfer);
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // The sidebar drag source sets effectAllowed='move'; match it so the
    // drop isn't silently cancelled (OS files accept 'copy').
    e.dataTransfer.dropEffect = kinds.internalFile && !kinds.osFiles ? 'move' : 'copy';
    if (phase === 'live') setDragOver(true);
  }
  function onPanelDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the panel, not when it
    // crosses between child elements.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }
  function onPanelDrop(e: React.DragEvent) {
    if (!acceptsAgentContextDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (phase !== 'live') return;
    const osFiles = Array.from(e.dataTransfer.files ?? []);
    if (osFiles.length) void uploadFiles(osFiles);
    else {
      const filePath = e.dataTransfer.getData(FILE_MIME);
      if (filePath) addFolderFiles([filePath]);
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
            <AgentHistoryMenu
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
                {/No folder open/i.test(fatal)
                  ? 'No folder is open. Open a folder, then retry.'
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
      <AgentComposer
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

function fileInCurrentFolderFromToolResult(toolName: string | undefined, content: string, folder: string): string | null {
  if (!toolName || !/write_file$/i.test(toolName) || !folder) return null;
  try {
    const parsed = JSON.parse(content) as { path?: unknown; ok?: unknown };
    if (parsed.ok !== true || typeof parsed.path !== 'string') return null;
    const prefix = `${folder}/`;
    if (!parsed.path.startsWith(prefix)) return null;
    const rel = parsed.path.slice(prefix.length);
    return isSafeFolderRelativePath(rel) ? rel : null;
  } catch {
    return null;
  }
}

function isSafeFolderRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
