import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import { codexAccessOptions, isStashbaseWorkspaceEdit, isWorkspaceFileChange, permanentlyDeleteCodexThread } from '../codex-agent.ts';
import { CodexRpcPeer } from '../codex-rpc-transport.ts';
import { CodexSession } from '../codex-session-runtime.ts';

class FakeCodexProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

test('Codex RPC peer correlates responses and dispatches inbound messages', async () => {
  const writes: string[] = [];
  const requests: string[] = [];
  const notifications: string[] = [];
  const peer = new CodexRpcPeer((line) => writes.push(line), {
    onRequest: ({ method }) => requests.push(method),
    onNotification: (method) => notifications.push(method),
  });

  const pending = peer.request('thread/read', { threadId: 'thread-123' });
  const request = JSON.parse(writes[0]!) as { id: number };
  peer.receiveLine(JSON.stringify({ id: request.id, result: { ok: true } }));
  peer.receiveLine(JSON.stringify({ id: 99, method: 'approval/request', params: {} }));
  peer.receiveLine(JSON.stringify({ method: 'turn/started', params: {} }));

  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(requests, ['approval/request']);
  assert.deepEqual(notifications, ['turn/started']);
});

test('Codex RPC peer rejects pending work when its owner closes', async () => {
  const peer = new CodexRpcPeer(() => {});
  const pending = peer.request('turn/start', {});
  peer.close(new Error('session closed'));
  await assert.rejects(pending, /session closed/);
});

test('stale Codex process events cannot release a replacement process generation', () => {
  const first = new FakeCodexProcess();
  const second = new FakeCodexProcess();
  const processes = [first, second];
  const session = new CodexSession(
    new FakeWebSocket() as unknown as WebSocket,
    'test-window',
    undefined,
    undefined,
    undefined,
    undefined,
    () => processes.shift() as unknown as ChildProcessWithoutNullStreams,
  );
  const runtime = session as unknown as {
    spawnAppServer(cwd: string): void;
    proc: ChildProcessWithoutNullStreams | null;
    rpc: CodexRpcPeer | null;
  };

  runtime.spawnAppServer('/tmp');
  first.emit('error', new Error('first process failed'));
  runtime.spawnAppServer('/tmp');
  const replacementRpc = runtime.rpc;

  first.emit('close', 1, null);

  assert.equal(runtime.proc, second as unknown as ChildProcessWithoutNullStreams);
  assert.equal(runtime.rpc, replacementRpc);
  session.dispose();
  assert.equal(second.killed, true);
});

test('Codex Delete Chat uses the native irreversible thread/delete operation', async () => {
  const requests: Array<{ method: string; params: unknown }> = [];

  await permanentlyDeleteCodexThread(async (method, params) => {
    requests.push({ method, params });
  }, 'thread-123');

  assert.deepEqual(requests, [{ method: 'thread/delete', params: { threadId: 'thread-123' } }]);
});

test('Codex Edit keeps native approval requests enabled for sensitive actions', () => {
  assert.deepEqual(codexAccessOptions('acceptEdits'), {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
  });
});

test('Codex Edit auto-accepts only physical file-change grants inside the open folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-codex-'));
  const folder = path.join(root, 'project');
  const outside = path.join(root, 'other');
  fs.mkdirSync(folder);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(folder, 'linked-outside'));
  try {
    assert.equal(isWorkspaceFileChange({ grantRoot: path.join(folder, 'src') }, folder), true);
    assert.equal(isWorkspaceFileChange({ grantRoot: folder }, folder), true);
    assert.equal(isWorkspaceFileChange({ grantRoot: outside }, folder), false);
    assert.equal(isWorkspaceFileChange({ grantRoot: root }, folder), false);
    assert.equal(isWorkspaceFileChange({ grantRoot: path.join(folder, 'linked-outside') }, folder), false);
    assert.equal(isWorkspaceFileChange({}, folder), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Edit auto-accepts only ordinary StashBase MCP writes inside the open folder', () => {
  const folder = '/workspace/project';
  const approval = (tool: string, target: string, server = 'stashbase') => ({
    input: { server, tool, arguments: { path: target } },
  });

  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/project/note.md'), folder), true);
  assert.equal(isStashbaseWorkspaceEdit(approval('write_file', '/workspace/project/new.md'), folder), true);
  assert.equal(isStashbaseWorkspaceEdit(approval('delete_file', '/workspace/project/note.md'), folder), false);
  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/other/note.md'), folder), false);
  assert.equal(isStashbaseWorkspaceEdit(approval('edit_file', '/workspace/project/note.md', 'other'), folder), false);
});
