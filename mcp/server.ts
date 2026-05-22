#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local KB to Claude Desktop / Claude Code.
 *
 * Four tools: `search_kb` / `list_files` / `get_file` / `index_status`.
 *
 * All tools default to the **whole library** under
 * `~/Documents/StashBase/` and accept an optional `space` argument to
 * scope to one space (e.g. `space: "cs183b"`). Paths are kbRoot-relative
 * (`cs183b/lecture-01.md`).
 *
 * Two execution paths:
 *   1. If the StashBase desktop app is running and serving on :8090,
 *      **forward over HTTP** — its single Python sidecar holds the
 *      embedding models and Milvus file lock. We hit dedicated
 *      `/api/library/*` endpoints that operate on kbRoot-relative paths.
 *   2. If :8090 isn't answering, fall back to an **embedded MfsIndexer**
 *      that spawns its own daemon, configured with kbRoot from
 *      `~/.stashbase/config.json` and pre-binding every space under it
 *      so cross-library search works without the app open.
 *
 * Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
 *   {
 *     "mcpServers": {
 *       "stashbase": {
 *         "command": "npx",
 *         "args": ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
 *       }
 *     }
 *   }
 */
// Must come FIRST — silences console.log/info/warn/debug to stderr so
// no later import can corrupt the stdio JSON-RPC stream. See module.
import './stdio-guard.ts';

import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MfsIndexer } from '../server/indexer.mfs.ts';
import {
  ensureKbRoot,
  getApiKey,
  getEmbedderProvider,
  getKbRoot,
  isUnderRoot,
  listKnownSpaces,
  migrateLegacyEmbedderConfig,
} from '../server/space.ts';
import { getDaemon } from '../server/mfs-daemon.ts';
import {
  ensureLibraryOverview,
  getLibraryInfo,
  setLibraryOverview,
  type LibraryInfo,
} from '../server/library.ts';

// Idempotent migrations. Safe to run from both the web server and MCP —
// second call no-ops.
migrateLegacyEmbedderConfig();
ensureKbRoot();
ensureLibraryOverview();

function parsePortArg(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
// Use 127.0.0.1 explicitly — the server binds to the IPv4 loopback and
// `localhost` resolves to ::1 first on dual-stack hosts, which would
// make every web call fail with ECONNREFUSED and force the slow
// embedded-daemon fallback on every tool call.
const WEB_BASE = `http://127.0.0.1:${parsePortArg(process.argv.slice(2), 8090)}`;

// Lazily constructed embedded indexer. Spawned only when the web server
// isn't reachable AND a tool actually fires.
let embedded: MfsIndexer | null = null;
let embeddedReady: Promise<void> | null = null;

function getEmbedded(): { indexer: MfsIndexer; ready: Promise<void> } {
  if (embedded && embeddedReady) return { indexer: embedded, ready: embeddedReady };
  const inst = new MfsIndexer();
  embedded = inst;
  embeddedReady = (async () => {
    // Configure the daemon with kbRoot, then bind every known space so
    // cross-library search works without the user having to "open" each
    // one in some session that doesn't exist (MCP runs headless).
    const daemon = getDaemon();
    daemon.configure({ kbRoot: getKbRoot() });
    const known = listKnownSpaces();
    const provider = getEmbedderProvider();
    const apiKey = getApiKey();
    const cfg = provider === 'openai' && apiKey
      ? ({ provider: 'openai' as const, apiKey })
      : ({ provider: 'onnx' as const });
    if (provider === 'openai' && !apiKey) {
      process.stderr.write(
        '[StashBase] embedder is openai but no key in ~/.stashbase/config.json; ' +
          'falling back to local ONNX\n',
      );
    }
    for (const space of known) {
      try {
        await inst.bindSpace(space, cfg);
      } catch (err: unknown) {
        process.stderr.write(`[StashBase] bind ${space} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  })();
  return { indexer: inst, ready: embeddedReady };
}

/** Cache the web-live answer for a few seconds so a single Claude
 *  conversation doesn't pay the 300 ms probe latency on every tool
 *  call. */
const WEB_LIVE_TTL_MS = 5000;
let webLiveCache: { value: boolean; expires: number } | null = null;

async function webIsLive(): Promise<boolean> {
  const now = Date.now();
  if (webLiveCache && webLiveCache.expires > now) return webLiveCache.value;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 300);
    const r = await fetch(`${WEB_BASE}/api/space`, { signal: ctrl.signal });
    clearTimeout(t);
    const live = r.ok;
    webLiveCache = { value: live, expires: now + WEB_LIVE_TTL_MS };
    return live;
  } catch {
    webLiveCache = { value: false, expires: now + WEB_LIVE_TTL_MS };
    return false;
  }
}

function invalidateWebLive(): void {
  webLiveCache = { value: false, expires: Date.now() + WEB_LIVE_TTL_MS };
}

async function tryWebElseEmbedded<T>(
  label: string,
  viaWeb: () => Promise<T>,
  viaEmbedded: () => Promise<T>,
): Promise<T> {
  if (await webIsLive()) {
    try {
      return await viaWeb();
    } catch (err: unknown) {
      invalidateWebLive();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[StashBase] web ${label} failed, falling back to embedded: ${msg}\n`);
    }
  }
  return viaEmbedded();
}

async function searchViaWeb(query: string, topK: number, space: string | undefined): Promise<unknown[]> {
  const body: Record<string, unknown> = { query, top_k: topK };
  if (space) body.space = space;
  const r = await fetch(`${WEB_BASE}/api/library/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`web /api/library/search failed: ${r.status}`);
  const j = await r.json() as { hits: unknown[] };
  return j.hits;
}

async function statusViaWeb(space: string | undefined): Promise<unknown> {
  const url = space ? `${WEB_BASE}/api/library/index-status?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/library/index-status`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`web /api/library/index-status failed: ${r.status}`);
  return r.json();
}

async function listFilesViaWeb(space: string | undefined): Promise<string[]> {
  const url = space ? `${WEB_BASE}/api/library/files?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/library/files`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`web /api/library/files failed: ${r.status}`);
  const j = await r.json() as { files: string[] };
  return j.files;
}

async function libraryInfoViaWeb(): Promise<LibraryInfo> {
  const r = await fetch(`${WEB_BASE}/api/library/info`);
  if (!r.ok) throw new Error(`web /api/library/info failed: ${r.status}`);
  return r.json() as Promise<LibraryInfo>;
}

async function updateLibraryOverviewViaWeb(content: string): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/library/overview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`web /api/library/overview failed: ${r.status}`);
}

async function getFileViaWeb(kbRel: string): Promise<string | null> {
  const r = await fetch(`${WEB_BASE}/api/library/file/${encodeKbPath(kbRel)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`web /api/library/file/${kbRel} failed: ${r.status}`);
  const j = await r.json() as { content: string };
  return j.content;
}

function encodeKbPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

const server = new Server(
  { name: 'stashbase', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_kb',
      description:
        'Hybrid (vector + full-text) search over the local Markdown / HTML knowledge base. ' +
        'Searches the **whole library** by default — every space under ~/Documents/StashBase/ ' +
        '— and scopes to one space when `space` is provided (e.g. "cs183b" or "work/research"). ' +
        'Each hit returns the kbRoot-relative file path (`<space>/<file>`), the chunk content, ' +
        'optional heading and source line range, and a fused relevance score. Use this when ' +
        'the user asks something the notes might answer; pull a full document with `get_file`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          space: {
            type: 'string',
            description:
              'Optional space name (kbRoot-relative path of a folder under ~/Documents/StashBase/, ' +
              'e.g. "cs183b"). Omit to search the whole library.',
          },
          top_k: {
            type: 'integer',
            description: `Number of chunks to return (1-${MAX_TOP_K}). Default ${DEFAULT_TOP_K}.`,
            minimum: 1,
            maximum: MAX_TOP_K,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_files',
      description:
        'List every indexed file in the knowledge base (paths only — for content, use ' +
        '`get_file`). Defaults to the whole library; pass `space` to scope. Returns ' +
        'kbRoot-relative POSIX paths sorted alphabetically.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Optional space name; omit to list across the whole library.',
          },
        },
      },
    },
    {
      name: 'get_file',
      description:
        'Fetch the full raw content of one file by its kbRoot-relative path (e.g. ' +
        '`cs183b/lecture-01.md`). Use after `search_kb` or `list_files` to pull the ' +
        'surrounding document. Returns original source as text — no preview rendering.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'kbRoot-relative file path (e.g. "cs183b/lecture-01.md"). The first ' +
              'segment is the space; the rest is the path within the space.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'library_info',
      description:
        'Get a one-shot map of the StashBase library: a free-form ' +
        '`overview` (the contents of `<kbRoot>/AGENT.md`, an ' +
        'agent-maintained markdown file that should describe what each ' +
        'space contains) plus structured facts per space (name, ' +
        'embedder provider, file count, a sample of file paths and ' +
        'headings). **Call this first** when starting a new conversation ' +
        'so you can decide which space(s) `search_kb` should target. If ' +
        '`overview` is empty or out of date relative to what you find ' +
        'during a session, update it via `update_library_overview`.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'update_library_overview',
      description:
        'Overwrite the entire `<kbRoot>/AGENT.md` library overview with ' +
        'new markdown content. Call this after you have learned ' +
        'something new about the library (a new space exists, a topic ' +
        'in a space turned out to be different from your prior ' +
        'understanding, etc.). Keep it concise — this file is read at ' +
        'the start of every conversation, not searched. Structure ' +
        'suggestion: a top-level heading + a `## Spaces` section with ' +
        'one subsection per space.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Full markdown content to write to AGENT.md.',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'index_status',
      description:
        'Check whether the index has caught up with the files on disk. Returns ' +
        '`{total, indexed, pending_count, pending, up_to_date}` for the **whole library** ' +
        'by default, or for one `space` when scoped. `pending` is the full list of ' +
        'kbRoot-relative paths still waiting to be indexed. Call this when `search_kb` ' +
        'returns fewer or less relevant results than expected — especially right after ' +
        'an import.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Optional space name; omit to check the whole library.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const space = typeof args.space === 'string' && args.space.trim() ? args.space.trim() : undefined;

  if (req.params.name === 'search_kb') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('`query` is required');
    const k = Math.max(
      1,
      Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
    );
    const hits = await tryWebElseEmbedded(
      'search',
      () => searchViaWeb(query, k, space),
      async () => {
        const { indexer, ready } = getEmbedded();
        await ready;
        return indexer.search(query, k, space);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ query, space: space ?? null, top_k: k, hits }, null, 2) }],
    };
  }

  if (req.params.name === 'list_files') {
    const files = await tryWebElseEmbedded(
      'list_files',
      () => listFilesViaWeb(space),
      async () => {
        const { ready } = getEmbedded();
        await ready;
        const r = await getDaemon().call<{ files: Record<string, string> }>(
          'list', space ? { space } : {},
        );
        return Object.keys(r.files).sort();
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ space: space ?? null, files }, null, 2) }],
    };
  }

  if (req.params.name === 'get_file') {
    const kbRel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!kbRel) throw new Error('`path` is required');
    const content = await tryWebElseEmbedded(
      'get_file',
      () => getFileViaWeb(kbRel),
      async () => {
        // Direct fs read. We don't need the daemon for content retrieval.
        const abs = path.resolve(getKbRoot(), kbRel);
        if (!isUnderRoot(abs)) throw new Error('path escapes kbRoot');
        try { return fs.readFileSync(abs, 'utf8'); }
        catch (err: any) {
          if (err?.code === 'ENOENT') return null;
          throw err;
        }
      },
    );
    if (content == null) throw new Error(`file not found: ${kbRel}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ path: kbRel, content }, null, 2) }],
    };
  }

  if (req.params.name === 'library_info') {
    const info = await tryWebElseEmbedded(
      'library_info',
      () => libraryInfoViaWeb(),
      async () => {
        // Embedded path needs the daemon up + spaces bound so the
        // per-space file counts in the info payload are accurate.
        const { ready } = getEmbedded();
        await ready;
        return getLibraryInfo();
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }

  if (req.params.name === 'update_library_overview') {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) throw new Error('`content` is required');
    await tryWebElseEmbedded(
      'update_library_overview',
      () => updateLibraryOverviewViaWeb(content),
      async () => { setLibraryOverview(content); },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    };
  }

  if (req.params.name === 'index_status') {
    const status = await tryWebElseEmbedded(
      'index_status',
      () => statusViaWeb(space),
      async () => {
        const { indexer, ready } = getEmbedded();
        await ready;
        return indexer.status(space);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ space: space ?? null, ...status as object }, null, 2) }],
    };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write('[StashBase] MCP server ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`[StashBase] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});

process.on('exit', () => {
  embedded?.close().catch(() => {});
});
