#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local KB to Claude Desktop / Claude Code.
 *
 * Four tools: `search_kb` / `list_files` / `get_file` / `index_status`.
 *
 * All tools default to the **whole knowledge base** under
 * `~/Documents/StashBase/` and accept an optional `space` argument to
 * scope to one space (e.g. `space: "cs183b"`). Paths are kbRoot-relative
 * (`cs183b/lecture-01.md`).
 *
 * Two execution paths:
 *   1. If the StashBase desktop app is running and serving on :8090,
 *      **forward over HTTP** — its single Python sidecar holds the
 *      embedding models and Milvus file lock. We hit dedicated
 *      `/api/kb/*` endpoints that operate on kbRoot-relative paths.
 *   2. If :8090 isn't answering, fall back to an **embedded MfsIndexer**
 *      that spawns its own daemon, configured with kbRoot from
 *      `~/.stashbase/config.json` and pre-binding every space under it
 *      so cross-KB search works without the app open.
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
  getKbRoot,
  isInsideKbRoot,
  listKnownSpaces,
  needsKbRootPicker,
} from '../server/space.ts';
import { getApiKey, migrateLegacyEmbedderConfig } from '../server/app-config.ts';
import { getDaemon } from '../server/mfs-daemon.ts';
import {
  ensureKbOverview,
  getKbInfo,
  getResolvedRules,
  getSpaceInfoFull,
  setKbOverview,
  setSpaceRules,
  type KbInfo,
  type SpaceInfoFull,
} from '../server/kb.ts';
import {
  isReservedMetadataFile,
  setFileMetadataEntry,
  type FileMetadata,
} from '../server/metadata.ts';
import { syncIndex } from '../server/sync.ts';

// Idempotent migrations. Safe to run from both the web server and MCP —
// second call no-ops.
migrateLegacyEmbedderConfig();
if (!needsKbRootPicker()) {
  ensureKbRoot();
  ensureKbOverview();
}

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

/** Tear down the embedded indexer and its daemon child. Fired whenever
 *  we observe the web app alive: the GUI server's daemon is the
 *  rightful owner of the store, and a leftover embedded daemon (from an
 *  earlier GUI-down window) would fight it for the Milvus Lite flock —
 *  the loser keeps "succeeding" while its writes silently go nowhere.
 *  Re-spawning later is cheap: getEmbedded() rebuilds and re-binds. */
function closeEmbedded(reason: string): void {
  if (!embedded) return;
  const inst = embedded;
  embedded = null;
  embeddedReady = null;
  process.stderr.write(`[StashBase] closing embedded daemon (${reason})\n`);
  void inst.close().catch(() => undefined);
}

function getEmbedded(): { indexer: MfsIndexer; ready: Promise<void> } {
  if (embedded && embeddedReady) return { indexer: embedded, ready: embeddedReady };
  const inst = new MfsIndexer();
  embedded = inst;
  embeddedReady = (async () => {
    // Configure the daemon with kbRoot, then bind every known space so
    // cross-KB search works without the user having to "open" each
    // one in some session that doesn't exist (MCP runs headless).
    const daemon = getDaemon();
    daemon.configure({ kbRoot: getKbRoot() });
    const known = listKnownSpaces();
    const apiKey = getApiKey();
    // V1 is OpenAI-only. With no key, spaces still bind (registered) but
    // indexing/search stay disabled until a key is set.
    const cfg = apiKey
      ? ({ provider: 'openai' as const, apiKey })
      : ({ provider: 'openai' as const });
    if (!apiKey) {
      process.stderr.write(
        '[StashBase] no OpenAI key in ~/.stashbase/config.json; ' +
          'search/indexing disabled until one is added\n',
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

interface HostedMcpTool {
  server: string;
  name: string;
  fqName: string;
  description?: string;
  inputSchema?: unknown;
}

const externalToolMap = new Map<string, string>();

function webHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const windowId = process.env.STASHBASE_WINDOW_ID;
  if (windowId) headers['x-stashbase-window-id'] = windowId;
  return headers;
}

async function listExternalToolsViaWeb(): Promise<Array<Record<string, unknown>>> {
  if (!process.env.STASHBASE_WINDOW_ID) return [];
  if (!await webIsLive()) return [];
  try {
    const r = await fetch(`${WEB_BASE}/api/mcp/tools`, { headers: webHeaders() });
    if (!r.ok) throw new Error(`web /api/mcp/tools failed: ${r.status}`);
    const j = await r.json() as { tools?: HostedMcpTool[] };
    externalToolMap.clear();
    return (j.tools ?? []).map((tool, i) => {
      const name = externalToolName(tool, i);
      externalToolMap.set(name, tool.fqName);
      return {
        name,
        description: `Per-space MCP tool ${tool.fqName}. ${tool.description ?? ''}`.trim(),
        inputSchema: normalizeInputSchema(tool.inputSchema),
      };
    });
  } catch (err: unknown) {
    process.stderr.write(`[StashBase] listing per-space MCP tools failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }
}

async function callExternalToolViaWeb(name: string, args: Record<string, unknown>): Promise<unknown> {
  let fqName = externalToolMap.get(name);
  if (!fqName) {
    await listExternalToolsViaWeb();
    fqName = externalToolMap.get(name);
  }
  if (!fqName) throw new Error(`unknown tool: ${name}`);
  const r = await fetch(`${WEB_BASE}/api/mcp/tools/call`, {
    method: 'POST',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name: fqName, arguments: args }),
  });
  if (!r.ok) throw new Error(`web /api/mcp/tools/call failed: ${r.status}`);
  const j = await r.json() as { result: unknown };
  return j.result;
}

function externalToolName(tool: HostedMcpTool, index: number): string {
  return `space_${index}_${slugToolPart(tool.server)}_${slugToolPart(tool.name)}`;
}

function slugToolPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'tool';
}

function normalizeInputSchema(schema: unknown): unknown {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema;
  return { type: 'object', properties: {}, additionalProperties: true };
}

async function tryWebElseEmbedded<T>(
  label: string,
  viaWeb: () => Promise<T>,
  viaEmbedded: () => Promise<T>,
): Promise<T> {
  if (await webIsLive()) {
    // Web alive ⇒ its daemon owns the store; make sure a leftover
    // embedded daemon isn't still up competing for the Milvus flock.
    closeEmbedded('web is live');
    try {
      return await viaWeb();
    } catch (err: unknown) {
      // Fall back ONLY on transport-level failure (Node fetch rejects
      // with TypeError on refused/reset/DNS) — that means the web app is
      // actually gone. An HTTP-status error means the server is alive
      // and gave a real answer; spawning a second daemon against the
      // same Milvus Lite store to mask an APPLICATION error is how the
      // flock fight starts (see closeEmbedded). Rethrow those.
      if (!(err instanceof TypeError)) throw err;
      invalidateWebLive();
      process.stderr.write(`[StashBase] web ${label} unreachable, falling back to embedded: ${err.message}\n`);
    }
  }
  return viaEmbedded();
}

async function searchViaWeb(
  query: string,
  topK: number,
  space: string | undefined,
  pathPrefix?: string,
): Promise<unknown[]> {
  const body: Record<string, unknown> = { query, top_k: topK };
  if (space) body.space = space;
  if (pathPrefix) body.path_prefix = pathPrefix;
  const r = await fetch(`${WEB_BASE}/api/kb/search`, {
    method: 'POST',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`web /api/kb/search failed: ${r.status}`);
  const j = await r.json() as { hits: unknown[] };
  return j.hits;
}

async function statusViaWeb(space: string | undefined): Promise<unknown> {
  const url = space ? `${WEB_BASE}/api/kb/index-status?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/kb/index-status`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`web /api/kb/index-status failed: ${r.status}`);
  return r.json();
}

async function listFilesViaWeb(space: string | undefined): Promise<string[]> {
  const url = space ? `${WEB_BASE}/api/kb/files?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/kb/files`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`web /api/kb/files failed: ${r.status}`);
  const j = await r.json() as { files: string[] };
  return j.files;
}

async function kbInfoViaWeb(): Promise<KbInfo> {
  const r = await fetch(`${WEB_BASE}/api/kb/info`);
  if (!r.ok) throw new Error(`web /api/kb/info failed: ${r.status}`);
  return r.json() as Promise<KbInfo>;
}

async function spaceInfoViaWeb(space: string): Promise<SpaceInfoFull> {
  const r = await fetch(`${WEB_BASE}/api/kb/space-info?space=${encodeURIComponent(space)}`);
  if (!r.ok) throw new Error(`web /api/kb/space-info failed: ${r.status}`);
  return r.json() as Promise<SpaceInfoFull>;
}

async function setFileMetadataViaWeb(kbRel: string, metadata: FileMetadata): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/kb/file-metadata`, {
    method: 'POST',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: kbRel, metadata }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(j.error ?? `web /api/kb/file-metadata failed: ${r.status}`);
  }
}

async function updateKbOverviewViaWeb(content: string): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/kb/overview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`web /api/kb/overview failed: ${r.status}`);
}

async function getFileViaWeb(kbRel: string): Promise<string | null> {
  const r = await fetch(`${WEB_BASE}/api/kb/file/${encodeKbPath(kbRel)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`web /api/kb/file/${kbRel} failed: ${r.status}`);
  const j = await r.json() as { content: string };
  return j.content;
}

async function writeFileViaWeb(kbRel: string, content: string, overwrite: boolean): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/kb/file/${encodeKbPath(kbRel)}`, {
    method: 'PUT',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ content, overwrite }),
  });
  if (r.status === 409) throw new Error(`file exists: ${kbRel} (pass overwrite=true to replace)`);
  if (!r.ok) throw new Error(`web PUT /api/kb/file/${kbRel} failed: ${r.status}`);
}

async function deleteFileViaWeb(kbRel: string): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/kb/file/${encodeKbPath(kbRel)}`, {
    method: 'DELETE',
    headers: webHeaders(),
  });
  if (r.status === 404) throw new Error(`file not found: ${kbRel}`);
  if (!r.ok) throw new Error(`web DELETE /api/kb/file/${kbRel} failed: ${r.status}`);
}

async function renameFileViaWeb(oldRel: string, newRel: string): Promise<void> {
  const r = await fetch(`${WEB_BASE}/api/kb/file/${encodeKbPath(oldRel)}`, {
    method: 'PATCH',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ new_path: newRel }),
  });
  if (r.status === 404) throw new Error(`file not found: ${oldRel}`);
  if (r.status === 409) throw new Error(`target exists: ${newRel}`);
  if (!r.ok) throw new Error(`web PATCH /api/kb/file/${oldRel} failed: ${r.status}`);
}

async function syncViaWeb(space: string | undefined): Promise<unknown> {
  const url = space ? `${WEB_BASE}/api/sync?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/sync`;
  const r = await fetch(url, { method: 'POST', headers: webHeaders() });
  if (!r.ok) throw new Error(`web POST /api/sync failed: ${r.status}`);
  return r.json();
}

async function recentFilesViaWeb(space: string | undefined, limit: number): Promise<unknown[]> {
  const qs = new URLSearchParams();
  if (space) qs.set('space', space);
  qs.set('limit', String(limit));
  const r = await fetch(`${WEB_BASE}/api/kb/recent-files?${qs.toString()}`);
  if (!r.ok) throw new Error(`web /api/kb/recent-files failed: ${r.status}`);
  const j = await r.json() as { files: unknown[] };
  return j.files;
}

function encodeKbPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Split a kbRoot-relative path into `{space, spaceRel}`; null when there
 *  is no space-relative remainder (bare space name). Mirrors the route
 *  helper in `routes/indexing.ts`. */
function splitSpacePath(kbRel: string): { space: string; spaceRel: string } | null {
  const norm = kbRel.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = norm.indexOf('/');
  if (slash < 0) return null;
  const space = norm.slice(0, slash);
  const spaceRel = norm.slice(slash + 1).trim();
  if (!space || !spaceRel) return null;
  return { space, spaceRel };
}

/** Same kbRoot-containment check as `isInsideKbRoot`, with the
 *  one-line throw the embedded tool handlers want. Returns the
 *  absolute path so callers can reuse it for fs ops. */
function resolveUnderKb(kbRel: string): string {
  const abs = path.resolve(getKbRoot(), kbRel);
  if (!isInsideKbRoot(abs)) throw new Error(`path escapes kbRoot: ${kbRel}`);
  return abs;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

const server = new Server(
  { name: 'stashbase', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const BUILTIN_TOOLS = [
    {
      name: 'search_kb',
      description:
        'Hybrid (vector + full-text) search over the local Markdown / HTML knowledge base. ' +
        'Searches the **whole knowledge base** by default — every space under ~/Documents/StashBase/ ' +
        '— and scopes to one space when `space` is provided (e.g. "cs183b" or "work/research"). ' +
        'For finer control, `path_prefix` restricts hits to chunks whose kbRoot-relative source ' +
        'starts with that prefix (e.g. "cs183b/transcripts/" to search only lecture transcripts). ' +
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
              'e.g. "cs183b"). Omit to search the whole knowledge base.',
          },
          path_prefix: {
            type: 'string',
            description:
              'Optional kbRoot-relative path prefix (e.g. "cs183b/transcripts/"). Overrides ' +
              '`space` when present — pass either, not both. Matches any chunk whose source ' +
              'starts with the prefix.',
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
        '`get_file`). Defaults to the whole knowledge base; pass `space` to scope. Returns ' +
        'kbRoot-relative POSIX paths sorted alphabetically.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Optional space name; omit to list across the whole knowledge base.',
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
      name: 'kb_info',
      description:
        'Get a one-shot map of the StashBase knowledge base: a free-form ' +
        '`overview` (the contents of `<kbRoot>/.stashbase/space-metadata.md`, ' +
        'an agent-maintained markdown 目录 that should describe what each ' +
        'space contains) plus structured facts per space (name, ' +
        'embedder provider, file count, a sample of file paths and ' +
        'headings). **Call this first** when starting a new conversation ' +
        'so you can decide which space(s) `search_kb` should target. If ' +
        '`overview` is empty or out of date relative to what you find ' +
        'during a session, update it via `update_space_metadata`.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'space_info',
      description:
        'Structured facts about ONE space (provider, file count, sample files + headings) ' +
        'plus that space\'s section of the KB 目录. Use after `kb_info` to dig ' +
        'into a specific space before `search_kb`. Returns `{name, provider, file_count, ' +
        'sample_files, sample_headings, rules, overview_section}` — `overview_section` is ' +
        'the `## <space>` slice of the agent-maintained 目录, empty when none exists.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Space name (kbRoot-relative folder, e.g. "cs183b" or "work/research").',
          },
        },
        required: ['space'],
      },
    },
    {
      name: 'update_space_metadata',
      description:
        'Overwrite the entire `<kbRoot>/.stashbase/space-metadata.md` 目录 ' +
        'with new markdown content. Call this after you have learned ' +
        'something new about the knowledge base (a new space exists, a topic ' +
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
            description: 'Full markdown content to write to space-metadata.md.',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'get_rules',
      description:
        'Read StashBase maintenance rules. Without `space`, returns KB-level rules. ' +
        'With `space`, returns KB-level rules followed by that space\'s `STASHBASE.md`, ' +
        'so later space rules can override earlier baseline guidance.',
      inputSchema: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Optional space name.' },
        },
      },
    },
    {
      name: 'update_space_rules',
      description:
        'Overwrite one space\'s `STASHBASE.md` maintenance rules. This does not edit ' +
        'the KB-level `STASHBASE.md` baseline.',
      inputSchema: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Space name to update.' },
          content: { type: 'string', description: 'Full markdown content for the space rules.' },
        },
        required: ['space', 'content'],
      },
    },
    {
      name: 'index_status',
      description:
        'Check whether the index has caught up with the files on disk. Returns ' +
        '`{total, indexed, pendingCount, pending, upToDate, snapshotWarning, ' +
        'recentlyIndexed}` for the **whole knowledge base** by default, or for one `space` ' +
        'when scoped. `pending` is the full list of kbRoot-relative paths still ' +
        'waiting to be indexed. `recentlyIndexed` is the top-10 indexed files ' +
        'sorted by on-disk mtime — useful for "did my recent edits get embedded ' +
        'yet?". `snapshotWarning` surfaces a provider-mismatch from a recent ' +
        'snapshot import. Call this when `search_kb` returns fewer or less ' +
        'relevant results than expected — especially right after an import.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Optional space name; omit to check the whole knowledge base.',
          },
        },
      },
    },
    {
      name: 'write_file',
      description:
        'Write a file to the knowledge base at a kbRoot-relative path (e.g. ' +
        '`cs183b/lecture-01.md`). Creates parent directories as needed and updates ' +
        'the semantic index in the background so generated notes return quickly. ' +
        'Call `index_status` if you need to wait until the new content is searchable. ' +
        'Default `overwrite=false` returns an error if the target ' +
        'exists; pass `overwrite=true` to replace user content. Intended for ' +
        'markdown / HTML notes; binary formats can be written but won\'t enter the ' +
        'index. The first path segment is the space name (must be an existing space). ' +
        'When you CREATE a new derived file (e.g. a generated summary), mark it with ' +
        '`generated_by: stashbase-agent` in its Markdown YAML front-matter (or an HTML ' +
        '`<meta name="generated_by" content="stashbase-agent">`) so users can later ' +
        'bulk-identify and clean up agent-generated output.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'kbRoot-relative file path (e.g. "cs183b/lecture-01.md").',
          },
          content: { type: 'string', description: 'File content (UTF-8).' },
          overwrite: {
            type: 'boolean',
            description: 'Replace an existing file at this path. Defaults to false.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'set_file_metadata',
      description:
        'Set the agent-maintained metadata for one file, stored in ' +
        '`<space>/file-metadata.md` — a sidecar kept OUT of the user\'s file so you ' +
        'never edit their content. `path` is kbRoot-relative (e.g. "cs183b/note.md"); ' +
        'its first segment is the space. `metadata` is an object of arbitrary keys; it ' +
        'REPLACES that file\'s whole section (not a merge), and passing an empty object ' +
        '`{}` removes the section. This metadata is merged into the file\'s chunks at ' +
        'index time, but any metadata the user wrote INSIDE the file (front-matter / ' +
        '`<meta>`) still wins. For metadata you derived for a NEW file you generated, ' +
        'include `generated_by: stashbase-agent` so users can bulk-identify agent output.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'kbRoot-relative file path (e.g. "cs183b/note.md"). First segment is the space.',
          },
          metadata: {
            type: 'object',
            description: 'Metadata key/value object. Empty object removes the file\'s section.',
            additionalProperties: true,
          },
        },
        required: ['path', 'metadata'],
      },
    },
    {
      name: 'delete_file',
      description:
        'Delete a file at a kbRoot-relative path and remove it from the index. ' +
        'Returns an error if the file does not exist. Intended for cleanup of ' +
        'agent-written or stale notes — use carefully on user content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'kbRoot-relative file path to delete.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'rename_file',
      description:
        'Rename / move a file from one kbRoot-relative path to another. The new ' +
        'path can be in a different folder within the same space; cross-space ' +
        'moves are allowed but may invalidate links. V1 does NOT cascade-update ' +
        'inbound markdown / HTML links — that lives behind the GUI confirm dialog ' +
        'on `/api/files/*` PATCH. Returns 409 if the target exists.',
      inputSchema: {
        type: 'object',
        properties: {
          old_path: { type: 'string', description: 'Current kbRoot-relative file path.' },
          new_path: { type: 'string', description: 'New kbRoot-relative file path.' },
        },
        required: ['old_path', 'new_path'],
      },
    },
    {
      name: 'update_index',
      description:
        'Force a reconcile sweep on one space (or every known space when `space` ' +
        'is omitted). Use after editing files outside StashBase (git pull, external ' +
        'script writes) when you want the changes searchable without first opening ' +
        'the space in the GUI. Returns a per-space breakdown of ' +
        '`{added, modified, removed, renamed, failed}`. WARNING: triggers ' +
        're-embedding of changed files and consumes embedding tokens proportional ' +
        'to the diff — pass `space` to limit blast radius when you only edited one.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Space name to reconcile. Omit to reconcile every known space.',
          },
        },
      },
    },
    {
      name: 'recent_files',
      description:
        'List indexable files (markdown / HTML) in the knowledge base sorted by on-disk mtime, ' +
        'most recently modified first. Cheap fs walk — no daemon involved. Use to answer ' +
        '"what did the user / I just touch?" or to prime the agent\'s context with the ' +
        'most relevant recent material. Each entry is `{path, mtime_ms}` with `path` ' +
        'kbRoot-relative. Default limit 20, max 200. Pass `space` to scope to one space.',
      inputSchema: {
        type: 'object',
        properties: {
          space: {
            type: 'string',
            description: 'Optional space name; omit to walk the whole knowledge base.',
          },
          limit: {
            type: 'integer',
            description: 'Max files to return. Default 20, capped at 200.',
            minimum: 1,
            maximum: 200,
          },
        },
      },
    },
  ];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...BUILTIN_TOOLS, ...await listExternalToolsViaWeb()],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const space = typeof args.space === 'string' && args.space.trim() ? args.space.trim() : undefined;

  if (req.params.name === 'search_kb') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('`query` is required');
    const pathPrefix = typeof args.path_prefix === 'string' && args.path_prefix.trim()
      ? args.path_prefix.trim() : undefined;
    const k = Math.max(
      1,
      Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
    );
    const hits = await tryWebElseEmbedded(
      'search',
      () => searchViaWeb(query, k, space, pathPrefix),
      async () => {
        const { indexer, ready } = getEmbedded();
        await ready;
        return indexer.search(query, k, space, pathPrefix);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ query, space: space ?? null, path_prefix: pathPrefix ?? null, top_k: k, hits }, null, 2) }],
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
        if (!isInsideKbRoot(abs)) throw new Error('path escapes kbRoot');
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

  if (req.params.name === 'kb_info') {
    const info = await tryWebElseEmbedded(
      'kb_info',
      () => kbInfoViaWeb(),
      async () => {
        // Embedded path needs the daemon up + spaces bound so the
        // per-space file counts in the info payload are accurate.
        const { ready } = getEmbedded();
        await ready;
        return getKbInfo();
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }

  if (req.params.name === 'space_info') {
    if (!space) throw new Error('`space` is required');
    const info = await tryWebElseEmbedded(
      'space_info',
      () => spaceInfoViaWeb(space),
      async () => {
        // Embedded path needs the daemon up + spaces bound so the
        // per-space file count is accurate.
        const { ready } = getEmbedded();
        await ready;
        return getSpaceInfoFull(space);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }

  if (req.params.name === 'update_space_metadata') {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) throw new Error('`content` is required');
    await tryWebElseEmbedded(
      'update_space_metadata',
      () => updateKbOverviewViaWeb(content),
      async () => { setKbOverview(content); },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    };
  }

  if (req.params.name === 'get_rules') {
    const content = await tryWebElseEmbedded(
      'get_rules',
      async () => {
        const url = space ? `${WEB_BASE}/api/rules?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/rules`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`web /api/rules failed: ${r.status}`);
        const j = await r.json() as { content: string };
        return j.content;
      },
      async () => getResolvedRules(space),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ space: space ?? null, content }, null, 2) }],
    };
  }

  if (req.params.name === 'update_space_rules') {
    const target = typeof args.space === 'string' ? args.space.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (!target) throw new Error('`space` is required');
    if (!content) throw new Error('`content` is required');
    await tryWebElseEmbedded(
      'update_space_rules',
      async () => {
        const r = await fetch(`${WEB_BASE}/api/spaces/${encodeURIComponent(target)}/rules`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        if (!r.ok) throw new Error(`web /api/spaces/${target}/rules failed: ${r.status}`);
      },
      async () => { setSpaceRules(target, content); },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, space: target }, null, 2) }],
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

  if (req.params.name === 'write_file') {
    const kbRel = typeof args.path === 'string' ? args.path.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const overwrite = args.overwrite === true;
    if (!kbRel) throw new Error('`path` is required');
    if (typeof args.content !== 'string') throw new Error('`content` (string) is required');
    await tryWebElseEmbedded(
      'write_file',
      () => writeFileViaWeb(kbRel, content, overwrite),
      async () => {
        const abs = resolveUnderKb(kbRel);
        if (fs.existsSync(abs) && !overwrite) {
          throw new Error(`file exists: ${kbRel} (pass overwrite=true to replace)`);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        void (async () => {
          const { indexer, ready } = getEmbedded();
          await ready;
          await indexer.upsertFile(kbRel, content);
        })().catch(() => { /* stdio server cannot log; index_status/update_index can reconcile */ });
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, path: kbRel, indexDeferred: true }, null, 2) }],
    };
  }

  if (req.params.name === 'set_file_metadata') {
    const kbRel = typeof args.path === 'string' ? args.path.trim() : '';
    const metadata = args.metadata;
    if (!kbRel) throw new Error('`path` is required');
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error('`metadata` (object) is required');
    }
    const split = splitSpacePath(kbRel);
    if (!split) throw new Error('`path` must include a space segment, e.g. "cs183b/note.md"');
    if (isReservedMetadataFile(kbRel)) {
      throw new Error('cannot set metadata on a reserved metadata file');
    }
    await tryWebElseEmbedded(
      'set_file_metadata',
      () => setFileMetadataViaWeb(kbRel, metadata as FileMetadata),
      async () => { setFileMetadataEntry(split.space, split.spaceRel, metadata as FileMetadata); },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, path: kbRel }, null, 2) }],
    };
  }

  if (req.params.name === 'delete_file') {
    const kbRel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!kbRel) throw new Error('`path` is required');
    await tryWebElseEmbedded(
      'delete_file',
      () => deleteFileViaWeb(kbRel),
      async () => {
        const abs = resolveUnderKb(kbRel);
        if (!fs.existsSync(abs)) throw new Error(`file not found: ${kbRel}`);
        fs.rmSync(abs);
        const { indexer, ready } = getEmbedded();
        await ready;
        await indexer.deleteFile(kbRel);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, path: kbRel }, null, 2) }],
    };
  }

  if (req.params.name === 'rename_file') {
    const oldRel = typeof args.old_path === 'string' ? args.old_path.trim() : '';
    const newRel = typeof args.new_path === 'string' ? args.new_path.trim() : '';
    if (!oldRel) throw new Error('`old_path` is required');
    if (!newRel) throw new Error('`new_path` is required');
    if (oldRel === newRel) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, path: oldRel }, null, 2) }],
      };
    }
    await tryWebElseEmbedded(
      'rename_file',
      () => renameFileViaWeb(oldRel, newRel),
      async () => {
        const oldAbs = resolveUnderKb(oldRel);
        const newAbs = resolveUnderKb(newRel);
        if (!fs.existsSync(oldAbs)) throw new Error(`file not found: ${oldRel}`);
        if (fs.existsSync(newAbs)) throw new Error(`target exists: ${newRel}`);
        let content: string | null = null;
        try { content = fs.readFileSync(oldAbs, 'utf8'); } catch { /* binary or unreadable — skip re-embed */ }
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.renameSync(oldAbs, newAbs);
        if (content !== null) {
          const { indexer, ready } = getEmbedded();
          await ready;
          try {
            await indexer.renameFile(oldRel, newRel, content);
          } catch (err) {
            try { fs.renameSync(newAbs, oldAbs); } catch { /* best effort */ }
            throw err;
          }
        }
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, path: newRel }, null, 2) }],
    };
  }

  if (req.params.name === 'update_index') {
    // No-scope = reconcile every known space — matches the design
    // contract that an external agent can ship "update everything"
    // without knowing the knowledge-base layout. Each space runs through
    // /api/sync (web path) or syncIndex (embedded path) independently
    // so a failure in one doesn't poison the others; failures land in
    // each sub-result's `failed` field, not a top-level error.
    const targets = space ? [space] : listKnownSpaces();
    if (targets.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ spaces: [], note: 'no known spaces to sync' }, null, 2) }],
      };
    }
    const perSpace: Array<{ space: string; result?: unknown; error?: string }> = [];
    for (const target of targets) {
      try {
        const result = await tryWebElseEmbedded(
          `update_index:${target}`,
          () => syncViaWeb(target),
          async () => {
            const { indexer, ready } = getEmbedded();
            await ready;
            return syncIndex(indexer, target);
          },
        );
        perSpace.push({ space: target, result });
      } catch (err: unknown) {
        perSpace.push({ space: target, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Single-space callers historically expected a flat result; keep
    // that shape when they passed `space`, switch to a list when they
    // didn't, so the response shape matches the intent.
    if (space && perSpace.length === 1) {
      const r = perSpace[0];
      const body = r.error
        ? { space: r.space, error: r.error }
        : { space: r.space, ...(r.result as object) };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ spaces: perSpace }, null, 2) }],
    };
  }

  if (req.params.name === 'recent_files') {
    const limit = Math.max(1, Math.min(200, Math.floor(typeof args.limit === 'number' ? args.limit : 20)));
    const files = await tryWebElseEmbedded(
      'recent_files',
      () => recentFilesViaWeb(space, limit),
      async () => {
        // No web app running — walk the filesystem directly from
        // kbRoot. We don't need the daemon for this; the indexer
        // listFiles intersect is expensive without state.db and adds
        // no signal for "recent".
        const start = space ? path.resolve(getKbRoot(), space) : getKbRoot();
        if (!fs.existsSync(start)) throw new Error(`space not found: ${space}`);
        const skip = new Set([
          '.stashbase', '.git', '.DS_Store', '.Trashes',
          '.Spotlight-V100', '.fseventsd', '.AppleDouble', '.TemporaryItems',
        ]);
        const indexable = /\.(md|markdown|html|htm)$/i;
        const MAX_ENTRIES = 5000;
        const out: Array<{ path: string; mtimeMs: number }> = [];
        const queue: string[] = [start];
        while (queue.length > 0 && out.length < MAX_ENTRIES) {
          const dir = queue.shift()!;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
          catch { continue; }
          for (const e of entries) {
            if (e.name.startsWith('.') && skip.has(e.name)) continue;
            if (e.name.endsWith('_files')) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { queue.push(abs); continue; }
            if (!e.isFile() || !indexable.test(e.name)) continue;
            try {
              const st = fs.statSync(abs);
              const rel = path.relative(getKbRoot(), abs).split(path.sep).join('/');
              out.push({ path: rel, mtimeMs: st.mtimeMs });
            } catch { /* skip unreadable */ }
          }
        }
        out.sort((x, y) => y.mtimeMs - x.mtimeMs);
        return out.slice(0, limit);
      },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ space: space ?? null, limit, files }, null, 2) }],
    };
  }

  if (req.params.name.startsWith('space_')) {
    const result = await callExternalToolViaWeb(req.params.name, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
