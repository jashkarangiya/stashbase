#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local KB to Claude Desktop / Claude Code.
 *
 * Four tools: search_kb / list_files / get_file / index_status.
 *
 * Two execution paths for the search / status calls:
 *   1. If the web server is running on :8090, **forward over HTTP** —
 *      we share its single Python sidecar instead of spawning a second
 *      one (which would double-load the ~200 MB bge-m3 ONNX model and
 *      fight over Milvus Lite's file lock).
 *   2. If :8090 isn't answering, fall back to an **embedded MfsIndexer**
 *      that spawns its own daemon. Lets Claude Desktop work even when
 *      the user hasn't opened the Electron app. The embedded path reads
 *      the same `~/.stashbase/config.json` the web server writes, so a
 *      provider switch (Local ↔ OpenAI) made in the desktop UI is
 *      picked up next time MCP cold-starts an embedded daemon.
 *
 * `list_files` / `get_file` also forward to the web server when it's
 * live — otherwise MCP's notion of "current space" lags behind the
 * desktop app (the two processes don't share in-memory state, and a
 * space switch in the UI only updates the web process). Falls back to
 * local disk reads against MCP's bootstrap space when web is offline.
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
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MfsIndexer } from '../server/indexer.mfs.ts';
import { listFiles, readText } from '../server/files.ts';
import {
  getApiKey,
  getCurrentSpace,
  getRecentSpaces,
  getSpaceEmbedderProvider,
  migrateLegacyEmbedderConfig,
  setCurrentSpace,
} from '../server/space.ts';
import type { EmbedderRuntimeConfig } from '../server/indexer.ts';

// Idempotent migration from the old global-provider config shape.
// Safe to run from both the web server and MCP — second call no-ops.
migrateLegacyEmbedderConfig();

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

// MCP runs as a separate process from the web server, so it can't read
// the web's in-memory current-space. Resolve one at startup from the
// most-recent space in ~/.stashbase/config.json (shared with web).
function bootstrapSpace(): void {
  const recent = getRecentSpaces();
  if (recent.length > 0) {
    try { setCurrentSpace(recent[0].path); return; } catch { /* no recent space available */ }
  }
}
bootstrapSpace();

// Lazily constructed: only spawn an embedded daemon if the web server
// isn't reachable AND a search/status tool actually gets called.
let embedded: MfsIndexer | null = null;
function getEmbedded(): MfsIndexer {
  if (embedded) return embedded;
  const inst = new MfsIndexer();
  embedded = inst;
  // Apply the current space's persisted provider + bind space in one
  // async chain so both finish before any tool call needs the daemon.
  // If the space wants openai but no global key is set, we fall back
  // to local ONNX with a stderr breadcrumb — better than failing
  // every search.
  (async () => {
    try {
      const space = getCurrentSpace();
      if (!space) return;
      const provider = getSpaceEmbedderProvider(space);
      const apiKey = getApiKey();
      let runtime: EmbedderRuntimeConfig;
      if (provider === 'openai' && apiKey) {
        runtime = { provider: 'openai', apiKey };
      } else {
        if (provider === 'openai') {
          process.stderr.write(
            '[StashBase] embedder: space wants openai but no key in ~/.stashbase/config.json; ' +
              'falling back to local ONNX\n',
          );
        }
        runtime = { provider: 'onnx' };
      }
      await inst.setEmbedder(runtime);
      await inst.setSpace(space);
    } catch (err: unknown) {
      process.stderr.write(`[StashBase] embedded init failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  })();
  return inst;
}

/** Cache the web-live answer for a few seconds so a single Claude
 *  conversation doesn't pay the 300 ms probe latency on every tool
 *  call. Web-server state is sticky — it doesn't flip mid-conversation
 *  in any realistic scenario — and any in-flight web call that does
 *  fail can call `invalidateWebLive` to force a re-probe on the next
 *  tool. */
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

/** Run `viaWeb` if the web server is live; on success return its result.
 *  On failure (web went down between probe and call), invalidate the
 *  liveness cache and fall through to `viaEmbedded`. Used for every
 *  tool callsite so a transient hiccup never surfaces as a tool error. */
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

async function searchViaWeb(query: string, topK: number): Promise<unknown[]> {
  const r = await fetch(`${WEB_BASE}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!r.ok) throw new Error(`web /api/search failed: ${r.status}`);
  const j = await r.json() as { hits: unknown[] };
  return j.hits;
}

async function statusViaWeb(): Promise<unknown> {
  const r = await fetch(`${WEB_BASE}/api/index-status`);
  if (!r.ok) throw new Error(`web /api/index-status failed: ${r.status}`);
  return r.json();
}

async function listFilesViaWeb(): Promise<unknown[]> {
  const r = await fetch(`${WEB_BASE}/api/files`);
  if (!r.ok) throw new Error(`web /api/files failed: ${r.status}`);
  const j = await r.json() as { files: unknown[] };
  return j.files;
}

async function getFileViaWeb(name: string): Promise<string | null> {
  const r = await fetch(`${WEB_BASE}/api/files/${encodeURIComponent(name)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`web /api/files/${name} failed: ${r.status}`);
  const j = await r.json() as { content: string };
  return j.content;
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
        'Each hit returns the source file name, the chunk content, optional heading and ' +
        'source line range (`start_line` / `end_line`), and a fused relevance score. Use ' +
        'this when the user asks something the notes might answer; for navigating by file ' +
        "name use `list_files`, and to pull a full document use `get_file` after you've " +
        'located it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
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
        'List every note file currently in the knowledge base, with brief metadata ' +
        '(filename, first heading, first-line snippet, import date). Use to enumerate ' +
        'the corpus when search alone isn\'t the right tool — e.g. the user asks "what ' +
        'notes do I have on X" or you need to pick a file by name.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_file',
      description:
        'Fetch the full raw content of one file by exact name. Use after `search_kb` ' +
        '(a chunk hit caught your eye and you want the surrounding doc) or `list_files` ' +
        '(you picked a name and want the body). Returns the original source as text — ' +
        'no preview rendering.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'File name including extension (e.g. "architecture.md").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'index_status',
      description:
        'Check whether the local knowledge base index has caught up with the files on ' +
        'disk. Returns `{total, indexed, pending_count, pending, up_to_date}` — ' +
        '`pending` is the full list of file paths still waiting to be indexed. ' +
        'Call this when `search_kb` returns fewer or less relevant results than the user ' +
        'expected — especially right after they imported a folder. If `up_to_date` is ' +
        'false, results from `search_kb` may be incomplete: tell the user how many files ' +
        'are still pending (and quote a few names from `pending`) so they know to wait.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (req.params.name === 'search_kb') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('`query` is required');
    const k = Math.max(
      1,
      Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
    );
    const hits = await tryWebElseEmbedded(
      'search',
      () => searchViaWeb(query, k),
      () => getEmbedded().search(query, k),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ query, top_k: k, hits }, null, 2) }],
    };
  }

  if (req.params.name === 'list_files') {
    // Prefer the web server's view when it's running — it owns "current
    // space" for the desktop session. MCP's own `currentSpace` is only
    // ever the bootstrap value (recent[0] at startup) and goes stale
    // the moment the user switches space in the UI.
    const files = await tryWebElseEmbedded<unknown[]>(
      'list_files',
      () => listFilesViaWeb(),
      async () => listFiles() as unknown[],
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ files }, null, 2) }],
    };
  }

  if (req.params.name === 'get_file') {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) throw new Error('`name` is required');
    const content = await tryWebElseEmbedded(
      'get_file',
      () => getFileViaWeb(name),
      async () => readText(name),
    );
    if (content == null) throw new Error(`file not found: ${name}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ name, content }, null, 2) }],
    };
  }

  if (req.params.name === 'index_status') {
    const status = await tryWebElseEmbedded(
      'index_status',
      () => statusViaWeb(),
      async () => {
        const root = getCurrentSpace();
        if (!root) throw new Error('no space open');
        return getEmbedded().status(root);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
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
