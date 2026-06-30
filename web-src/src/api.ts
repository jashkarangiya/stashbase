/**
 * Typed fetch wrappers for every `/api/*` endpoint the server exposes
 * (see `server/index.ts`). Throws `ApiError` on non-2xx so callers can
 * `try/catch` once at the action layer.
 *
 * Paths are always space-relative POSIX (`topic/note.md`). The server
 * url-encodes them for us inside route patterns; the client must do the
 * same for path segments embedded into the URL.
 */

/** Viewer format the renderer uses for tab routing. `md` / `html` are
 *  indexed note formats (text loaded from `/api/files/*`); `pdf` and
 *  `image` are binary-only viewers (rendered straight from `/asset/*`
 *  — PDF.js for pdf, a plain `<img>` for image). The server's
 *  `detectFormat()` still excludes both because the binaries aren't
 *  indexed (their hidden derived `.md` notes are) — this type is wider
 *  than the server's on purpose. */
export type FileFormat = 'md' | 'html' | 'pdf' | 'image';

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

export interface SpaceState {
  current: { path: string; name: string } | null;
  recent: { path: string; openedAt: string }[];
  homeDir?: string;
}

export interface SpaceConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

export type ImportFolderMode = 'copy' | 'move';

export interface FolderImportPreview {
  source: string;
  name: string;
  destination: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  requiresConfirmation: boolean;
  requiresLargeImportConfirmation: boolean;
  largeImportReason?: string;
  warnings: string[];
  hasSnapshot: boolean;
  /** A space with this name already exists — Import refuses (won't merge);
   *  the modal surfaces it and disables the import button. */
  nameTaken: boolean;
}

export interface FolderImportResult {
  path: string;
  name: string;
  mode: ImportFolderMode;
  /** Present only when a `move` import copied successfully but the
   *  original folder could not be fully deleted; the new space is intact
   *  and the original needs manual cleanup. */
  warning?: string;
}

export interface FilesPayload {
  files: FileMeta[];
  folders: FolderMeta[];
  space: string;
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
  space?: string;
  total: number;
  indexed: number;
  pendingCount: number;
  pending: string[];
  orphanedCount: number;
  orphaned: string[];
  upToDate: boolean;
  /** True when no UI-visible file is waiting for embedding. Unlike
   *  upToDate, this ignores orphaned/hidden index rows that are not
   *  rendered as "stashing" work in the file tree. */
  visibleIndexingSettled?: boolean;
  /** False while the server is still loading the index cache for a space. */
  indexReady?: boolean;
  /** Space-relative paths of PDFs the server is currently converting
   *  into a readable note + bundle. Empty when no conversions are in
   *  flight. Used by the sidebar to render a transient indicator. */
  pendingConversions?: string[];
  /** Space-relative conversion progress keyed by visible source path.
   *  Used by PDF preview banners for "Reading page X" / indexing copy. */
  conversionProgress?: Record<string, ConversionProgress>;
  /** Persistent failure list — PDFs (pdf_extract) and images
   *  (ocr_extract) whose most recent conversion attempt errored.
   *  Survives app restart (read back from `<KB>/.stashbase/state.db`).
   *  Empty when no failures. Drives the per-file Retry banner in
   *  PdfPreview / ImagePreview and the context-menu Retry entry. */
  conversionFailures?: ConversionFailure[];
  /** Monotonic counter the server bumps on every external fs event
   *  (after self-write filtering). Renderer compares against its
   *  last-seen value and triggers `/api/files` on any change — picks
   *  up writes from the chat panel (Claude Code, `touch`, …) even
   *  for non-indexable files / empty dirs that don't move `pending`. */
  treeVersion?: number;
  /** Non-null when this space's most recent snapshot import skipped
   *  chunks because their provider key didn't match the knowledge base's
   *  current embedder. The renderer surfaces this as a dismissible
   *  banner with a link to switch embedders. */
  snapshotWarning?: SnapshotWarning | null;
  /** Non-null when the active space's background index sync failed after
   *  opening/importing. Cleared by a successful manual/background sync or
   *  user dismissal. */
  indexWarning?: IndexWarning | null;
}

export type ConversionProgress =
  | { phase: 'extracting'; currentPage?: number }
  | { phase: 'indexing' };

export interface SnapshotWarning {
  skipped: number;
  details: { provider: string; chunks: number }[];
  at: string;
}

export interface IndexWarning {
  message: string;
  at: string;
}

/** Persistent conversion failure record (PDF or image — subset of the
 *  on-disk entry, with timestamps the UI doesn't need stripped). */
export interface ConversionFailure {
  path: string;
  lastError: string;
  attempts: number;
}

/** Full PDF status entries returned by `GET /api/pdf/status`. Keyed by
 *  KB-relative path. PdfPreview uses this to pick out the entry for
 *  the file it's rendering and decide whether to show the failure
 *  banner. */
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
  space: string;
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
  space: string;
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
  // Space ---------------------------------------------------------
  getSpace: () => getJson<SpaceState>('/api/space'),
  openSpace: (path: string) => send<SpaceState>('POST', '/api/space', { path }),
  /** Open a space by name (single segment under the KB root).
   *  Preferred over `openSpace(path)` for new flows now that spaces
   *  are flat. `create:true` makes the server mkdir a missing folder;
   *  `exclusiveCreate:true` makes existing spaces a 409 conflict. Without
   *  create, opening a non-existent name errors
   *  rather than resurrecting a since-deleted space as an empty dir. */
  openSpaceByName: (name: string, opts?: { create?: boolean; exclusiveCreate?: boolean }) =>
    send<SpaceState>('POST', '/api/space', {
      name,
      create: opts?.create,
      exclusiveCreate: opts?.exclusiveCreate,
    }),
  closeSpace: () => send<{ ok: boolean }>('DELETE', '/api/space'),
  /** Absolute path of the KB root. All spaces live under it as direct
   *  children; the renderer uses this to display the home-relative
   *  form (`~/Documents/StashBase`) in copy. */
  getKbRoot: () => getJson<{ path: string; needsPicker?: boolean }>('/api/kb-root'),
  /** Pre-flight for the "move my spaces over" flow when changing the KB
   *  root: which spaces would move and which collide with same-named
   *  spaces already in the target. */
  kbRootMigrationPreview: (target: string) =>
    getJson<{ spaces: string[]; collisions: string[]; sameRoot: boolean }>(
      '/api/kb-root/migration-preview?target=' + encodeURIComponent(target),
    ),
  setKbRoot: (
    path: string,
    opts: {
      confirmNonEmpty?: boolean;
      migrate?: { name: string; action: 'move' | 'overwrite' | 'rename' }[];
    } = {},
  ) =>
    send<{ path: string; warnings?: string[] }>('PUT', '/api/kb-root', {
      path,
      confirmNonEmpty: opts.confirmNonEmpty ?? false,
      migrate: opts.migrate,
    }),
  /** Direct-child directory names under kbRoot — every entry is a
   *  candidate the server will accept as a space name. Powers the
   *  "Open space" dropdown. */
  listAvailableSpaces: () => getJson<{ names: string[] }>('/api/spaces/available'),
  renameSpace: (name: string, nextName: string) =>
    send<{ name: string; path: string }>('PATCH', '/api/spaces/' + encodeURIComponent(name), { name: nextName }),
  deleteSpace: (name: string) =>
    send<Record<string, never>>('DELETE', '/api/spaces/' + encodeURIComponent(name)),
  getSpaceConfig: (name: string) =>
    getJson<{ path: string; local: SpaceConfig; resolved: Required<SpaceConfig> }>(
      '/api/spaces/' + encodeURIComponent(name) + '/config',
    ),
  putSpaceConfig: (name: string, config: SpaceConfig) =>
    send<{ path: string; local: SpaceConfig; resolved: Required<SpaceConfig> }>(
      'PUT',
      '/api/spaces/' + encodeURIComponent(name) + '/config',
      config,
    ),
  /** Read `<kbRoot>/STASHBASE.md` — the KB-level rules book. Powers the
   *  Knowledge base section's "STASHBASE.md" row. */
  getKbRules: () => getJson<{ content: string; version?: string }>('/api/kb/rules'),
  putKbRules: (content: string, baseVersion?: string) =>
    send<{ ok: true; version?: string }>(
      'POST',
      '/api/kb/rules',
      { content, ...(baseVersion !== undefined ? { baseVersion } : {}) },
    ),
  /** Copy a local folder into kbRoot as a new space. `source` is an
   *  absolute path; the renderer obtains it from
   *  `window.electron.openFolderDialog` (Electron-only). `name`
   *  defaults to the basename of `source` server-side. */
  previewImportFolder: (source: string, name = '') =>
    send<FolderImportPreview>('POST', '/api/space/import-folder/preview', { source, name }),
  importFolder: (
    source: string,
    opts: {
      name?: string;
      mode?: ImportFolderMode;
      confirmExisting?: boolean;
      confirmLargeImport?: boolean;
    } = {},
  ) =>
    send<FolderImportResult>('POST', '/api/space/import-folder', {
      source,
      name: opts.name ?? '',
      mode: opts.mode ?? 'copy',
      confirmExisting: opts.confirmExisting === true,
      confirmLargeImport: opts.confirmLargeImport === true,
    }),
  /** Manual sidebar ordering — full map of `parentPath → child basenames`. */
  getFileOrder: () => getJson<Record<string, string[]>>('/api/file-order'),
  /** Update one folder's ordered list. `parentPath` `""` = space root. */
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
    space?: string,
  ): Promise<UploadResult> => {
    const fd = new FormData();
    for (const it of items) {
      fd.append('files', it.file);
      fd.append('paths', it.relPath);
    }
    if (dir) fd.append('dir', dir);
    if (space) fd.append('space', space);
    const r = await fetch('/api/upload', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow<UploadResult>(r);
  },

  /** Ingest a screen recording: the webm is saved into the note's
   *  `<stem>_files/` bundle, then Gemini writes/updates a visible
   *  `recording-<ts>.md` note in the background. */
  recordVideo: async (
    file: File,
    dir = '',
    space?: string,
  ): Promise<{ ok?: boolean; file?: string; error?: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    if (dir) fd.append('dir', dir);
    if (space) fd.append('space', space);
    const r = await fetch('/api/recording', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow(r);
  },

  /** Attach files as transient chat context — written to a throwaway OS
   *  temp dir (NOT the space) and returned as absolute paths the agent
   *  reads. Used by the composer `+` and panel drag-drop. */
  attachFiles: async (
    files: File[],
  ): Promise<{ files: { name: string; path?: string; error?: string }[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const r = await fetch('/api/agent/attach', { method: 'POST', body: fd, headers: requestHeaders() });
    return parseJsonOrThrow(r);
  },
  agentContextFile: (space: string, path: string) =>
    getJson<AgentContextFile>(
      '/api/kb/agent-context-file?path=' + encodeURIComponent(`${space}/${path}`),
    ),

  // Sync / search / status --------------------------------------
  sync: (space?: string) => send<SyncResult>(
    'POST',
    space ? `/api/sync?space=${encodeURIComponent(space)}` : '/api/sync',
  ),
  search: (query: string, top_k = 8, opts?: { space?: string }) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', { query, top_k, space: opts?.space }),
  keywordSearch: (query: string, opts?: { caseStrict?: boolean; wholeWord?: boolean; space?: string }) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.caseStrict) qs.set('case_strict', '1');
    if (opts?.wholeWord) qs.set('whole_word', '1');
    // Pass the active window's space explicitly so multi-window
    // sessions don't fall back to the server's single `currentSpace`
    // singleton and search the wrong space's tree.
    if (opts?.space) qs.set('space', opts.space);
    return getJson<KeywordSearchResult>(`/api/keyword-search?${qs.toString()}`);
  },
  indexStatus: (space?: string) =>
    getJson<IndexStatus>(space ? `/api/index-status?space=${encodeURIComponent(space)}` : '/api/index-status'),
  dismissSnapshotWarning: (space?: string) =>
    send<{ ok: boolean }>('POST', '/api/snapshot-warning/dismiss', { space }),
  dismissIndexWarning: (space?: string) =>
    send<{ ok: boolean }>('POST', '/api/index-warning/dismiss', { space }),
  /** Bake the current space's embeddings into a portable
   *  `.stashbase/snapshot.parquet` (+ `snapshot.meta.json`) so copying /
   *  git-cloning the space folder carries the vectors — the other end
   *  reuses them by `text_hash` instead of re-embedding. */
  exportSnapshot: (space?: string) =>
    send<{ vectors: number; chunks: number; embedder: { provider: string; model: string | null; dim: number } }>(
      'POST', '/api/space/export-snapshot', { space },
    ),

  /** Full per-file PDF conversion status, KB-wide, keyed by KB-relative
   *  path. PdfPreview calls this when the active file is a PDF to
   *  decide whether to render the failure banner. */
  pdfStatus: () =>
    getJson<{ entries: Record<string, PdfStatusEntry> }>('/api/pdf/status'),
  /** Retry conversion of a specific PDF or image (space-relative path).
   *  Clears the existing status record, removes the stale derived note
   *  (+ PDF bundle) if present, then re-fires the matching converter
   *  (pdf_extract / ocr_extract) in the background. Client observes the
   *  outcome via the next `/api/index-status` poll. */
  retryConversion: (path: string, opts?: { space?: string }) =>
    send<{ ok: boolean }>('POST', '/api/conversion/retry', { path, space: opts?.space }),

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
  listMcpTools: () =>
    getJson<{ tools: { server: string; name: string; fqName: string; description?: string; inputSchema: unknown }[] }>('/api/mcp/tools'),
  callMcpTool: (name: string, args: Record<string, unknown> = {}) =>
    send<{ result: unknown }>('POST', '/api/mcp/tools/call', { name, arguments: args }),
  // `send` throws ApiError on any non-2xx, so a resolved value is always
  // the success shape — no `error` field, `ok` is always true. (The
  // Electron bridge path in McpClientsPanel models `{ok:false,error}`
  // separately, since it returns failures as a value rather than throwing.)
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

  // Gemini key (for video analysis in the recording pipeline) --------
  getGeminiKey: () => getJson<{ hasKey: boolean }>('/api/gemini/key'),
  setGeminiKey: (geminiKey: string) =>
    send<{ hasKey: true }>('PUT', '/api/gemini/key', { geminiKey }),
  removeGeminiKey: () =>
    send<{ hasKey: false }>('DELETE', '/api/gemini/key'),

  // Agent sessions (chat-panel History dropdown) ----------------
  /** All local agent sessions for the current space, newest first. */
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

/** Set the KB root, transparently handling the "directory is not empty"
 *  guard: the server rejects a populated target with 409 unless
 *  `confirmNonEmpty` is set, so on 409 we ask the user and, if they
 *  agree, retry with the flag. Returns the server result, or `null` when
 *  the user declines the confirmation. Other errors propagate.
 *
 *  Shared by the first-run root picker (Welcome) and Settings → Storage,
 *  which otherwise hand-rolled the same 409 dance. Callers own their own
 *  busy / error UI and what to do with a successful result. */
export async function setKbRootConfirming(
  path: string,
  confirm: (message: string) => Promise<boolean>,
): Promise<{ path: string; warnings?: string[] } | null> {
  try {
    return await api.setKbRoot(path, { confirmNonEmpty: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const ok = await confirm(
        'That directory is not empty. StashBase will treat each direct child folder as a space, ' +
        'and supported files inside opened spaces may be indexed. Use a dedicated StashBase folder unless this is already a knowledge base root. Continue?',
      );
      if (!ok) return null;
      return await api.setKbRoot(path, { confirmNonEmpty: true });
    }
    throw err;
  }
}

/** Asset URL for HTML files (used by the preview iframe so relative
 *  references inside the page — `<img src="X_files/figure.png">` —
 *  resolve correctly). Caller passes a space-relative path.
 *
 *  The reserved `__window/<id>/` path prefix mirrors the
 *  `x-stashbase-window-id` header that fetch-based calls carry — the
 *  browser can't add a custom header to `<img src>` or iframe loads.
 *  Without it, images would resolve against the default window's space
 *  in a multi-window session. */
export function assetUrl(name: string): string {
  return assetWindowPrefix() + encodePath(name);
}

export function versionedAssetUrl(name: string, version: string): string {
  const url = assetUrl(name);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

/** Base URL for live HTML edit previews. The preview itself is a blob,
 *  but relative image/css/font URLs should still resolve next to the
 *  saved file in the current space.
 *
 *  The window id lives in the path instead of a query string because
 *  `<base href="?windowId=…">` does not propagate that query to relative
 *  `<img>`, CSS, or font URLs. The server strips the reserved prefix
 *  before resolving the actual space-relative asset path. */
export function assetBaseUrl(name: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return assetWindowPrefix() + (dir ? encodePath(dir) + '/' : '');
}

function assetWindowPrefix(): string {
  return '/asset/__window/' + encodeURIComponent(getWindowId()) + '/';
}
