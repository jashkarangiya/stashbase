#!/usr/bin/env -S npx tsx
/**
 * Stdio MCP server exposing the local KB to Claude Desktop / Claude Code.
 *
 * Built-in tools include semantic search, reindex, and host-side file
 * CRUD. File paths are kbRoot-relative (`Space/note.md`).
 *
 * All tools default to the **whole knowledge base** under
 * `~/Documents/StashBase/` and accept an optional `space` argument to
 * scope to one space (e.g. `space: "cs183b"`). Paths are kbRoot-relative
 * (`cs183b/lecture-01.md`).
 *
 * Single execution path: every tool forwards over HTTP to the StashBase
 * server on :8090 (`/api/kb/*` endpoints, kbRoot-relative paths). If the
 * server isn't running, this host SPAWNS it headless and waits for it to
 * come up — it never opens the store itself. The `:8090` port bind is the
 * singleton arbiter: when two MCP hosts race to spawn, one server wins the
 * port, the loser exits with EADDRINUSE, and both hosts connect to the
 * winner. Exactly one daemon process can therefore exist per machine,
 * which kills the multi-daemon Milvus lock-fight class by construction
 * (data-layer §8.7).
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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ensureKbRoot, listKnownSpaces, needsKbRootPicker } from '../server/space.ts';
import { migrateLegacyEmbedderConfig } from '../server/app-config.ts';
import { type KbInfo } from '../server/kb.ts';

// Idempotent migrations. Safe to run from both the web server and MCP —
// second call no-ops.
migrateLegacyEmbedderConfig();
if (!needsKbRootPicker()) {
  ensureKbRoot();
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

// ---------------------------------------------------------------------------
// Headless server spawn — the singleton story.
//
// This host never opens the store. When :8090 isn't answering it spawns
// the StashBase server (no Electron window) and polls until ready. The
// port bind is the only mutual exclusion: a concurrent spawn from another
// MCP host loses with EADDRINUSE and simply connects to the winner.
// ---------------------------------------------------------------------------

const APP_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : APP_ROOT;
const SERVER_START_TIMEOUT_MS = 30_000;

function statIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function sidecarExecutable(root: string, name: string, opts: { direct?: boolean } = {}): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return opts.direct
    ? path.join(root, exe)
    : path.join(root, name, exe);
}

function pythonCandidates(root: string): string[] {
  return process.platform === 'win32'
    ? [
        path.join(root, 'Scripts', 'python.exe'),
        path.join(root, 'bin', 'python'),
      ]
    : [
        path.join(root, 'bin', 'python'),
        path.join(root, 'Scripts', 'python.exe'),
      ];
}

/** Spawn the server detached so it outlives this stdio host. Mirrors the
 *  env injection `electron/main.cjs:ensureServer` does for the GUI path:
 *  the packaged app has no Python interpreter, so the sidecar binaries
 *  must be pointed at explicitly. Output goes to a per-launch log under
 *  ~/.stashbase/ so a headless boot stays debuggable. */
function spawnHeadlessServer(): void {
  const builtEntry = path.join(APP_ROOT, 'dist', 'server', 'index.mjs');
  const useBuilt = statIsFile(builtEntry);

  const sidecarRoot = path.join(RESOURCES_ROOT, 'python', 'sidecar');
  const daemonBin = [
    sidecarExecutable(sidecarRoot, 'stashbase-daemon'),
    sidecarExecutable(sidecarRoot, 'stashbase-daemon', { direct: true }),
  ].find(statIsFile);
  const extractBin = [
    sidecarExecutable(sidecarRoot, 'stashbase-extract'),
    sidecarExecutable(sidecarRoot, 'stashbase-extract', { direct: true }),
  ].find(statIsFile);
  const pythonBin = [
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', 'runtime')),
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', '.venv')),
  ].find(statIsFile);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STASHBASE_HEADLESS: '1',
    STASHBASE_APP_ROOT: APP_ROOT,
    STASHBASE_RESOURCES_PATH: RESOURCES_ROOT,
    ...(useBuilt ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(daemonBin ? { STASHBASE_DAEMON_BIN: daemonBin } : {}),
    ...(extractBin ? { STASHBASE_EXTRACT_BIN: extractBin } : {}),
    ...(pythonBin ? { STASHBASE_PYTHON: pythonBin } : {}),
  };
  const [command, args] = useBuilt
    ? [process.execPath, [builtEntry]]
    : [path.join(APP_ROOT, 'node_modules', '.bin', 'tsx'), [path.join(APP_ROOT, 'server', 'index.ts')]];
  // Packaged APP_ROOT is app.asar — a file, unusable as cwd (ENOTDIR at
  // the spawn syscall). Fall back to the real Resources/ directory.
  let cwd = APP_ROOT;
  try { if (!fs.statSync(APP_ROOT).isDirectory()) cwd = RESOURCES_ROOT; } catch { cwd = RESOURCES_ROOT; }

  let stdio: ('ignore' | number)[] = ['ignore', 'ignore', 'ignore'];
  try {
    const logPath = path.join(os.homedir(), '.stashbase', 'headless-server.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'w');
    fs.writeSync(
      fd,
      `--- StashBase headless server launch ${new Date().toISOString()} (pid=${process.pid}, built=${useBuilt}) ---\n`,
    );
    fs.writeSync(fd, `server entry: ${useBuilt ? builtEntry : path.join(APP_ROOT, 'server', 'index.ts')}\n`);
    fs.writeSync(fd, `cwd: ${cwd}\n`);
    fs.writeSync(fd, `resources: ${RESOURCES_ROOT}\n`);
    fs.writeSync(fd, `daemon: ${daemonBin || '(missing; using Python script fallback if available)'}\n`);
    fs.writeSync(fd, `extractor: ${extractBin || '(missing; using Python script fallback if available)'}\n`);
    fs.writeSync(fd, `python: ${pythonBin || '(missing)'}\n`);
    stdio = ['ignore', fd, fd];
  } catch { /* logging is best-effort */ }

  const child = spawn(command, args, { cwd, env, detached: true, stdio });
  child.on('error', (err) => {
    process.stderr.write(`[StashBase] headless server spawn failed: ${err.message}\n`);
  });
  child.unref();
  process.stderr.write(`[StashBase] spawned headless server (pid=${child.pid})\n`);
}

async function probeWebOnce(timeoutMs = 300): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${WEB_BASE}/api/space`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// Single-flight: concurrent tool calls during a cold start share one
// spawn-and-wait instead of racing N spawns from the same host.
let webStartInflight: Promise<void> | null = null;

/** Make sure a server is answering on :8090, spawning one if needed.
 *  After this resolves, web calls can proceed. */
async function ensureWeb(): Promise<void> {
  if (await webIsLive()) return;
  if (!webStartInflight) {
    webStartInflight = (async () => {
      spawnHeadlessServer();
      const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 300));
        if (await probeWebOnce()) {
          webLiveCache = { value: true, expires: Date.now() + WEB_LIVE_TTL_MS };
          return;
        }
      }
      throw new Error(
        'StashBase server did not come up on :8090 within 30s — ' +
          'check ~/.stashbase/headless-server.log',
      );
    })().finally(() => { webStartInflight = null; });
  }
  return webStartInflight;
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

/** Run a web call, starting the server first if needed. A transport-level
 *  failure (fetch rejects with TypeError — refused/reset) means the server
 *  died between probe and call: restart once and retry. HTTP-status errors
 *  are real application answers and are rethrown untouched. */
async function viaWeb<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await ensureWeb();
  try {
    return await fn();
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) throw err;
    invalidateWebLive();
    process.stderr.write(`[StashBase] web ${label} dropped mid-call, restarting server: ${err.message}\n`);
    await ensureWeb();
    return fn();
  }
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

async function kbInfoViaWeb(): Promise<KbInfo> {
  const r = await fetch(`${WEB_BASE}/api/kb/info`);
  if (!r.ok) throw new Error(`web /api/kb/info failed: ${r.status}`);
  return r.json() as Promise<KbInfo>;
}

async function syncViaWeb(space: string | undefined): Promise<unknown> {
  const url = space ? `${WEB_BASE}/api/sync?space=${encodeURIComponent(space)}` : `${WEB_BASE}/api/sync`;
  const r = await fetch(url, { method: 'POST', headers: webHeaders() });
  if (!r.ok) throw new Error(`web POST /api/sync failed: ${r.status}`);
  return r.json();
}

async function webJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`web ${init?.method ?? 'GET'} ${url.replace(WEB_BASE, '')} failed: ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
  }
  return r.json() as Promise<T>;
}

function kbQuery(pathValue: unknown): string {
  const pathParam = typeof pathValue === 'string' ? pathValue : '';
  return `path=${encodeURIComponent(pathParam)}`;
}

async function listDirectoryViaWeb(pathValue: unknown): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/directory?${kbQuery(pathValue)}`, { headers: webHeaders() });
}

async function readFileViaWeb(pathValue: unknown): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/file?${kbQuery(pathValue)}`, { headers: webHeaders() });
}

async function writeFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/file`, {
    method: 'PUT',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      path: args.path,
      content: args.content,
      ...(typeof args.baseVersion === 'string' ? { baseVersion: args.baseVersion } : {}),
    }),
  });
}

async function editFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/file/edit`, {
    method: 'POST',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      path: args.path,
      old_text: args.old_text,
      new_text: args.new_text,
      replace_all: args.replace_all === true,
      ...(typeof args.baseVersion === 'string' ? { baseVersion: args.baseVersion } : {}),
    }),
  });
}

async function moveFileViaWeb(args: Record<string, unknown>): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/file/move`, {
    method: 'PATCH',
    headers: webHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      path: args.path,
      new_path: args.new_path,
      cascade: args.cascade !== false,
    }),
  });
}

async function deleteFileViaWeb(pathValue: unknown): Promise<unknown> {
  return webJson(`${WEB_BASE}/api/kb/file?${kbQuery(pathValue)}`, {
    method: 'DELETE',
    headers: webHeaders(),
  });
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;

const server = new Server(
  { name: 'stashbase', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'StashBase exposes a local Markdown / HTML knowledge base through host-side ' +
      'MCP tools. External agent shells may be sandboxed and unable to read the ' +
      'user\'s absolute filesystem paths, so DO NOT use shell/cat or generic ' +
      'filesystem tools for StashBase paths. Use `list_directory`, `read_file`, ' +
      '`write_file`, `edit_file`, `move_file`, and `delete_file` instead.\n\n' +
      'At the start of a session, call `kb_info`. It returns `kb_root` (the absolute ' +
      'path of the knowledge base), the list of spaces, and the `STASHBASE.md` rules ' +
      '— FOLLOW those rules for everything you do to the KB.\n\n' +
      'All file tools take kbRoot-relative POSIX paths such as `Space/note.md`; ' +
      '`search_kb` returns paths in the same form. `write_file`, `edit_file`, ' +
      '`move_file`, and `delete_file` update the semantic index when an API key is ' +
      'configured. Call `reindex` after bulk external changes or whenever a tool ' +
      'returns an index warning.\n\n' +
      'When you CREATE a new derived file (e.g. a generated summary), add ' +
      '`generated_by: stashbase-agent` to its Markdown YAML front-matter (or an HTML ' +
      '`<meta name="generated_by" content="stashbase-agent">`) so the user can later ' +
      'bulk-identify agent-generated output. Never put credentials in files.',
  },
);

const BUILTIN_TOOLS = [
    {
      name: 'kb_info',
      description:
        'Orient yourself in the StashBase knowledge base. **Call this first** in a ' +
        'new conversation. Returns `{kb_root, spaces, rules}` where `kb_root` is the ' +
        'ABSOLUTE filesystem path of the knowledge base, `spaces` lists each space ' +
        '(name + embedder provider), and `rules` is the KB-level `STASHBASE.md` ' +
        'maintenance contract you must follow. Use StashBase file tools for paths ' +
        'under `kb_root`; sandboxed shells may not be able to see those host files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_directory',
      description:
        'List visible files and folders in the knowledge base. `path` is optional; omit ' +
        'or pass "" to list spaces, pass `Space` to list a space root, or pass ' +
        '`Space/folder` to list a folder. Paths are kbRoot-relative POSIX paths. Hidden ' +
        'app-maintained derived notes and bundle folders are not surfaced.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional kbRoot-relative directory path.' },
        },
      },
    },
    {
      name: 'read_file',
      description:
        'Read a Markdown or HTML text file from StashBase by kbRoot-relative path ' +
        '(for example `Space/note.md`). Binary files such as PDFs/images are visible ' +
        'in `list_directory` but cannot be returned as text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'kbRoot-relative file path.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a Markdown/HTML text file. Creates parent folders as ' +
        'needed, writes atomically, and updates the semantic index when an API key is configured.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'kbRoot-relative file path.' },
          content: { type: 'string', description: 'Full file content to write.' },
          baseVersion: { type: 'string', description: 'Optional version from read_file for optimistic conflict checks.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Patch a Markdown/HTML text file by exact string replacement. By default ' +
        '`old_text` must match exactly once; set `replace_all` for global replacement.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'kbRoot-relative file path.' },
          old_text: { type: 'string', description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a single match.' },
          baseVersion: { type: 'string', description: 'Optional version from read_file for optimistic conflict checks.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    {
      name: 'move_file',
      description:
        'Rename or move a file within the same space. Keeps note attachment bundles ' +
        'and PDF/image derived artifacts together, optionally cascades Markdown/HTML links, ' +
        'and updates the semantic index when possible.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Existing kbRoot-relative file path.' },
          new_path: { type: 'string', description: 'New kbRoot-relative file path in the same space.' },
          cascade: { type: 'boolean', description: 'Update links that point at the moved file. Defaults true.' },
        },
        required: ['path', 'new_path'],
      },
    },
    {
      name: 'delete_file',
      description:
        'Delete a visible file by kbRoot-relative path. Also removes note bundles or ' +
        'PDF/image derived artifacts owned by that file, and cleans the semantic index asynchronously.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'kbRoot-relative file path.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_kb',
      description:
        'Hybrid (vector + full-text) search over the local Markdown / HTML knowledge base. ' +
        'Searches the **whole knowledge base** by default — every space under the kb_root ' +
        'from `kb_info` — and scopes to one space when `space` is provided (e.g. "cs183b" ' +
        'or "work/research"). For finer control, `path_prefix` restricts hits to chunks ' +
        'whose kbRoot-relative source starts with that prefix (e.g. "cs183b/transcripts/"). ' +
        'Each hit returns the kbRoot-relative file path (`<space>/<file>`), the chunk content, ' +
        'optional heading and source line range, and a fused relevance score. Use this when ' +
        'the user asks something the notes might answer; read full text documents with `read_file`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          space: {
            type: 'string',
            description:
              'Optional space name (kbRoot-relative path of a folder under kb_root, ' +
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
      name: 'reindex',
      description:
        'Reconcile the semantic index with the files currently on disk, then report ' +
        'index health. StashBase file tools update the index themselves when possible; ' +
        'call this after bulk external changes or when a file tool returns an index warning. ' +
        'You do NOT need to ' +
        'say what changed: the sweep diffs disk against the index and discovers added / ' +
        'modified / removed / renamed files itself. Defaults to the **whole knowledge ' +
        'base**; pass `space` to limit the disk walk to one space. Re-embedding cost is ' +
        'proportional to the diff (only changed files are re-embedded), not the KB size. ' +
        'Returns `{spaces: [{space, added, modified, removed, renamed, failed}], ' +
        'total, indexed, pendingCount, pending, upToDate}` — the totals come from a ' +
        'whole-KB index-status check run after the sweep.',
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
  ];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...BUILTIN_TOOLS, ...await listExternalToolsViaWeb()],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const space = typeof args.space === 'string' && args.space.trim() ? args.space.trim() : undefined;

  if (req.params.name === 'kb_info') {
    const info = await viaWeb('kb_info', () => kbInfoViaWeb());
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }

  if (req.params.name === 'search_kb') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('`query` is required');
    const pathPrefix = typeof args.path_prefix === 'string' && args.path_prefix.trim()
      ? args.path_prefix.trim() : undefined;
    const k = Math.max(
      1,
      Math.min(MAX_TOP_K, Math.floor(typeof args.top_k === 'number' ? args.top_k : DEFAULT_TOP_K)),
    );
    const hits = await viaWeb('search', () => searchViaWeb(query, k, space, pathPrefix));
    return {
      content: [{ type: 'text', text: JSON.stringify({ query, space: space ?? null, path_prefix: pathPrefix ?? null, top_k: k, hits }, null, 2) }],
    };
  }

  if (req.params.name === 'list_directory') {
    const result = await viaWeb('list_directory', () => listDirectoryViaWeb(args.path));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'read_file') {
    const result = await viaWeb('read_file', () => readFileViaWeb(args.path));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'write_file') {
    const result = await viaWeb('write_file', () => writeFileViaWeb(args));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'edit_file') {
    const result = await viaWeb('edit_file', () => editFileViaWeb(args));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'move_file') {
    const result = await viaWeb('move_file', () => moveFileViaWeb(args));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'delete_file') {
    const result = await viaWeb('delete_file', () => deleteFileViaWeb(args.path));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  if (req.params.name === 'reindex') {
    // No-scope = reconcile every known space — an external agent can ship
    // "sync everything" without knowing the knowledge-base layout. Each
    // space runs through /api/sync independently so a failure in one
    // doesn't poison the others; failures land in that sub-result's
    // `error`, not a top-level throw. After the sweep we fetch one
    // whole-KB index-status so the agent gets `{added/…, total, indexed,
    // pending, upToDate}` from a single call.
    const targets = space ? [space] : listKnownSpaces();
    const perSpace: Array<{ space: string; added?: unknown; error?: string }> = [];
    for (const target of targets) {
      try {
        const result = await viaWeb(`reindex:${target}`, () => syncViaWeb(target));
        perSpace.push({ space: target, ...(result as object) });
      } catch (err: unknown) {
        perSpace.push({ space: target, error: err instanceof Error ? err.message : String(err) });
      }
    }
    let status: object = {};
    try {
      status = (await viaWeb('reindex:status', () => statusViaWeb(space))) as object;
    } catch {
      // Status is a convenience on top of the reconcile result; if it
      // fails, still return the per-space sweep outcome.
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ spaces: perSpace, ...status }, null, 2) }],
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
