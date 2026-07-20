import {
  errorFromUnknown,
  rpcError,
  type JsonObject,
  type JsonRpcId,
} from './codex-protocol.ts';

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
export interface CodexRpcPeerOptions {
  requestTimeoutMs?: number;
  onRequest?: (message: { id: JsonRpcId; method: string; params: JsonObject }) => void;
  onNotification?: (method: string, params: JsonObject) => void;
}

/** JSON-RPC correlation and dispatch over an injected line writer. */
export class CodexRpcPeer {
  private nextRequestId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private closed = false;

  constructor(
    private writeLine: (line: string) => void,
    private options: CodexRpcPeerOptions = {},
  ) {}

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = { resolve, reject };
      const timeoutMs = this.options.requestTimeoutMs ?? 0;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.writeLine(JSON.stringify({ id, method, params }));
      } catch (err: unknown) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(errorFromUnknown(err));
      }
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    this.writeLine(JSON.stringify({ id, result }));
  }

  reject(id: JsonRpcId, message: string, code = -32603): void {
    if (this.closed) return;
    this.writeLine(JSON.stringify({ id, error: { code, message } }));
  }

  receiveLine(line: string): void {
    if (this.closed) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }

    if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
      this.receiveResponse(message);
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object'
      ? message.params as JsonObject
      : {};
    if ('id' in message) {
      this.options.onRequest?.({
        id: message.id as JsonRpcId,
        method: message.method,
        params,
      });
    } else {
      this.options.onNotification?.(message.method, params);
    }
  }

  close(error = new Error('Codex app-server connection closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private receiveResponse(message: JsonObject): void {
    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if ('error' in message) pending.reject(rpcError(message.error));
    else pending.resolve(message.result);
  }
}
