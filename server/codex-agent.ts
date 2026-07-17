/**
 * Codex app-server sidecar for the structured chat panel.
 *
 * Claude uses the Claude Agent SDK directly (server/agent.ts). Codex's
 * locally installed CLI exposes the same kind of long-lived structured
 * agent runtime through `codex app-server --listen stdio://`: a JSON-RPC
 * protocol with thread/start, turn/start, turn/interrupt, structured item
 * notifications, and approval requests. This bridge keeps the renderer's
 * lightweight WebSocket protocol stable while backing each Codex chat tab
 * with one app-server process + one persistent Codex thread.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { WebSocket } from 'ws';
import { buildStashbasePreamble } from './agent-preamble.ts';
import { logger, errorMessage } from './log.ts';
import { getCurrentFolder, runWithWindowId } from './folder.ts';
import { agentCliEnv, agentCliNeedsShell, commandDir, resolveAgentCli } from './agent-cli.ts';
import { ensureAgentsFile } from './agent-rules.ts';
import { noteTreeChanged } from './watcher.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isAgentAccessMode, reportAgentRuntimeFailure, type AgentAccessMode, type AgentClientEvent, type AgentServerEvent } from './agent-contract.ts';

const log = logger('codex-agent');

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;
type RpcResolve = (value: unknown) => void;
type RpcReject = (error: Error) => void;

interface PendingRpc {
  resolve: RpcResolve;
  reject: RpcReject;
}

interface PendingApproval {
  requestId: JsonRpcId;
  method: string;
  params?: JsonObject;
}

interface ThreadItem {
  type?: unknown;
  id?: unknown;
  [key: string]: unknown;
}

class CodexTurnCancelledError extends Error {
  constructor() {
    super('Codex turn cancelled.');
  }
}

function resolveCodexBinary(): string | null {
  return resolveAgentCli({
    name: 'codex',
    envNames: ['STASHBASE_CODEX_BIN', 'CODEX_CLI_BIN', 'CODEX_CLI_PATH'],
    logLabel: 'Codex',
  }, (message) => log.warn(message));
}

function spawnCodexAppServerProcess(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const command = resolveCodexBinary();
  if (!command) throw new Error('Codex CLI not found. Install Codex or set STASHBASE_CODEX_BIN to the codex executable.');
  log.info(`spawning Codex app-server via ${command}`);
  return spawn(command, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: agentCliEnv(extraEnv, [commandDir(command)]),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: agentCliNeedsShell(command),
  });
}

class CodexSession {
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
  private nextRequestId = 1;
  private pendingRpc = new Map<JsonRpcId, PendingRpc>();
  private pendingApprovals = new Map<string, PendingApproval>();

  readonly windowId: string;

  constructor(
    private ws: WebSocket,
    windowId: string,
    private effort?: string,
    resume?: string,
    private accessMode?: AgentAccessMode,
    private onDispose?: (session: CodexSession) => void,
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
    const proc = spawnCodexAppServerProcess(cwd, { STASHBASE_WINDOW_ID: this.windowId });
    this.proc = proc;

    this.stdout = readline.createInterface({ input: proc.stdout });
    this.stdout.on('line', (line) => this.onRpcLine(line));

    this.stderr = readline.createInterface({ input: proc.stderr });
    this.stderr.on('line', (line) => {
      const clean = line.trim();
      if (clean) log.debug(clean);
    });

    proc.once('error', (err) => {
      reportAgentRuntimeFailure('codex', err);
      this.rejectAll(errorFromUnknown(err));
      if (!this.closed) {
        this.send({ t: 'error', message: errorMessage(err) });
        this.handleAppServerExit(true);
      }
    });
    proc.once('close', (code, signal) => {
      this.proc = null;
      this.rejectAll(new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
      if (!this.closed) {
        const error = new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`);
        reportAgentRuntimeFailure('codex', error);
        this.send({ t: 'error', message: error.message });
        this.handleAppServerExit(true);
      }
    });
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
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }
    const id = this.nextRequestId++;
    const msg = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
      try {
        this.proc?.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch (err: unknown) {
        this.pendingRpc.delete(id);
        reject(errorFromUnknown(err));
      }
    });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ id, result })}\n`);
    } catch (err: unknown) {
      log.warn(`failed responding to Codex app-server request: ${errorMessage(err)}`);
    }
  }

  private rejectRequest(id: JsonRpcId, message: string, code = -32603): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    } catch (err: unknown) {
      log.warn(`failed rejecting Codex app-server request: ${errorMessage(err)}`);
    }
  }

  private onRpcLine(line: string): void {
    let msg: JsonObject;
    try { msg = JSON.parse(line) as JsonObject; } catch { return; }

    if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      this.onRpcResponse(msg);
      return;
    }
    if (typeof msg.method !== 'string') return;
    if ('id' in msg) this.onServerRequest(msg);
    else this.onNotification(msg.method, (msg.params && typeof msg.params === 'object') ? msg.params as JsonObject : {});
  }

  private onRpcResponse(msg: JsonObject): void {
    const id = msg.id as JsonRpcId;
    const pending = this.pendingRpc.get(id);
    if (!pending) return;
    this.pendingRpc.delete(id);
    if ('error' in msg) {
      pending.reject(rpcError(msg.error));
    } else {
      pending.resolve(msg.result);
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
    this.rejectAll(new Error('Codex session closed.'));
    for (const [, pending] of this.pendingApprovals) {
      this.respond(pending.requestId, { decision: 'cancel' });
    }
    this.pendingApprovals.clear();
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = null;
    this.stderr = null;
    this.disposeAppServer();
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pendingRpc) pending.reject(err);
    this.pendingRpc.clear();
  }

  private disposeAppServer(): void {
    this.appServerReady = false;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
      this.proc = null;
    }
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

function toolStartFromItem(item: ThreadItem): { id: string; name: string; input: JsonObject } | null {
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (!type || !id) return null;
  switch (type) {
    case 'commandExecution':
      return {
        id,
        name: 'Bash',
        input: {
          command: stringValue(item.command),
          cwd: stringValue(item.cwd),
          // Codex's app-server classifies shell work (read/list/search) as
          // well as carrying the literal command. Preserve that structured
          // data so the renderer can show an activity trace instead of only
          // a generic "Bash" status.
          actions: Array.isArray(item.commandActions) ? item.commandActions : [],
        },
      };
    case 'fileChange':
      return { id, name: 'File change', input: { changes: item.changes ?? [] } };
    case 'mcpToolCall':
      return {
        id,
        name: `${stringValue(item.server) || 'mcp'}:${stringValue(item.tool) || 'tool'}`,
        input: objectValue(item.arguments),
      };
    case 'dynamicToolCall':
      return {
        id,
        name: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join(':') || 'tool',
        input: objectValue(item.arguments),
      };
    case 'webSearch':
      return { id, name: 'Web search', input: { query: stringValue(item.query) } };
    default:
      return null;
  }
}

function toolResultFromItem(item: ThreadItem): { id: string; content: string; isError: boolean } | null {
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (!type || !id) return null;
  switch (type) {
    case 'commandExecution':
      return {
        id,
        content: stringValue(item.aggregatedOutput) || exitSummary(item.exitCode),
        isError: typeof item.exitCode === 'number' && item.exitCode !== 0,
      };
    case 'fileChange':
      return { id, content: stringifyCodexValue(item.changes ?? []), isError: stringValue(item.status) === 'failed' };
    case 'mcpToolCall': {
      const error = item.error;
      return {
        id,
        content: error ? stringifyCodexValue(error) : stringifyCodexValue(item.result),
        isError: !!error || stringValue(item.status) === 'failed',
      };
    }
    case 'dynamicToolCall':
      return {
        id,
        content: stringifyCodexValue(item.contentItems ?? []),
        isError: item.success === false || stringValue(item.status) === 'failed',
      };
    case 'webSearch':
      return { id, content: stringifyCodexValue(item.action ?? ''), isError: false };
    default:
      return null;
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

function approvalTitle(reason: unknown, detail: unknown, fallback: string): string {
  const r = stringValue(reason);
  if (r) return r;
  const d = stringValue(detail);
  return d ? `${fallback} ${d}` : fallback;
}

function commandApprovalInput(params: JsonObject): JsonObject {
  return {
    command: stringValue(params.command),
    cwd: stringValue(params.cwd),
    reason: stringValue(params.reason),
    commandActions: params.commandActions ?? [],
  };
}

function fileChangeApprovalInput(params: JsonObject): JsonObject {
  return {
    itemId: stringValue(params.itemId),
    reason: stringValue(params.reason),
    grantRoot: stringValue(params.grantRoot),
  };
}

function mcpToolApprovalFromElicitation(params: JsonObject): {
  toolUseId: string;
  name: string;
  title: string;
  input: JsonObject;
} | null {
  const meta = objectValue(params._meta);
  const kind = stringValue(meta.codex_approval_kind) || stringValue(meta.approval_kind);
  const tool = stringValue(meta.tool_name)
    || stringValue(meta.toolName)
    || stringValue(meta.tool)
    || stringValue(params.tool_name)
    || stringValue(params.toolName)
    || stringValue(params.tool);
  if (kind !== 'mcp_tool_call' && !tool) return null;

  const server = stringValue(meta.connector_name)
    || stringValue(meta.server_name)
    || stringValue(meta.server)
    || stringValue(params.server_name)
    || stringValue(params.server);
  const toolTitle = stringValue(meta.tool_title) || stringValue(meta.title);
  const name = [server, toolTitle || tool].filter(Boolean).join(':') || 'MCP tool';
  const prompt = protocolNoticeFromParams(params);
  const toolUseId = stringValue(meta.codex_mcp_tool_call_id)
    || stringValue(meta.codex_call_id)
    || stringValue(meta.call_id)
    || stringValue(params.itemId)
    || stringValue(params.item_id)
    || stringValue(params.toolUseId)
    || stringValue(params.tool_use_id);
  const args = objectValue(meta.tool_params);

  return {
    toolUseId,
    name,
    title: prompt || `Allow Codex to use ${name}?`,
    input: {
      server,
      tool,
      arguments: args,
      prompt,
      requestedSchema: params.requestedSchema ?? params.requested_schema ?? null,
    },
  };
}

function requestedPermissions(params: JsonObject | undefined): JsonObject {
  const permissions = objectValue(params?.permissions);
  const granted: JsonObject = {};
  if (permissions.network) granted.network = permissions.network;
  if (permissions.fileSystem) granted.fileSystem = permissions.fileSystem;
  return granted;
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

export function codexAccessOptions(mode: string | undefined): {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
} {
  switch (mode) {
    case 'acceptEdits':
      // File-change approvals are selectively accepted above when their
      // requested root is inside the open folder. Do not use `never` here:
      // it would also bypass sensitive approvals the shared contract keeps.
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' };
    case 'auto':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'auto', sandbox: 'workspace-write' };
    case 'default':
    default:
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
  }
}

/** Whether an app-server file-change request stays entirely within the
 * folder the panel opened. Missing or malformed roots are never auto-allowed.
 */
export function isWorkspaceFileChange(params: JsonObject | undefined, cwd: string | null): boolean {
  const grantRoot = stringValue(params?.grantRoot);
  return isPathWithinWorkspace(grantRoot, cwd);
}

/** StashBase MCP writes use absolute file paths. Edit mode may accept only
 * its ordinary write/edit operations inside the opened folder; rename and
 * deletion stay visible because they can have broader consequences. */
export function isStashbaseWorkspaceEdit(approval: { input: JsonObject }, cwd: string | null): boolean {
  const tool = stringValue(approval.input.tool);
  const args = objectValue(approval.input.arguments);
  return stringValue(approval.input.server).toLowerCase() === 'stashbase'
    && (tool === 'write_file' || tool === 'edit_file')
    && isPathWithinWorkspace(stringValue(args.path), cwd);
}

function isPathWithinWorkspace(candidate: string, cwd: string | null): boolean {
  if (!cwd || !candidate) return false;
  const workspace = resolvedExistingPath(cwd);
  const target = resolvedExistingPath(candidate);
  if (!workspace || !target) return false;
  const relative = path.relative(workspace, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve a candidate through all existing path components. This handles a
 * new file beneath an existing directory while failing closed if its root or
 * an existing parent cannot be resolved. */
function resolvedExistingPath(candidate: string): string | null {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    return path.resolve(fs.realpathSync.native(existing), path.relative(existing, absolute));
  } catch {
    return null;
  }
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

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function exitSummary(value: unknown): string {
  return typeof value === 'number' ? `Command exited with code ${value}.` : '';
}

function rpcError(value: unknown): Error {
  if (value && typeof value === 'object') {
    const obj = value as JsonObject;
    const message = stringValue(obj.message);
    if (message) return new Error(message);
  }
  return new Error('Codex app-server request failed.');
}

function errorFromUnknown(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function stringifyCodexValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface CodexSessionRow {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
}

export type CodexSessionBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

export async function listCodexSessions(folder: string | null): Promise<CodexSessionRow[]> {
  const cwd = folder ?? process.cwd();
  const result = await withTemporaryCodexAppServer(cwd, (request) => request('thread/list', {
    limit: 100,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    cwd: folder ?? null,
  })) as JsonObject;
  const data = Array.isArray(result.data) ? result.data : [];
  return data.map(codexThreadToRow).filter((row): row is CodexSessionRow => !!row);
}

export async function getCodexSessionMessages(threadId: string, folder: string | null): Promise<CodexSessionBlock[]> {
  const cwd = folder ?? process.cwd();
  const result = await withTemporaryCodexAppServer(cwd, (request) => request('thread/read', {
    threadId,
    includeTurns: true,
  })) as JsonObject;
  const thread = objectValue(result.thread);
  const threadCwd = stringValue(thread.cwd);
  if (folder && (!threadCwd.trim() || !filesystemPath.equal(threadCwd, folder))) {
    throw httpError(404, 'session not found for current folder');
  }
  return codexThreadToBlocks(thread, codexRolloutToolsByTurn(stringValue(thread.path)));
}

export async function renameCodexSession(threadId: string, title: string, folder: string | null): Promise<CodexSessionRow> {
  const cwd = folder ?? process.cwd();
  await withTemporaryCodexAppServer(cwd, (request) => request('thread/name/set', { threadId, name: title }));
  const rows = await listCodexSessions(folder);
  return rows.find((row) => row.id === threadId) ?? { id: threadId, title, lastModified: Date.now() };
}

export async function deleteCodexSession(threadId: string, folder: string | null): Promise<void> {
  const cwd = folder ?? process.cwd();
  if (folder) {
    await getCodexSessionMessages(threadId, folder);
  }
  await withTemporaryCodexAppServer(cwd, (request) => permanentlyDeleteCodexThread(request, threadId));
}

/** Delete is irreversible in the shared panel, so use Codex's native
 * thread/delete operation rather than merely removing it from history. */
export async function permanentlyDeleteCodexThread(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
): Promise<void> {
  await request('thread/delete', { threadId });
}

async function withTemporaryCodexAppServer<T>(
  cwd: string,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return withSharedCodexHistoryAppServer(cwd, fn);
}

class CodexHistoryAppServer {
  readonly ready: Promise<void>;
  private proc: ChildProcessWithoutNullStreams;
  private stdout: readline.Interface;
  private stderr: readline.Interface;
  private pending = new Map<JsonRpcId, PendingRpc & { timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;
  private cleaned = false;

  constructor(readonly cwd: string, private onClose: () => void) {
    this.proc = spawnCodexAppServerProcess(cwd);
    this.stdout = readline.createInterface({ input: this.proc.stdout });
    this.stderr = readline.createInterface({ input: this.proc.stderr });

    this.stdout.on('line', (line) => this.onLine(line));
    this.stderr.on('line', (line) => {
      const clean = line.trim();
      if (clean) log.debug(clean);
    });
    this.proc.once('close', (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
      this.cleanup();
      this.onClose();
    });
    this.proc.once('error', (err) => {
      this.closed = true;
      this.rejectAll(errorFromUnknown(err));
      this.cleanup();
      this.onClose();
    });

    this.ready = this.request('initialize', {
      clientInfo: { name: 'StashBase', title: null, version: appVersion() },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
    }).then(() => undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.proc.stdin.writable) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 30000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err: unknown) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(errorFromUnknown(err));
      }
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('Codex app-server history client closed.'));
    this.cleanup();
    try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private onLine(line: string): void {
    let msg: JsonObject;
    try { msg = JSON.parse(line) as JsonObject; } catch { return; }
    if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      const id = msg.id as JsonRpcId;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(rpcError(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if ('id' in msg && typeof msg.method === 'string') {
      try {
        this.proc.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unsupported in history request' } })}\n`);
      } catch { /* process is closing */ }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.stdout.close();
    this.stderr.close();
  }
}

interface CodexHistoryEntry {
  client: CodexHistoryAppServer;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

const HISTORY_APP_SERVER_IDLE_MS = 15000;
const codexHistoryClients = new Map<string, CodexHistoryEntry>();

async function withSharedCodexHistoryAppServer<T>(
  cwd: string,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const key = filesystemPath.identity(cwd);
  let entry = codexHistoryClients.get(key);
  if (!entry || entry.client.isClosed()) {
    const client = new CodexHistoryAppServer(cwd, () => {
      const cur = codexHistoryClients.get(key);
      if (cur?.client === client) codexHistoryClients.delete(key);
    });
    entry = { client, refs: 0, idleTimer: null };
    codexHistoryClients.set(key, entry);
  }

  entry.refs += 1;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  try {
    await entry.client.ready;
    return await fn((method, params) => entry!.client.request(method, params));
  } catch (err) {
    if (entry.client.isClosed() || isCodexHistoryTransportError(err)) {
      entry.client.dispose();
      if (codexHistoryClients.get(key) === entry) codexHistoryClients.delete(key);
    }
    throw err;
  } finally {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.client.isClosed() && codexHistoryClients.get(key) === entry) {
      entry.idleTimer = setTimeout(() => {
        const cur = codexHistoryClients.get(key);
        if (cur === entry && cur.refs === 0) {
          cur.client.dispose();
          codexHistoryClients.delete(key);
        }
      }, HISTORY_APP_SERVER_IDLE_MS);
      entry.idleTimer.unref?.();
    }
  }
}

function isCodexHistoryTransportError(err: unknown): boolean {
  return /Codex app-server|not running|timed out|history client closed/i.test(errorMessage(err));
}

function codexThreadToRow(thread: unknown): CodexSessionRow | null {
  const obj = objectValue(thread);
  const id = stringValue(obj.id);
  if (!id) return null;
  const cwd = stringValue(obj.cwd);
  const git = objectValue(obj.gitInfo);
  return {
    id,
    title: stringValue(obj.name) || stringValue(obj.preview) || id,
    lastModified: secondsToMillis(obj.updatedAt),
    ...(cwd ? { cwd } : {}),
    ...(stringValue(git.branch) ? { gitBranch: stringValue(git.branch) } : {}),
  };
}

type RolloutTool = Extract<CodexSessionBlock, { kind: 'tool' }> & { afterAssistantMessages: number };
type RolloutToolsByTurn = Map<string, RolloutTool[]>;

/**
 * `thread/read` is authoritative for normal app-server sessions, but Codex
 * currently omits desktop-hosted tool calls from that response. Those calls
 * remain in Codex's local rollout file, which the thread metadata points to.
 * Read only that known local session directory and add the missing calls back
 * to their original turn.
 */
function codexRolloutToolsByTurn(threadPath: string): RolloutToolsByTurn {
  const byTurn: RolloutToolsByTurn = new Map();
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!threadPath || !isPathInside(threadPath, sessionsDir)) return byTurn;

  let lines: string[];
  try {
    lines = fs.readFileSync(threadPath, 'utf8').split(/\r?\n/);
  } catch {
    return byTurn;
  }

  const calls = new Map<string, RolloutTool>();
  const assistantMessagesByTurn = new Map<string, number>();
  for (const line of lines) {
    if (!line) continue;
    let entry: JsonObject;
    try { entry = JSON.parse(line) as JsonObject; } catch { continue; }
    if (stringValue(entry.type) !== 'response_item') continue;
    const payload = objectValue(entry.payload);
    const payloadType = stringValue(payload.type);
    const turnId = stringValue(objectValue(payload.internal_chat_message_metadata_passthrough).turn_id);
    const callId = stringValue(payload.call_id);
    if (payloadType === 'message' && stringValue(payload.role) === 'assistant' && turnId) {
      assistantMessagesByTurn.set(turnId, (assistantMessagesByTurn.get(turnId) ?? 0) + 1);
      continue;
    }
    if ((payloadType === 'function_call' || payloadType === 'custom_tool_call') && callId && turnId) {
      const tool: RolloutTool = {
        kind: 'tool',
        id: `rollout-${stringValue(payload.id) || callId}`,
        name: rolloutToolName(stringValue(payload.name)),
        input: rolloutToolInput(payloadType === 'function_call' ? payload.arguments : payload.input),
        status: stringValue(payload.status) === 'failed' ? 'error' : 'done',
        afterAssistantMessages: assistantMessagesByTurn.get(turnId) ?? 0,
      };
      calls.set(callId, tool);
      const tools = byTurn.get(turnId) ?? [];
      tools.push(tool);
      byTurn.set(turnId, tools);
      continue;
    }
    if ((payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') && callId) {
      const tool = calls.get(callId);
      if (tool) tool.result = stringifyCodexValue(payload.output);
    }
  }
  return byTurn;
}

function rolloutToolInput(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch {
      // Some custom tools use plain-text input rather than JSON.
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : { input: stringifyCodexValue(value) };
}

function isPathInside(candidate: string, parent: string): boolean {
  return !filesystemPath.equal(parent, candidate) && filesystemPath.contains(parent, candidate);
}

function rolloutToolName(name: string): string {
  if (name === 'exec' || name === 'exec_command') return 'Ran command';
  if (name === 'apply_patch') return 'Changed files';
  return name || 'Tool call';
}

function codexThreadToBlocks(thread: JsonObject, rolloutTools: RolloutToolsByTurn = new Map()): CodexSessionBlock[] {
  const blocks: CodexSessionBlock[] = [];
  let seq = 0;
  const id = () => `c${seq++}`;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    const turnObject = objectValue(turn);
    const items = turnObject.items;
    if (!Array.isArray(items)) continue;
    // Desktop-hosted threads omit tool calls altogether; normal app-server
    // threads already contain them. Do not add the rollout copies when the
    // authoritative response has tool items for this turn.
    const hasThreadTools = items.some((raw) => !!toolStartFromItem(objectValue(raw)));
    const tools = hasThreadTools ? [] : rolloutTools.get(stringValue(turnObject.id)) ?? [];
    let assistantMessages = 0;
    const appendToolsAfter = (count: number) => {
      for (const tool of tools) {
        if (tool.afterAssistantMessages === count) {
          const { afterAssistantMessages: _position, ...block } = tool;
          blocks.push(block);
        }
      }
    };
    appendToolsAfter(0);
    for (const raw of items) {
      const item = objectValue(raw);
      const type = stringValue(item.type);
      if (type === 'userMessage') {
        const text = userInputText(item.content);
        if (text.trim()) blocks.push({ kind: 'user', id: id(), text });
        continue;
      }
      if (type === 'agentMessage') {
        const text = stringValue(item.text);
        if (text.trim()) {
          blocks.push({ kind: 'assistant', id: id(), text });
          assistantMessages++;
          appendToolsAfter(assistantMessages);
        }
        continue;
      }
      if (type === 'reasoning' || type === 'plan') {
        const text = type === 'plan'
          ? stringValue(item.text)
          : [...stringArray(item.summary), ...stringArray(item.content)].join('\n');
        if (text.trim()) blocks.push({ kind: 'thinking', id: id(), text });
        continue;
      }
      const tool = toolStartFromItem(item);
      const result = toolResultFromItem(item);
      if (tool) {
        blocks.push({
          kind: 'tool',
          id: id(),
          name: tool.name,
          input: tool.input,
          status: result?.isError ? 'error' : 'done',
          ...(result?.content ? { result: result.content } : {}),
        });
      }
    }
    // A rollout can contain a final tool after the final assistant update.
    // Keep it in this turn rather than moving it to the end of the thread.
    for (const tool of tools) {
      if (tool.afterAssistantMessages > assistantMessages) {
        const { afterAssistantMessages: _position, ...block } = tool;
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((input) => {
      const obj = objectValue(input);
      if (stringValue(obj.type) === 'text') return stringValue(obj.text);
      if (stringValue(obj.type) === 'image') return stringValue(obj.url);
      if (stringValue(obj.type) === 'localImage') return stringValue(obj.path);
      return stringValue(obj.name) || stringValue(obj.path);
    })
    .filter(Boolean)
    .join('\n');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function secondsToMillis(value: unknown): number {
  return typeof value === 'number' ? Math.round(value * 1000) : Date.now();
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
