/**
 * Live Codex WebSocket session runtime.
 *
 * One instance owns one app-server process, one persistent thread, turn
 * lifecycle, JSON-RPC correlation, and renderer event normalization.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { WebSocket } from 'ws';
import { buildStashbasePreamble } from './agent-preamble.ts';
import {
  isAgentAccessMode,
  reportAgentRuntimeFailure,
  type AgentAccessMode,
  type AgentClientEvent,
  type AgentServerEvent,
} from './agent-contract.ts';
import {
  approvalTitle,
  codexAccessOptions,
  commandApprovalInput,
  fileChangeApprovalInput,
  isStashbaseWorkspaceEdit,
  isWorkspaceFileChange,
  mcpToolApprovalFromElicitation,
  requestedPermissions,
} from './codex-approval.ts';
import { appVersion, spawnCodexAppServerProcess } from './codex-app-server-process.ts';
import {
  stringValue,
  toolResultFromItem,
  toolStartFromItem,
  type JsonObject,
  type JsonRpcId,
  type ThreadItem,
} from './codex-protocol.ts';
import { CodexRpcPeer } from './codex-rpc-transport.ts';
import { getCurrentFolder, runWithWindowId } from './folder.ts';
import { ensureAgentsFile } from './agent-rules.ts';
import { errorMessage, logger } from './log.ts';
import { noteTreeChanged } from './watcher.ts';

const log = logger('codex-agent');

interface PendingApproval {
  requestId: JsonRpcId;
  method: string;
  params?: JsonObject;
}

class CodexTurnCancelledError extends Error {
  constructor() {
    super('Codex turn cancelled.');
  }
}

export class CodexSession {
  private closed = false;
  private ready = false;
  private appServerReady = false;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdout: readline.Interface | null = null;
  private stderr: readline.Interface | null = null;
  private cwd: string | null = null;
  private threadId: string | null = null;
  private resumeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private busy = false;
  private interruptRequested = false;
  private interruptingTurnId: string | null = null;
  private rpc: CodexRpcPeer | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();

  readonly windowId: string;

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: string,
    resume?: string,
    private accessMode?: AgentAccessMode,
    private onDispose?: (session: CodexSession) => void,
    private spawnProcess: typeof spawnCodexAppServerProcess = spawnCodexAppServerProcess,
  ) {
    this.windowId = normalizeWindowId(windowId);
    this.resumeThreadId = typeof resume === 'string' && resume.trim() ? resume.trim() : null;
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  begin(): void {
    runWithWindowId(this.windowId, () => { void this.start(); });
  }

  private async start(): Promise<void> {
    if (this.closed) return;
    const cwd = getCurrentFolder();
    if (!cwd) {
      this.send({ t: 'error', message: 'No folder open.' });
      this.finish();
      return;
    }
    if (ensureAgentsFile(cwd)) noteTreeChanged();
    this.cwd = cwd;
    this.ready = true;
    this.send({ t: 'ready' });
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServerReady) return;
    if (!this.cwd) throw new Error('No folder open.');
    this.spawnAppServer(this.cwd);
    try {
      await this.request('initialize', {
        clientInfo: { name: 'StashBase', title: null, version: appVersion() },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      });
      this.appServerReady = true;
    } catch (err: unknown) {
      this.disposeAppServer();
      throw err;
    }
  }

  private spawnAppServer(cwd: string): void {
    const proc = this.spawnProcess(cwd, { STASHBASE_WINDOW_ID: this.windowId });
    this.proc = proc;
    const rpc = new CodexRpcPeer((line) => {
      if (!proc.stdin.writable) throw new Error('Codex app-server is not running.');
      proc.stdin.write(`${line}\n`);
    }, {
      onRequest: ({ id, method, params }) => this.onServerRequest({ id, method, params }),
      onNotification: (method, params) => this.onNotification(method, params),
    });
    this.rpc = rpc;

    const stdout = readline.createInterface({ input: proc.stdout });
    this.stdout = stdout;
    stdout.on('line', (line) => rpc.receiveLine(line));

    const stderr = readline.createInterface({ input: proc.stderr });
    this.stderr = stderr;
    stderr.on('line', (line) => {
      const clean = line.trim();
      if (clean) log.debug(clean);
    });

    proc.once('error', (err) => {
      rpc.close(err);
      if (!this.releaseAppServerGeneration(proc, rpc, stdout, stderr)) return;
      reportAgentRuntimeFailure('codex', err);
      if (!this.closed) {
        this.send({ t: 'error', message: errorMessage(err) });
        this.handleAppServerExit(true);
      }
    });
    proc.once('close', (code, signal) => {
      const error = new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`);
      rpc.close(error);
      if (!this.releaseAppServerGeneration(proc, rpc, stdout, stderr)) return;
      if (!this.closed) {
        reportAgentRuntimeFailure('codex', error);
        this.send({ t: 'error', message: error.message });
        this.handleAppServerExit(true);
      }
    });
  }

  private releaseAppServerGeneration(
    proc: ChildProcessWithoutNullStreams,
    rpc: CodexRpcPeer,
    stdout: readline.Interface,
    stderr: readline.Interface,
  ): boolean {
    if (this.proc !== proc || this.rpc !== rpc) return false;
    this.proc = null;
    this.rpc = null;
    if (this.stdout === stdout) this.stdout = null;
    if (this.stderr === stderr) this.stderr = null;
    stdout.close();
    stderr.close();
    return true;
  }

  private onMessage(text: string): void {
    let msg: AgentClientEvent;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.t) {
      case 'prompt': {
        const body = typeof msg.text === 'string' ? msg.text : '';
        const titleHint = typeof msg.titleHint === 'string' ? msg.titleHint : '';
        if (!body.trim()) return;
        void this.runTurn(body, titleHint);
        break;
      }
      case 'steer': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const body = typeof msg.text === 'string' ? msg.text : '';
        if (!id || !body.trim()) return;
        void this.steerTurn(id, body);
        break;
      }
      case 'permission-reply':
        this.onPermissionReply(msg);
        break;
      case 'interrupt':
        void this.interrupt();
        break;
      case 'close':
        this.dispose();
        break;
      case 'set-mode':
        this.accessMode = isAgentAccessMode(msg.mode) ? msg.mode : this.accessMode;
        break;
    }
  }

  private async steerTurn(clientId: string, prompt: string): Promise<void> {
    if (!this.busy || !this.threadId || !this.activeTurnId) {
      this.send({ t: 'steer-result', id: clientId, ok: false, message: 'Codex is not ready to steer this turn.' });
      return;
    }
    try {
      await this.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      this.send({ t: 'steer-result', id: clientId, ok: true });
    } catch (err: unknown) {
      this.send({ t: 'steer-result', id: clientId, ok: false, message: errorMessage(err) });
    }
  }

  private async runTurn(prompt: string, titleHint = ''): Promise<void> {
    if (this.closed) return;
    if (!this.ready || !this.cwd) {
      this.send({ t: 'error', message: 'Codex is not ready yet.' });
      return;
    }
    if (this.busy) {
      this.send({ t: 'error', message: 'Codex is already working on a turn.' });
      return;
    }

    this.busy = true;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.send({ t: 'turn-start' });
    try {
      await this.ensureAppServer();
      this.throwIfInterruptedBeforeTurn();
      const threadId = await this.ensureThread(titleHint);
      this.throwIfInterruptedBeforeTurn();
      const result = await this.request('turn/start', {
        threadId,
        cwd: this.cwd,
        ...codexEffortOption(this.effort),
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      }) as JsonObject;
      const turn = result.turn as JsonObject | undefined;
      const id = stringValue(turn?.id);
      if (this.busy && id) {
        this.activeTurnId = id;
        if (this.interruptRequested) void this.requestInterruptForTurn(id);
      }
    } catch (err: unknown) {
      this.busy = false;
      this.activeTurnId = null;
      if (!this.closed) {
        if (!(err instanceof CodexTurnCancelledError)) {
          this.send({ t: 'error', message: errorMessage(err) });
        }
        this.send({ t: 'turn-end', isError: !(err instanceof CodexTurnCancelledError) });
      }
    }
  }

  private async ensureThread(titleHint = ''): Promise<string> {
    if (this.threadId) return this.threadId;
    if (!this.cwd) throw new Error('No folder open.');
    await this.ensureAppServer();
    const isNewThread = !this.resumeThreadId;
    const access = codexAccessOptions(this.accessMode);
    const common = {
      cwd: this.cwd,
      approvalPolicy: access.approvalPolicy,
      approvalsReviewer: access.approvalsReviewer,
      sandbox: access.sandbox,
      developerInstructions: buildStashbasePreamble(this.cwd),
    };
    const result = await this.request(
      this.resumeThreadId ? 'thread/resume' : 'thread/start',
      this.resumeThreadId
        ? { ...common, threadId: this.resumeThreadId }
        : { ...common, threadSource: 'user' },
    ) as JsonObject;
    const thread = result.thread as JsonObject | undefined;
    const id = stringValue(thread?.id);
    if (!id) throw new Error('Codex app-server did not return a thread id.');
    const shouldSendSessionId = this.threadId !== id;
    this.threadId = id;
    this.resumeThreadId = null;
    if (shouldSendSessionId) this.send({ t: 'session-id', id });
    if (isNewThread) {
      const title = titleFromPrompt(titleHint);
      if (title) {
        this.send({ t: 'session-title', title });
        await this.request('thread/name/set', { threadId: id, name: title })
          .catch((err: unknown) => log.warn(`Codex title set failed for ${id}: ${errorMessage(err)}`));
      }
    }
    return id;
  }

  private async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.interruptRequested = true;
    if (!this.threadId || !this.activeTurnId) return;
    await this.requestInterruptForTurn(this.activeTurnId);
  }

  private throwIfInterruptedBeforeTurn(): void {
    if (this.interruptRequested && !this.activeTurnId) throw new CodexTurnCancelledError();
  }

  private async requestInterruptForTurn(turnId: string): Promise<void> {
    if (!this.threadId || this.interruptingTurnId === turnId) return;
    this.interruptingTurnId = turnId;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId });
    } catch (err: unknown) {
      if (!this.closed) this.send({ t: 'error', message: errorMessage(err) });
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.rpc?.request(method, params)
      ?? Promise.reject(new Error('Codex app-server is not running.'));
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.rpc?.respond(id, result);
    } catch (err: unknown) {
      log.warn(`failed responding to Codex app-server request: ${errorMessage(err)}`);
    }
  }

  private rejectRequest(id: JsonRpcId, message: string, code = -32603): void {
    try {
      this.rpc?.reject(id, message, code);
    } catch (err: unknown) {
      log.warn(`failed rejecting Codex app-server request: ${errorMessage(err)}`);
    }
  }

  private onServerRequest(msg: JsonObject): void {
    const method = msg.method as string;
    const id = msg.id as JsonRpcId;
    const params = (msg.params && typeof msg.params === 'object') ? msg.params as JsonObject : {};
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'Bash',
          title: approvalTitle(params.reason, params.command, 'Allow Codex to run this command?'),
          input: commandApprovalInput(params),
        });
        break;
      }
      case 'item/fileChange/requestApproval': {
        // Edit is deliberately narrow: ordinary changes within the opened
        // folder do not need a click per edit, but a broader filesystem grant
        // must stay on the shared approval-card path. Keeping the app-server
        // policy at on-request also leaves command, network, and sandbox
        // escalation approvals visible instead of making Edit a bypass.
        if (this.accessMode === 'acceptEdits' && isWorkspaceFileChange(params, this.cwd)) {
          this.respond(id, { decision: 'accept' });
          break;
        }
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'File change',
          title: approvalTitle(params.reason, params.grantRoot, 'Allow Codex to change files?'),
          input: fileChangeApprovalInput(params),
        });
        break;
      }
      case 'item/permissions/requestApproval': {
        const approvalId = `codex-${String(id)}`;
        const itemId = stringValue(params.itemId) || approvalId;
        this.pendingApprovals.set(approvalId, { requestId: id, method, params });
        this.send({
          t: 'permission',
          id: approvalId,
          toolUseId: itemId,
          name: 'Permissions',
          title: approvalTitle(params.reason, params.cwd, 'Allow Codex to use requested permissions?'),
          input: {
            cwd: stringValue(params.cwd),
            reason: stringValue(params.reason),
            permissions: params.permissions ?? {},
          },
        });
        break;
      }
      case 'mcpServer/elicitation/request': {
        const approval = mcpToolApprovalFromElicitation(params);
        if (approval) {
          if (this.accessMode === 'acceptEdits' && isStashbaseWorkspaceEdit(approval, this.cwd)) {
            this.respond(id, { action: 'accept', content: {}, _meta: null });
            break;
          }
          const approvalId = `codex-${String(id)}`;
          this.pendingApprovals.set(approvalId, { requestId: id, method, params });
          this.send({
            t: 'permission',
            id: approvalId,
            toolUseId: approval.toolUseId || approvalId,
            name: approval.name,
            title: approval.title,
            input: approval.input,
          });
          break;
        }
        this.respond(id, { action: 'cancel', content: null, _meta: null });
        this.sendThinking(protocolNoticeFromParams(params) || 'Codex requested MCP user input; StashBase cancelled that prompt. Send the requested details as a follow-up message if needed.');
        break;
      }
      case 'item/tool/requestUserInput':
        this.respond(id, { answers: {} });
        this.sendThinking(protocolNoticeFromParams(params) || 'Codex requested additional user input; send the details as a follow-up message if needed.');
        break;
      case 'item/tool/call':
        this.respond(id, { contentItems: [], success: false });
        this.sendThinking(`Codex requested unsupported dynamic tool ${toolNameFromRequest(params)}.`);
        break;
      case 'account/chatgptAuthTokens/refresh':
        this.respond(id, null);
        break;
      case 'attestation/generate':
        this.respond(id, null);
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.rejectRequest(id, `StashBase does not support Codex app-server request ${method}.`, -32601);
        break;
      default:
        this.rejectRequest(id, `StashBase does not support Codex app-server request ${method}.`, -32601);
        break;
    }
  }

  private onPermissionReply(msg: { [k: string]: unknown }): void {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    const allow = msg.allow === true;
    const always = msg.always === true;
    if (pending.method === 'item/commandExecution/requestApproval') {
      this.respond(pending.requestId, { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' });
      return;
    }
    if (pending.method === 'item/fileChange/requestApproval') {
      this.respond(pending.requestId, { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' });
      return;
    }
    if (pending.method === 'item/permissions/requestApproval') {
      this.respond(pending.requestId, {
        permissions: allow ? requestedPermissions(pending.params) : {},
        scope: always ? 'session' : 'turn',
      });
      return;
    }
    if (pending.method === 'mcpServer/elicitation/request') {
      this.respond(pending.requestId, {
        action: allow ? 'accept' : 'decline',
        content: allow ? {} : null,
        _meta: null,
      });
      return;
    }
    this.rejectRequest(pending.requestId, 'Unsupported approval request.');
  }

  private onNotification(method: string, params: JsonObject): void {
    switch (method) {
      case 'thread/started': {
        const threadId = stringValue(params.threadId) || stringValue((params.thread as JsonObject | undefined)?.id);
        if (threadId && !this.threadId) {
          this.threadId = threadId;
          this.send({ t: 'session-id', id: threadId });
        }
        break;
      }
      case 'turn/started': {
        const turn = params.turn as JsonObject | undefined;
        const turnId = stringValue(turn?.id);
        if (turnId) {
          this.activeTurnId = turnId;
          if (this.interruptRequested) void this.requestInterruptForTurn(turnId);
        }
        break;
      }
      case 'item/agentMessage/delta':
        this.sendText(params.delta);
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        this.sendThinking(params.delta);
        break;
      case 'item/started':
        this.onItemStarted(params.item);
        break;
      case 'item/completed':
        this.onItemCompleted(params.item);
        break;
      case 'item/commandExecution/outputDelta':
      case 'item/process/outputDelta':
      case 'item/tool/outputDelta':
        this.onToolOutputDelta(params);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params);
        break;
      case 'error':
        this.onErrorNotification(params);
        break;
      case 'warning':
      case 'guardianWarning':
      case 'configWarning': {
        const message = notificationMessage(params);
        if (message) this.send({ t: 'error', message });
        break;
      }
      default:
        break;
    }
  }

  private onItemStarted(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const tool = toolStartFromItem(item as ThreadItem);
    if (tool) this.send({ t: 'tool', id: tool.id, name: tool.name, input: tool.input });
  }

  private onItemCompleted(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const result = toolResultFromItem(item as ThreadItem);
    if (result) this.send({ t: 'tool-result', id: result.id, content: result.content, isError: result.isError });
  }

  private onTurnCompleted(params: JsonObject): void {
    const turn = params.turn as JsonObject | undefined;
    const status = stringValue(turn?.status);
    const error = turn?.error as JsonObject | undefined;
    const message = stringValue(error?.message);
    if (message) this.send({ t: 'error', message });
    this.busy = false;
    this.activeTurnId = null;
    this.interruptRequested = false;
    this.interruptingTurnId = null;
    this.send({ t: 'turn-end', isError: status === 'failed' || !!message });
  }

  private onErrorNotification(params: JsonObject): void {
    const message = notificationMessage(params) || 'Codex reported an error.';
    this.send({ t: 'error', message });
    if (params.willRetry === false) {
      this.busy = false;
      this.activeTurnId = null;
      this.interruptRequested = false;
      this.interruptingTurnId = null;
      this.send({ t: 'turn-end', isError: true });
    }
  }

  private onToolOutputDelta(params: JsonObject): void {
    const delta = toolOutputDeltaFromParams(params);
    if (delta) this.send({ t: 'tool-delta', id: delta.id, delta: delta.delta });
  }

  private sendText(delta: unknown): void {
    if (typeof delta === 'string' && delta) this.send({ t: 'text', delta });
  }

  private sendThinking(delta: unknown): void {
    if (typeof delta === 'string' && delta) this.send({ t: 'thinking', delta });
  }

  private send(obj: AgentServerEvent): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  private finish(): void {
    if (this.closed) return;
    this.send({ t: 'exit' });
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onDispose?.(this);
    for (const [, pending] of this.pendingApprovals) {
      this.respond(pending.requestId, { decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.disposeAppServer();
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private disposeAppServer(): void {
    this.appServerReady = false;
    const rpc = this.rpc;
    const proc = this.proc;
    const stdout = this.stdout;
    const stderr = this.stderr;
    this.rpc = null;
    this.proc = null;
    this.stdout = null;
    this.stderr = null;
    rpc?.close(new Error('Codex session closed.'));
    stdout?.close();
    stderr?.close();
    if (proc) try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private handleAppServerExit(isError: boolean): void {
    this.appServerReady = false;
    if (this.busy) {
      this.busy = false;
      this.activeTurnId = null;
      this.interruptRequested = false;
      this.interruptingTurnId = null;
      this.send({ t: 'turn-end', isError });
      return;
    }
  }
}


function toolOutputDeltaFromParams(params: JsonObject): { id: string; delta: string } | null {
  const id = stringValue(params.itemId)
    || stringValue(params.item_id)
    || stringValue(params.toolUseId)
    || stringValue(params.tool_use_id)
    || stringValue(params.id);
  if (!id) return null;
  const delta = outputDeltaText(params.delta)
    || outputDeltaText(params.output)
    || outputDeltaText(params.text)
    || outputDeltaText(params.chunk);
  if (!delta) return null;
  const stream = stringValue(params.stream);
  return { id, delta: stream && stream !== 'stdout' ? `[${stream}] ${delta}` : delta };
}

function outputDeltaText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const obj = value as JsonObject;
  return stringValue(obj.text) || stringValue(obj.content) || stringValue(obj.output);
}

function protocolNoticeFromParams(params: JsonObject): string {
  const message = notificationMessage(params);
  if (message) return message;
  const prompt = stringValue(params.prompt) || stringValue(params.message);
  return prompt;
}

function notificationMessage(params: JsonObject): string {
  const direct = stringValue(params.message);
  if (direct) return direct;
  const error = params.error;
  if (error && typeof error === 'object') {
    const fromError = stringValue((error as JsonObject).message);
    if (fromError) return fromError;
  }
  return '';
}

function toolNameFromRequest(params: JsonObject): string {
  return [stringValue(params.namespace), stringValue(params.tool)].filter(Boolean).join(':') || 'tool';
}

function codexEffortOption(effort: string | undefined): { effort?: string } {
  if (!effort) return {};
  if (effort === 'max') return { effort: 'xhigh' };
  return ['low', 'medium', 'high', 'xhigh'].includes(effort) ? { effort } : {};
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  if (!firstLine) return '';
  const compact = firstLine.replace(/\s+/g, ' ');
  return compact.length > 60 ? `${compact.slice(0, 60).trimEnd()}…` : compact;
}




const sessions = new Set<CodexSession>();

export function attachCodexWebSocket(ws: WebSocket, windowId = 'default', effort?: string, resume?: string, access?: AgentAccessMode): void {
  const session = new CodexSession(ws, windowId, effort, resume, access, (s) => sessions.delete(s));
  sessions.add(session);
  session.begin();
}

export function killActiveCodex(windowId?: string): void {
  for (const session of [...sessions]) {
    if (!windowId || session.windowId === windowId) {
      session.dispose();
      sessions.delete(session);
    }
  }
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : 'default';
}
