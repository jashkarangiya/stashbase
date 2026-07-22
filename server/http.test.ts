import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithWindowId } from './folder.ts';
import { requireFolder, validateEmbedderKey } from './http.ts';

test('folder-explicit preparation routes work without an open window folder', async () => {
  for (const path of ['/prepare', '/reprocess', '/cancel-preparation']) {
    let nextCalled = false;
    let responseStatus = 0;
    await runWithWindowId(`folder-explicit-gate-${path}`, () => {
      requireFolder({
        method: 'POST',
        baseUrl: '/api/files',
        path,
        body: { folder: '/tmp/member-folder' },
      } as any, {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json() { return this; },
      } as any, () => { nextCalled = true; });
    });
    assert.equal(responseStatus, 0, path);
    assert.equal(nextCalled, true, path);
  }
});

test('embedder key validation uses the provider models endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization') });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await validateEmbedderKey('openrouter', 'sk-or-v1-test', { timeoutMs: 1000 }), { ok: true });
    assert.deepEqual(calls, [{
      url: 'https://openrouter.ai/api/v1/models',
      authorization: 'Bearer sk-or-v1-test',
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedder key validation rejects definite provider auth failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
  try {
    assert.deepEqual(
      await validateEmbedderKey('openrouter', 'bad', { timeoutMs: 1000 }),
      { ok: false, status: 400, error: 'OpenRouter rejected the key (HTTP 401): bad key' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
