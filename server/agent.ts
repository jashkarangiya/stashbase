/**
 * Structured-agent sidecar. Where `terminal.ts` bridges a raw PTY to an
 * xterm, this bridges the **Claude Agent SDK** to a WebSocket as a
 * stream of structured panel events (text / thinking / tool calls /
 * permission prompts), so the renderer can paint a VSCode-style chat
 * panel instead of a terminal. One session per chat tab; switching
 * spaces tears every session down (the SDK's cwd is then stale).
 *
 * Auth: the SDK reads the same credential store the user's `claude`
 * login populated (Keychain / `~/.claude`), so a Pro/Max subscription
 * works with no API key — see design-docs/chat-panel.md.
 *
 * Wire protocol (line-delimited JSON over one ws):
 *   client → server:
 *     { t: "prompt", text }
 *     { t: "permission-reply", id, allow, always? }
 *     { t: "set-mode", mode }                           // switch permission mode live
 *     { t: "interrupt" }
 *     { t: "close" }
 *   server → client:
 *     { t: "ready" }                                   // SDK session up
 *     { t: "session-id", id }                          // SDK session_id (for history/resume)
 *     { t: "turn-start" }                              // prompt accepted
 *     { t: "text", delta }                             // streaming assistant text
 *     { t: "thinking", delta }                         // streaming thinking
 *     { t: "tool", id, name, input }                   // tool call began
 *     { t: "tool-result", id, content, isError }       // its result
 *     { t: "permission", id, toolUseId, name, title, input }  // needs approve/reject
 *     { t: "turn-end", isError }                       // result message
 *     { t: "error", message }
 *     { t: "exit" }                                    // session ended
 */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
  type PermissionMode,
  type EffortLevel,
} from '@anthropic-ai/claude-agent-sdk';
import { logger, errorMessage } from './log.ts';
import { getCurrentSpace, runWithWindowId } from './space.ts';

const log = logger('agent');

/** Tools we run without prompting — reads, searches, listings. Anything
 *  that writes (Edit / Write / Bash / MCP mutations) falls through to a
 *  permission prompt so the user sees a diff and approves. Keeping the
 *  prompt set small is what makes the panel pleasant instead of a
 *  click-through wall. */
function needsPrompt(name: string): boolean {
  if (['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return true;
  // MCP mutations: mcp__stashbase__write_file / delete_file / rename_file / …
  if (/^mcp__/.test(name) && /(write|delete|rename|update|set_|create)/i.test(name)) return true;
  return false;
}

/** Minimal pushable async-iterable — the streaming-input channel the SDK
 *  consumes. We `push()` a user message per prompt; the generator the SDK
 *  awaits yields them as they arrive, and stays open (so the session is
 *  long-lived) until `end()`. */
class Pushable<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(v: T): void {
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.values.push(v);
  }

  end(): void {
    this.done = true;
    let r: ((r: IteratorResult<T>) => void) | undefined;
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

interface Pending {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

/** One live Agent-SDK session bridged to one WebSocket. */
class AgentSession {
  private input = new Pushable<SDKUserMessage>();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  /** The SDK session_id, captured from the init message. Sent to the
   *  client so the history dropdown can mark this session active. */
  private sessionId: string | null = null;

  constructor(private ws: WebSocket, readonly windowId: string, private effort?: EffortLevel, private resume?: string) {
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
    runWithWindowId(this.windowId, () => this.start());
  }

  private start(): void {
    const cwd = getCurrentSpace();
    if (!cwd) {
      this.send({ t: 'error', message: 'No space open.' });
      this.send({ t: 'exit' });
      return;
    }
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd,
          includePartialMessages: true,
          permissionMode: 'default',
          // Resuming a past session loads its conversation history so the
          // user can continue it. The transcript itself is rendered from
          // getSessionMessages on the client; `resume` only primes the SDK
          // to append to the same session_id rather than start a new one.
          ...(this.resume ? { resume: this.resume } : {}),
          // Thinking depth (low … max). The SDK has no live setter for this
          // (unlike permissionMode), so it's fixed for the session's lifetime
          // — the renderer reconnects to change it. Omit → SDK default ('high').
          ...(this.effort ? { effort: this.effort } : {}),
          // Load the user's global config + the space's project/local
          // settings so the panel sees the same CLAUDE.md, skills, and
          // MCP servers the terminal Claude does (incl. StashBase's KB
          // MCP wired into ~/.claude.json). Without this the SDK runs
          // bare — no project context, no MCP.
          settingSources: ['user', 'project', 'local'],
          env: {
            ...process.env,
            // Don't let a Node-based CLI pick up Electron's internal node.
            ELECTRON_RUN_AS_NODE: undefined,
            // Route this session's MCP tools back to this window's host.
            STASHBASE_WINDOW_ID: this.windowId,
          } as NodeJS.ProcessEnv,
          canUseTool: (name, input, opts) => this.onPermission(name, input, opts),
          stderr: (d: string) => log.debug(d),
        },
      });
    } catch (err: unknown) {
      this.send({ t: 'error', message: errorMessage(err) });
      this.send({ t: 'exit' });
      return;
    }
    this.send({ t: 'ready' });
    void this.pump();
  }

  /** Drain the SDK message stream until it ends or errors. */
  private async pump(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const msg of this.q) this.onSdkMessage(msg);
    } catch (err: unknown) {
      if (!this.closed) this.send({ t: 'error', message: errorMessage(err) });
    }
    if (!this.closed) this.send({ t: 'exit' });
  }

  private onSdkMessage(msg: SDKMessage): void {
    // Every SDK message carries the session_id; capture + surface it the
    // first time we see one (the init `system` message) so the history
    // dropdown can mark the live session active and resume targets it.
    const sid = (msg as { session_id?: unknown }).session_id;
    if (!this.sessionId && typeof sid === 'string' && sid) {
      this.sessionId = sid;
      this.send({ t: 'session-id', id: sid });
    }
    switch (msg.type) {
      case 'stream_event': {
        // Partial deltas → typewriter streaming for text + thinking.
        const ev = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            this.send({ t: 'text', delta: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            this.send({ t: 'thinking', delta: ev.delta.thinking });
          }
        }
        break;
      }
      case 'assistant': {
        // Text/thinking already streamed via stream_event; here we only
        // surface the complete tool_use blocks (which carry the id we
        // match tool-result + permission against).
        const content = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.send({ t: 'tool', id: block.id, name: block.name, input: block.input });
          }
        }
        break;
      }
      case 'user': {
        // Tool results come back as a user-role message of tool_result blocks.
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content as unknown as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') {
              this.send({
                t: 'tool-result',
                id: block.tool_use_id,
                content: stringifyToolResult(block.content),
                isError: block.is_error === true,
              });
            }
          }
        }
        break;
      }
      case 'result': {
        this.send({ t: 'turn-end', isError: msg.is_error === true });
        break;
      }
      default:
        break;
    }
  }

  /** SDK permission callback. Auto-allow reads; round-trip writes/exec to
   *  the client and await the user's approve/reject. */
  private onPermission(
    name: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string },
  ): Promise<PermissionResult> {
    if (!needsPrompt(name)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    return new Promise<PermissionResult>((resolve) => {
      const id = randomUUID();
      this.pending.set(id, { resolve, input, suggestions: opts.suggestions });
      this.send({ t: 'permission', id, toolUseId: opts.toolUseID, name, title: opts.title ?? null, input });
      opts.signal.addEventListener('abort', () => {
        if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Interrupted.' });
      });
    });
  }

  private onMessage(text: string): void {
    let msg: { t: string; [k: string]: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        if (!body.trim()) return;
        this.send({ t: 'turn-start' });
        this.input.push({
          type: 'user',
          message: { role: 'user', content: body },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        break;
      }
      case 'permission-reply': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (msg.allow) {
          p.resolve({
            behavior: 'allow',
            updatedInput: p.input,
            ...(msg.always && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
          });
        } else {
          p.resolve({ behavior: 'deny', message: 'User rejected this action.' });
        }
        break;
      }
      case 'set-mode': {
        // Live permission-mode switch from the composer's Modes dropdown.
        // 'default' = ask before edits, 'acceptEdits' = auto-apply edits
        // (Bash still prompts via canUseTool), 'plan' = read-only planning,
        // 'auto' = model classifier decides. We don't expose the dangerous
        // 'bypassPermissions' / 'dontAsk'.
        const allowed: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
        const mode = msg.mode as PermissionMode;
        if (allowed.includes(mode)) {
          void this.q?.setPermissionMode(mode).catch((err) => log.debug(errorMessage(err)));
        }
        break;
      }
      case 'interrupt':
        void this.q?.interrupt().catch(() => { /* not streaming yet */ });
        break;
      case 'close':
        this.dispose();
        break;
    }
  }

  private send(obj: unknown): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    // Resolve any dangling permission prompts so the SDK loop unwinds.
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.pending.clear();
    void this.q?.interrupt().catch(() => { /* already gone */ });
    this.input.end();
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/** Stringify a tool_result `content` (string, or an array of text/other
 *  blocks) into something renderable. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Live agent sessions — one per structured chat tab. Space switch tears
 *  them all down (the SDK cwd is then meaningless). */
const sessions = new Set<AgentSession>();

export function attachAgentWebSocket(ws: WebSocket, windowId = 'default', effort?: string, resume?: string): void {
  const session = new AgentSession(ws, windowId, effort as EffortLevel | undefined, resume);
  sessions.add(session);
  ws.on('close', () => { sessions.delete(session); });
}

/** Kill every live agent session (optionally for one window). Called on
 *  space switch / close — the session's cwd no longer makes sense. */
export function killActiveAgent(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}
