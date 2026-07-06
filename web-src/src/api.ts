/**
 * Typed fetch wrappers for every `/api/*` endpoint the server exposes
 * (see `server/index.ts`). Throws `ApiError` on non-2xx so callers can
 * `try/catch` once at the action layer.
 *
 * Paths are always folder-relative POSIX (`topic/note.md`). The server
 * url-encodes them for us inside route patterns; the client must do the
 * same for path segments embedded into the URL.
 */

/** Viewer format the renderer uses for tab routing. `md` / `html` are
 *  text formats loaded from `/api/files/*`; `pdf` and `image` are
 *  binary viewers rendered from `/asset/*`; `docx` is rendered from
 *  AppData-derived HTML. Their searchable text lives in AppData-derived
 *  text, so this type is wider than the server's editable text format on purpose. */
export type FileFormat = 'md' | 'html' | 'pdf' | 'image' | 'docx';

export interface ApiKeySaveResult {
  hasKey: true;
  /** Present when the key was saved but StashBase could not reach
   *  OpenAI to validate it at save time. Indexing/search will surface the
   *  real connectivity failure if it persists. */
  warning?: string;
}

export interface FileMeta {
  name: string;
  format: FileFormat;
  heading: string;
  snippet: string;
  imported_at?: string;
}

export interface FolderMeta {
  path: string;
}

export interface FolderState {
  current: { path: string; name: string } | null;
  recent: { path: string; openedAt: string }[];
  homeDir?: string;
}

export interface FilesPayload {
  files: FileMeta[];
  folders: FolderMeta[];
  folder: string;
}

export interface FileBody {
  name: string;
  format: FileFormat;
  content: string;
  version?: string;
}

/** A local Claude Code session, as listed in the chat panel's History
 *  dropdown. Backed by the Agent SDK's transcript store. */
export interface SessionInfo {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
}

/** One block of a session's replayed transcript. Structurally a subset of
 *  AgentView's `Block` (history tools are always settled), so it drops
 *  straight into `setBlocks`. */
export type SessionBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

export interface IndexStatus {
  folder?: string;
  total: number;
  indexed: number;
  pendingCount: number;
  pending: string[];
  orphanedCount: number;
  orphaned: string[];
  upToDate: boolean;
  /** False when semantic indexing/search is unavailable, e.g. no OpenAI key. */
  semanticEnabled?: boolean;
  /** Human-readable reason when semantic indexing/search is disabled. */
  semanticDisabledReason?: string;
  /** True when no UI-visible file is waiting for embedding. Unlike
   *  upToDate, this ignores orphaned/hidden index rows that are not
   *  relevant to search-readiness accounting. */
  visibleIndexingSettled?: boolean;
  /** False while the server is still loading the index cache for a folder. */
  indexReady?: boolean;
  /** Folder-relative paths of PDFs the server is currently converting
   *  into a readable note + bundle. Empty when no conversions are in
   *  flight. Used by the sidebar to render a transient indicator. */
  pendingConversions?: string[];
  /** Folder-relative conversion progress keyed by visible source path.
   *  Used by PDF preview banners for "Reading page X" / indexing copy. */
  conversionProgress?: Record<string, ConversionProgress>;
  /** Persistent file preparation failures. Survives app restart (read
   *  back from AppData `state.db`). Empty when no failures. Drives
   *  lightweight row markers, rich viewer banners where available, and
   *  the context-menu Reprocess entry. */
  preparationFailures?: PreparationFailure[];
  /** Monotonic counter the server bumps on every external fs event
   *  (after self-write filtering). Renderer compares against its
   *  last-seen value and triggers `/api/files` on any change — picks
   *  up writes from the chat panel (Claude Code, `touch`, …) even
   *  for non-indexable files / empty dirs that don't move `pending`. */
  treeVersion?: number;
  /** Non-null when the active folder's background index sync failed after
   *  opening/importing. Cleared by a successful manual/background sync or
   *  user dismissal. */
  indexWarning?: IndexWarning | null;
}

export type ConversionProgress =
  | { phase: 'extracting'; currentPage?: number }
  | { phase: 'indexing' };

export interface IndexWarning {
  message: string;
  at: string;
}

/** Persistent file preparation failure record — subset of the on-disk
 *  entry, with timestamps the UI doesn't need stripped. */
export interface PreparationFailure {
  path: string;
  lastError: string;
  attempts: number;
}

/** Full file preparation status entries returned by `GET /api/pdf/status`.
 *  Keyed by absolute source path. Rich viewers use this to pick out the
 *  entry for the file they're rendering and decide whether to show the
 *  failure banner. */
export type PdfStatusKind = 'in-flight' | 'done' | 'failed' | 'cancelled';
export interface PdfStatusEntry {
  status: PdfStatusKind;
  attempts: number;
  lastError?: string;
  lastAttemptAt: string;
  doneAt?: string;
}

export interface SyncResult {
  added?: string[];
  modified?: string[];
  removed?: string[];
  /** Files the daemon detected as renames (hash match between a
   *  deleted and an added path). These bypass the embedding pipeline
   *  entirely — cached vectors get re-stamped under the new source. */
  renamed?: string[];
  failed?: { name: string; error: string }[];
  cancelled?: boolean;
  error?: string;
}

export interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

export interface AgentContextFile {
  path: string;
  folder: string;
  sourcePath: string;
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

export interface SearchHit {
  fileName: string;
  chunkIndex: number;
  content: string;
  heading: string;
  startLine?: number;
  endLine?: number;
  pdfPage?: number;
  score: number;
}

export interface KeywordMatch {
  line: number;
  text: string;
  ranges: Array<[number, number]>;
  pdfPage?: number;
}

export interface KeywordHitFile {
  path: string;
  matches: KeywordMatch[];
  totalMatches: number;
}

export interface KeywordSearchResult {
  query: string;
  folder: string;
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

/** V1 is OpenAI-only — no embedder switching. */
export type EmbedderProvider = 'openai';

export interface EmbedderState {
  provider: EmbedderProvider;
  hasKey: boolean;
}


export interface Agent {
  id: string;
  label: string;
  vendor: string;
  installHint: string;
  installed: boolean;
  /** Full shell command the panel feeds to the shell once it's ready
   *  (e.g. `claude --theme light`). Built by the server from the agent
   *  registry so the renderer doesn't have to track per-agent flags. */
  launchCommand: string;
}

export interface AgentsResponse {
  clis: Agent[];
}

/** Extract a printable message from any thrown value. ApiError wins
 *  first because its `.message` already includes the HTTP context. Use
 *  in `catch (err: unknown)` blocks so the renderer doesn't have to
 *  fall back to `any`. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const WINDOW_ID_KEY = 'stashbase.windowId';

export function getWindowId(): string {
  try {
    let id = window.sessionStorage.getItem(WINDOW_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(WINDOW_ID_KEY, id);
    }
    return id;
  } catch {
    return 'web';
  }
}

function requestHeaders(extra?: HeadersInit): HeadersInit {
  return { ...(extra ?? {}), 'x-stashbase-window-id': getWindowId() };
}

/** GET wrapper. Throws `ApiError` for non-2xx; returns parsed JSON. */
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: requestHeaders() });
  return parseJsonOrThrow<T>(r);
}

async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: requestHeaders() };
  if (body !== undefined) {
    init.headers = requestHeaders(JSON_HEADERS);
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  return parseJsonOrThrow<T>(r);
}

function isNetworkFetchError(err: unknown): boolean {
  return err instanceof TypeError && /fetch/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithNetworkRetry<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
): Promise<T> {
  const delays = [250, 750];
  for (let attempt = 0; ; attempt++) {
    try {
      return await send<T>(method, path, body);
    } catch (err: unknown) {
      if (!isNetworkFetchError(err) || attempt >= delays.length) {
        if (isNetworkFetchError(err)) {
          throw new ApiError('Could not reach the local StashBase server. Please try again.', 0, 'NETWORK_ERROR');
        }
        throw err;
      }
      await sleep(delays[attempt]);
    }
  }
}

async function head(path: string): Promise<void> {
  const r = await fetch(path, { method: 'HEAD', headers: requestHeaders() });
  if (!r.ok) {
    const msg = r.status === 404 ? 'not found'
      : r.status === 415 ? 'unsupported format'
        : `HTTP ${r.status}`;
    throw new ApiError(msg, r.status);
  }
}

async function parseJsonOrThrow<T>(r: Response): Promise<T> {
  // Most error routes return `{ error: '…' }` so we surface that
  // message; raw status fallback covers the rest.
  let payload: unknown;
  try { payload = await r.json(); } catch { payload = null; }
  if (!r.ok) {
    const msg = (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as any).error === 'string')
      ? (payload as any).error as string
      : `HTTP ${r.status}`;
    const code = payload && typeof payload === 'object' && typeof (payload as any).code === 'string'
      ? (payload as any).code as string
      : undefined;
    throw new ApiError(msg, r.status, code);
  }
  if (payload && typeof payload === 'object' && 'error' in payload && (payload as any).error) {
    const code = typeof (payload as any).code === 'string' ? (payload as any).code as string : undefined;
    throw new ApiError((payload as any).error as string, r.status, code);
  }
  return payload as T;
}

/** Encode each path segment but keep the `/` separators — what the
 *  server's `/api/files/*` and `/asset/*` routes expect. */
export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export const api = {
  // Folder ---------------------------------------------------------
  getFolder: () => getJson<FolderState>('/api/folder'),
  openFolder: (path: string) => sendWithNetworkRetry<FolderState>('POST', '/api/folder', { path }),
  /** Open a direct child of the default StashBase home by name. Kept for
   *  switch / rename flows that operate on known default-home folders. */
  openFolderByName: (name: string, opts?: { create?: boolean; exclusiveCreate?: boolean }) =>
    send<FolderState>('POST', '/api/folder', {
      name,
      create: opts?.create,
      exclusiveCreate: opts?.exclusiveCreate,
    }),
  closeFolder: () => send<{ ok: boolean }>('DELETE', '/api/folder'),
  /** Absolute path of the default folder home. New Folder opens the native
   *  picker here, but users can still open any folder on disk. */
  getFolderHome: () => getJson<{ path: string }>('/api/folder-home'),
  /** Remove a folder from the library ("Your Folders"): forgets it
   *  (unbind + clear index + drop from membership) WITHOUT touching the
   *  folder on disk. */
  removeFolder: (path: string) =>
    send<Record<string, never>>('POST', '/api/folders/remove', { path }),
  /** Manual sidebar ordering — full map of `parentPath → child basenames`. */
  getFileOrder: () => getJson<Record<string, string[]>>('/api/file-order'),
  /** Update one folder's ordered list. `parentPath` `""` = folder root. */
  putFileOrder: (parentPath: string, names: string[]) =>
    send<Record<string, never>>('PUT', '/api/file-order', { parentPath, names }),

  // Files / folders listing --------------------------------------
  listFiles: () => getJson<FilesPayload>('/api/files'),
  statFile: (name: string) => head('/api/files/' + encodePath(name)),

  // CRUD ---------------------------------------------------------
  createNote: (content: string, dir: string) =>
    send<{ name: string; content: string; version?: string; indexWarning?: string }>('POST', '/api/files', { content, dir }),
  createFolder: (path: string) =>
    send<{ path: string }>('POST', '/api/folders', { path }),
  deleteFile: (name: string) =>
    send<{ alreadyGone?: boolean }>('DELETE', '/api/files/' + encodePath(name)),
  /** Ask the server to reveal the file in the host OS file manager
   *  (Finder / Explorer / xdg-open on the file's directory). */
  revealFile: (name: string) =>
    send<Record<string, never>>('POST', '/api/reveal/' + encodePath(name)),
  deleteFolder: (path: string) =>
    send<{ alreadyGone?: boolean }>('DELETE', '/api/folders/' + encodePath(path)),
  renameFile: (name: string, newName: string, opts: { cascade?: boolean; asyncIndex?: boolean } = {}) =>
    send<{ name: string; linksUpdated?: number; indexDeferred?: boolean; indexWarning?: string }>(
      'PATCH',
      '/api/files/' + encodePath(name),
      { new_name: newName, cascade: opts.cascade ?? true, async_index: opts.asyncIndex === true },
    ),
  renameFolder: (path: string, newName: string, opts: { cascade?: boolean } = {}) =>
    send<{ path: string }>(
      'PATCH',
      '/api/folders/' + encodePath(path),
      { new_name: newName, cascade: opts.cascade ?? true },
    ),
  /** Dry-run cross-reference count for an intended rename — powers
   *  the confirmation dialog. Returns `{ files, links }`; both 0 means
   *  the rename is safe to commit without prompting. */
  renamePreview: (kind: 'file' | 'folder', oldPath: string, newPath: string) =>
    send<{ files: number; links: number }>('POST', '/api/rename-preview', {
      kind,
      old: oldPath,
      new: newPath,
    }),

  // File body ----------------------------------------------------
  getFile: (name: string) => getJson<FileBody>('/api/files/' + encodePath(name)),
  putFile: (name: string, content: string, baseVersion?: string) =>
    send<{ indexWarning?: string; version?: string }>(
      'PUT',
      '/api/files/' + encodePath(name),
      { content, ...(baseVersion !== undefined ? { baseVersion } : {}) },
    ),

  // Upload (FormData) -------------------------------------------
  upload: async (
    items: { file: File; relPath: string }[],
    dir = '',
    folder?: string,
  ): Promise<UploadResult> => {
    const fd = new FormData();
    for (const it of items) {
      fd.append('files', it.file);
      fd.append('paths', it.relPath);
    }
    if (dir) fd.append('dir', dir);
    if (folder) fd.append('folder', folder);
    const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow<UploadResult>(r);
  },

  /** Attach files as transient chat context — written to a throwaway OS
   *  temp dir (NOT the folder) and returned as absolute paths the agent
   *  reads. Used by the composer `+` and panel drag-drop. */
  attachFiles: async (
    files: File[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ files: { name: string; path?: string; error?: string }[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const r = await fetch('/api/agent/attach', { method: 'POST', body: fd, headers: requestHeaders(), signal: opts.signal });
    return parseJsonOrThrow(r);
  },
  agentContextFile: (folder: string, path: string) =>
    getJson<AgentContextFile>(
      '/api/library/agent-context-file?path=' + encodeURIComponent(`${folder}/${path}`),
    ),

  // Sync / search / status --------------------------------------
  sync: (folder?: string) => send<SyncResult>(
    'POST',
    folder ? `/api/sync?folder=${encodeURIComponent(folder)}` : '/api/sync',
  ),
  search: (query: string, top_k = 8, opts?: { folder?: string }) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', { query, top_k, folder: opts?.folder }),
  keywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; folder?: string }) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.caseStrict) qs.set('case_strict', '1');
    if (opts?.wholeWord) qs.set('whole_word', '1');
    // Pass the active window's folder explicitly so multi-window
    // sessions don't fall back to the server's single `currentFolder`
    // singleton and search the wrong folder's tree.
    if (opts?.folder) qs.set('folder', opts.folder);
    return getJson<KeywordSearchResult>(`/api/keyword-search?${qs.toString()}`);
  },
  indexStatus: (folder?: string) =>
    getJson<IndexStatus>(folder ? `/api/index-status?folder=${encodeURIComponent(folder)}` : '/api/index-status'),
  dismissIndexWarning: (folder?: string) =>
    send<{ ok: boolean }>('POST', '/api/index-warning/dismiss', { folder }),

  /** Full per-file preparation status, library-wide, keyed by absolute
   *  source path. */
  pdfStatus: () =>
    getJson<{ entries: Record<string, PdfStatusEntry> }>('/api/pdf/status'),
  /** Reprocess a specific source file (folder-relative path). PDF/image
   *  sources re-run extraction; directly readable files clear the
   *  failure row and trigger reconcile/index. */
  reprocessFile: (path: string, opts?: { folder?: string }) =>
    send<{ ok: boolean; mode?: 'conversion' | 'index' }>('POST', '/api/files/reprocess', { path, folder: opts?.folder }),
  // Embedder ----------------------------------------------------
  getEmbedder: () => getJson<EmbedderState>('/api/embedder'),

  // Agents (chat-panel CLIs) -----------------------------------
  // Server routes stay under `/api/terminal/*` for historical reasons;
  // the renderer just calls them "agents". `listAgents` populates the
  // launcher registry / installed-state.
  listAgents: () => getJson<AgentsResponse>('/api/terminal/clis'),
  mcpStatus: () =>
    getJson<{
      clients: Record<string, boolean | { configured?: boolean; cliInstalled?: boolean; restartRequired?: boolean }>;
      command: string;
      config: unknown;
    }>('/api/mcp/status'),
  // `send` throws ApiError on any non-2xx, so a resolved value is always
  // the success shape — no `error` field, `ok` is always true.
  configureMcp: (client: string) =>
    send<{
      ok: true;
      client?: string;
      file?: string;
      command?: string;
      manual?: unknown;
      mode?: 'file' | 'clipboard';
    }>('POST', '/api/mcp/configure', { client }),
  disconnectMcp: (client: string) =>
    send<{
      ok: true;
      client?: string;
      file?: string;
      mode?: 'file' | 'clipboard';
    }>('POST', '/api/mcp/disconnect', { client }),
  /** Rotate the global OpenAI key without touching the provider choice. */
  changeApiKey: (openaiKey: string) =>
    send<ApiKeySaveResult>('PUT', '/api/embedder/key', { openaiKey }),
  /** Clear the global OpenAI key. Embedding and semantic search stay
   *  disabled until a key is added back; keyword search is unaffected. */
  removeApiKey: () =>
    send<{ hasKey: false }>('DELETE', '/api/embedder/key'),

  // Agent sessions (chat-panel History dropdown) ----------------
  /** All local agent sessions for the current folder, newest first. */
  listSessions: (agent: 'claude' | 'codex' = 'claude') =>
    getJson<SessionInfo[]>(agentSessionBase(agent)),
  /** A session's transcript as renderable blocks (for resume replay). */
  getSessionMessages: (id: string, agent: 'claude' | 'codex' = 'claude') =>
    getJson<SessionBlock[]>(agentSessionBase(agent) + '/' + encodeURIComponent(id) + '/messages'),
  renameSession: (id: string, title: string, agent: 'claude' | 'codex' = 'claude') =>
    send<SessionInfo>('PATCH', agentSessionBase(agent) + '/' + encodeURIComponent(id), { title }),
  deleteSession: (id: string, agent: 'claude' | 'codex' = 'claude') =>
    send<Record<string, never>>('DELETE', agentSessionBase(agent) + '/' + encodeURIComponent(id)),
};

function agentSessionBase(agent: 'claude' | 'codex'): string {
  return agent === 'codex' ? '/api/codex/sessions' : '/api/agent/sessions';
}

/** Asset URL for HTML files (used by the preview iframe so relative
 *  references inside the page — `<img src="X_files/figure.png">` —
 *  resolve correctly). Caller passes a folder-relative path.
 *
 *  The reserved `__window/<id>/` path prefix mirrors the
 *  `x-stashbase-window-id` header that fetch-based calls carry — the
 *  browser can't add a custom header to `<img src>` or iframe loads.
 *  Without it, images would resolve against the default window's folder
 *  in a multi-window session. */
export function assetUrl(name: string): string {
  return assetWindowPrefix() + encodePath(name);
}

export function versionedAssetUrl(name: string, version: string): string {
  const url = assetUrl(name);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

export function derivedAssetUrl(name: string): string {
  return assetWindowPrefix('/asset-derived/') + encodePath(name);
}

export function versionedDerivedAssetUrl(name: string, version: string): string {
  const url = derivedAssetUrl(name);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

/** Base URL for live HTML edit previews. The preview itself is a blob,
 *  but relative image/css/font URLs should still resolve next to the
 *  saved file in the current folder.
 *
 *  The window id lives in the path instead of a query string because
 *  `<base href="?windowId=…">` does not propagate that query to relative
 *  `<img>`, CSS, or font URLs. The server strips the reserved prefix
 *  before resolving the actual folder-relative asset path. */
export function assetBaseUrl(name: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return assetWindowPrefix() + (dir ? encodePath(dir) + '/' : '');
}

function assetWindowPrefix(base = '/asset/'): string {
  return base + '__window/' + encodeURIComponent(getWindowId()) + '/';
}
