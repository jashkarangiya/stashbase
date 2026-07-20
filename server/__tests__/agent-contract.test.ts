import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_AGENT_ADAPTERS } from '../agent-adapters.ts';
import {
  attachAgentRuntime,
  clearAgentRuntimeFailure,
  discoverAgentRuntimes,
  registerAgentAdapter,
  reportAgentRuntimeFailure,
  runtimeDescriptorFor,
  type AgentClientEvent,
  type AgentServerEvent,
} from '../agent-contract.ts';
import { smokeNativeAgentCli } from '../agent-native-smoke.ts';

const REQUIRED_SHARED_CAPABILITIES = [
  'connection', 'prompts', 'interrupt', 'transcript', 'approvals', 'history', 'modes', 'effort',
] as const;

test('Claude and Codex declare every Shared Agent Contract panel behavior', () => {
  assert.deepEqual(BUILT_IN_AGENT_ADAPTERS.map((adapter) => adapter.id), ['claude', 'codex']);
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) {
    for (const capability of REQUIRED_SHARED_CAPABILITIES) {
      assert.equal(adapter.capabilities[capability], true, `${adapter.id} must support ${capability}`);
    }
    assert.equal(typeof adapter.attach, 'function');
    assert.equal(typeof adapter.stop, 'function');
    assert.equal(typeof adapter.history.list, 'function');
    assert.equal(typeof adapter.history.messages, 'function');
    assert.equal(typeof adapter.history.rename, 'function');
    assert.equal(typeof adapter.history.remove, 'function');
  }
});

test('runtime-only capabilities stay adapter-specific', () => {
  const capabilities = Object.fromEntries(BUILT_IN_AGENT_ADAPTERS.map((adapter) => [adapter.id, adapter.capabilities]));
  assert.equal(capabilities.claude!.steering, false);
  assert.equal(capabilities.claude!.titleHint, false);
  assert.equal(capabilities.codex!.steering, true);
  assert.equal(capabilities.codex!.titleHint, true);
});

test('Shared Agent Contract retains lifecycle, streaming, approval, session, and queue event vocabulary', () => {
  const clientEvents: AgentClientEvent[] = [
    { t: 'prompt', text: 'first', titleHint: 'Title' }, { t: 'steer', id: 'queued', text: 'follow-up' },
    { t: 'permission-reply', id: 'approval', allow: true, always: true }, { t: 'interrupt' },
    { t: 'set-mode', mode: 'plan' }, { t: 'close' },
  ];
  const events: AgentServerEvent[] = [
    { t: 'ready' }, { t: 'session-id', id: 'session' }, { t: 'session-title', title: 'Title' },
    { t: 'turn-start' }, { t: 'text', delta: 'text' }, { t: 'thinking', delta: 'thinking' },
    { t: 'tool', id: 'tool', name: 'Read', input: {} }, { t: 'tool-delta', id: 'tool', delta: 'input' },
    { t: 'tool-result', id: 'tool', content: 'done', isError: false },
    { t: 'permission', id: 'approval', toolUseId: 'tool', name: 'Write', title: null, input: {} },
    { t: 'steer-result', id: 'queued', ok: true }, { t: 'turn-end', isError: false },
    { t: 'error', message: 'runtime unavailable' }, { t: 'exit' },
  ];
  assert.equal(clientEvents.length, 6);
  assert.equal(events.length, 14);
});

test('capability discovery reports supported, unavailable, and failed runtimes without changing adapter metadata', () => {
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) {
    assert.equal(runtimeDescriptorFor(adapter, `/native/${adapter.id}`).state, 'available');
    assert.equal(runtimeDescriptorFor(adapter, null).state, 'unavailable');
  }
  const adapter = BUILT_IN_AGENT_ADAPTERS[0]!;

  reportAgentRuntimeFailure(adapter.id, new Error('native protocol changed'));
  const failed = runtimeDescriptorFor(adapter, '/native/claude');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'native protocol changed');
  assert.deepEqual(failed.capabilities, adapter.capabilities);
  clearAgentRuntimeFailure(adapter.id);
});

test('capability discovery publishes the registered adapter catalog', () => {
  for (const adapter of BUILT_IN_AGENT_ADAPTERS) registerAgentAdapter(adapter);
  const discovered = discoverAgentRuntimes();
  assert.deepEqual(discovered.map((runtime) => runtime.id), ['claude', 'codex']);
  for (const runtime of discovered) {
    const adapter = BUILT_IN_AGENT_ADAPTERS.find((candidate) => candidate.id === runtime.id)!;
    assert.equal(runtime.endpoint, '/ws/agent');
    assert.deepEqual(runtime.capabilities, adapter.capabilities);
  }
});

test('unsupported runtime connections return a contract error and close cleanly', () => {
  const sent: string[] = [];
  let closed = false;
  const ws = { send: (message: string) => sent.push(message), close: () => { closed = true; } };
  attachAgentRuntime('unsupported', ws as never, { windowId: 'test-window' });
  assert.deepEqual(sent, [JSON.stringify({ t: 'error', message: 'Unsupported agent runtime.' })]);
  assert.equal(closed, true);
});

test('native CLI smoke checks report protocol incompatibility with an actionable error', () => {
  const codex = smokeNativeAgentCli('codex', '/native/codex', () => ({ status: 0, stdout: 'usage: codex', stderr: '' }));
  assert.equal(codex.ok, false);
  assert.match(codex.message, /app-server/);

  const claude = smokeNativeAgentCli('claude', '/native/claude', () => ({ status: 1, stdout: '', stderr: 'bad flag' }));
  assert.equal(claude.ok, false);
  assert.match(claude.message, /exit code 1/);
});
