import test from 'node:test';
import assert from 'node:assert/strict';
import { api, assetBaseUrl, assetUrl, versionedAssetUrl } from './api';

test('assetUrl carries the window id in the path so relative assets inherit it', () => {
  assert.equal(assetUrl('notes/report.html'), '/asset/__window/web/notes/report.html');
  assert.equal(assetBaseUrl('notes/report.html'), '/asset/__window/web/notes/');
});

test('versionedAssetUrl appends cache busting as a query, not part of the file path', () => {
  assert.equal(
    versionedAssetUrl('notes/report.html', 'abc&123'),
    '/asset/__window/web/notes/report.html?v=abc%26123',
  );
});

test('statFile sends a HEAD request for encoded viewer paths', async () => {
  const prevFetch = globalThis.fetch;
  let url = '';
  let method = '';
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    method = init?.method ?? '';
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await api.statFile('docs/My Paper.pdf');
    assert.equal(url, '/api/files/docs/My%20Paper.pdf');
    assert.equal(method, 'HEAD');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('semantic search sends the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ hits: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.search('alpha', 12, { space: 'Space A' });
    assert.deepEqual(body, { query: 'alpha', top_k: 12, space: 'Space A' });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('keyword search sends the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ files: [], totalMatches: 0, truncated: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.keywordSearch('alpha beta', { space: 'Space A', caseStrict: true, wholeWord: true });
    assert.equal(url, '/api/keyword-search?q=alpha+beta&case_strict=1&whole_word=1&space=Space+A');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('recording upload sends the capture-time space and folder', async () => {
  const prevFetch = globalThis.fetch;
  let body: FormData | undefined;
  globalThis.fetch = (async (_url, init) => {
    body = init?.body instanceof FormData ? init.body : undefined;
    return new Response(JSON.stringify({ ok: true, file: 'Calls/recording.md' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.recordVideo(new File(['webm'], 'clip.webm', { type: 'video/webm' }), 'Calls', 'Space A');
    const form = body;
    assert.ok(form);
    assert.equal(form.get('dir'), 'Calls');
    assert.equal(form.get('space'), 'Space A');
    assert.equal((form.get('file') as File | null)?.name, 'clip.webm');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('file upload sends the import-time space and folder', async () => {
  const prevFetch = globalThis.fetch;
  let body: FormData | undefined;
  globalThis.fetch = (async (_url, init) => {
    body = init?.body instanceof FormData ? init.body : undefined;
    return new Response(JSON.stringify({ files: [{ file: 'Inbox/a.md' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.upload(
      [{ file: new File(['hello'], 'a.md', { type: 'text/markdown' }), relPath: 'a.md' }],
      'Inbox',
      'Space A',
    );
    const form = body;
    assert.ok(form);
    assert.equal(form.get('dir'), 'Inbox');
    assert.equal(form.get('space'), 'Space A');
    assert.equal(form.get('paths'), 'a.md');
    assert.equal((form.get('files') as File | null)?.name, 'a.md');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('sync can target an explicit space', async () => {
  const prevFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (input) => {
    url = String(input);
    return new Response(JSON.stringify({
      added: 0,
      modified: 0,
      removed: 0,
      failed: [],
      cancelled: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.sync('Space A');
    assert.equal(url, '/api/sync?space=Space%20A');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('index status sends the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (input) => {
    url = String(input);
    return new Response(JSON.stringify({
      total: 0,
      indexed: 0,
      pendingCount: 0,
      pending: [],
      orphanedCount: 0,
      orphaned: [],
      upToDate: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.indexStatus('Space A');
    assert.equal(url, '/api/index-status?space=Space%20A');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('snapshot export sends the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      vectors: 0,
      chunks: 0,
      embedder: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.exportSnapshot('Space A');
    assert.deepEqual(body, { space: 'Space A' });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('conversion retry sends the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.retryConversion('nested/paper.pdf', { space: 'Space A' });
    assert.deepEqual(body, { path: 'nested/paper.pdf', space: 'Space A' });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('warning dismiss calls send the active window space explicitly', async () => {
  const prevFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.dismissSnapshotWarning('Space A');
    await api.dismissIndexWarning('Space A');
    assert.deepEqual(bodies, [{ space: 'Space A' }, { space: 'Space A' }]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('closeSpace closes only the current window binding', async () => {
  const prevFetch = globalThis.fetch;
  let method = '';
  let url = '';
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    method = init?.method ?? 'GET';
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.closeSpace();
    assert.equal(url, '/api/space');
    assert.equal(method, 'DELETE');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('Gemini key settings use the expected API methods and payloads', async () => {
  const prevFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ hasKey: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.getGeminiKey();
    await api.setGeminiKey('gemini-test');
    await api.removeGeminiKey();
    assert.deepEqual(calls, [
      { url: '/api/gemini/key', method: 'GET', body: undefined },
      { url: '/api/gemini/key', method: 'PUT', body: { geminiKey: 'gemini-test' } },
      { url: '/api/gemini/key', method: 'DELETE', body: undefined },
    ]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('OpenAI embedder key settings use the saving endpoint only', async () => {
  const prevFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ hasKey: true, provider: 'openai' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await api.getEmbedder();
    await api.changeApiKey('openai-test');
    await api.removeApiKey();
    assert.deepEqual(calls, [
      { url: '/api/embedder', method: 'GET', body: undefined },
      { url: '/api/embedder/key', method: 'PUT', body: { openaiKey: 'openai-test' } },
      { url: '/api/embedder/key', method: 'DELETE', body: undefined },
    ]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
