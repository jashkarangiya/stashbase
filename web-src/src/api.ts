/**
 * Typed fetch wrappers for every `/api/*` endpoint the server exposes
 * (see `server/index.ts`). Throws `ApiError` on non-2xx so callers can
 * `try/catch` once at the action layer.
 *
 * Paths are always space-relative POSIX (`topic/note.md`). The server
 * url-encodes them for us inside route patterns; the client must do the
 * same for path segments embedded into the URL.
 */

export type FileFormat = 'md' | 'html';

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

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface SpaceState {
  current: string | null;
  recent: { path: string; openedAt: string }[];
  homeDir?: string;
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
  headings?: Heading[];
}

export interface IndexStatus {
  total: number;
  indexed: number;
  pendingCount: number;
  pending: string[];
  orphanedCount: number;
  orphaned: string[];
  upToDate: boolean;
  /** False while the server is still loading the index cache for a space. */
  indexReady?: boolean;
  /** Space-relative paths of PDFs the server is currently converting
   *  into a readable note + bundle. Empty when no conversions are in
   *  flight. Used by the sidebar to render a transient indicator. */
  pendingConversions?: string[];
  /** Monotonic counter the server bumps on every external fs event
   *  (after self-write filtering). Renderer compares against its
   *  last-seen value and triggers `/api/files` on any change — picks
   *  up writes from the terminal panel (Claude Code, `touch`, …) even
   *  for non-indexable files / empty dirs that don't move `pending`. */
  treeVersion?: number;
}

export interface SyncResult {
  added?: string[];
  modified?: string[];
  removed?: string[];
  error?: string;
}

export interface UploadResultEntry {
  file: string;
  error?: string;
}

export interface UploadResult {
  files: UploadResultEntry[];
}

export interface SearchHit {
  fileName: string;
  chunkIndex: number;
  content: string;
  heading: string;
  startLine?: number;
  endLine?: number;
  score: number;
}

export type EmbedderProvider = 'onnx' | 'openai';

export interface EmbedderState {
  provider: EmbedderProvider;
  hasKey: boolean;
}

export interface EmbedderCostEstimate {
  provider: string;
  files: number;
  bytes: number;
  tokens: number;
  /** USD, computed at the server. May be 0 for non-API providers. */
  costUsd: number;
}


export interface TerminalCli {
  id: string;
  label: string;
  vendor: string;
  installHint: string;
  installed: boolean;
  /** Full shell command the panel feeds to the shell once it's ready
   *  (e.g. `claude --theme light`). Built by the server from the CLI
   *  registry so the renderer doesn't have to track per-CLI flags. */
  launchCommand: string;
}

export interface TerminalClisResponse {
  current: string;
  clis: TerminalCli[];
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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** GET wrapper. Throws `ApiError` for non-2xx; returns parsed JSON. */
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  return parseJsonOrThrow<T>(r);
}

async function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  return parseJsonOrThrow<T>(r);
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
    throw new ApiError(msg, r.status);
  }
  if (payload && typeof payload === 'object' && 'error' in payload && (payload as any).error) {
    throw new ApiError((payload as any).error as string, r.status);
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
  /** Run `git clone <url>` into `parentDir`, returning the absolute
   *  path of the freshly-cloned working tree. Caller follows up with
   *  `openSpace(path)`. */
  gitClone: (url: string, parentDir: string) =>
    send<{ path: string }>('POST', '/api/git/clone', { url, parentDir }),
  /** Mirror this space's `skills/<name>/SKILL.md` into the active
   *  CLI's per-project prompt dir (`.claude/commands` / `.codex/prompts`).
   *  Renderer fires this on terminal panel open / CLI switch. */
  syncSkills: (cli: 'claude' | 'codex') =>
    send<{ synced: string[]; skipped: string[] }>(
      'POST',
      '/api/skills/sync',
      { cli },
    ),
  /** Manual sidebar ordering — full map of `parentPath → child basenames`. */
  getFileOrder: () => getJson<Record<string, string[]>>('/api/file-order'),
  /** Update one folder's ordered list. `parentPath` `""` = space root. */
  putFileOrder: (parentPath: string, names: string[]) =>
    send<Record<string, never>>('PUT', '/api/file-order', { parentPath, names }),

  // Files / folders listing --------------------------------------
  listFiles: () => getJson<FilesPayload>('/api/files'),

  // CRUD ---------------------------------------------------------
  createNote: (content: string, dir: string, format: FileFormat = 'md') =>
    send<{ name: string }>('POST', '/api/files', { content, dir, format }),
  createFolder: (path: string) =>
    send<{ path: string }>('POST', '/api/folders', { path }),
  deleteFile: (name: string) =>
    send<Record<string, never>>('DELETE', '/api/files/' + encodePath(name)),
  /** Ask the server to reveal the file in the host OS file manager
   *  (Finder / Explorer / xdg-open on the file's directory). */
  revealFile: (name: string) =>
    send<Record<string, never>>('POST', '/api/reveal/' + encodePath(name)),
  deleteFolder: (path: string) =>
    send<Record<string, never>>('DELETE', '/api/folders/' + encodePath(path)),
  renameFile: (name: string, newName: string, opts: { cascade?: boolean } = {}) =>
    send<{ name: string; linksUpdated?: number }>(
      'PATCH',
      '/api/files/' + encodePath(name),
      { new_name: newName, cascade: opts.cascade ?? true },
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
  putFile: (name: string, content: string) =>
    send<Record<string, never>>('PUT', '/api/files/' + encodePath(name), { content }),

  // Upload (FormData) -------------------------------------------
  upload: async (
    items: { file: File; relPath: string }[],
    dir = '',
  ): Promise<UploadResult> => {
    const fd = new FormData();
    for (const it of items) {
      fd.append('files', it.file);
      fd.append('paths', it.relPath);
    }
    if (dir) fd.append('dir', dir);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    return parseJsonOrThrow<UploadResult>(r);
  },

  // Sync / search / status --------------------------------------
  sync: () => send<SyncResult>('POST', '/api/sync'),
  search: (query: string, top_k = 8) =>
    send<{ hits: SearchHit[] }>('POST', '/api/search', { query, top_k }),
  indexStatus: () => getJson<IndexStatus>('/api/index-status'),

  // Embedder ----------------------------------------------------
  getEmbedder: () => getJson<EmbedderState>('/api/embedder'),
  setEmbedder: (provider: EmbedderProvider, openaiKey?: string) =>
    send<EmbedderState>('PUT', '/api/embedder', { provider, openaiKey }),
  /** Validate without saving. Used before storing a fresh OpenAI key
   *  so a bad key never lands in `~/.stashbase/config.json`. Throws
   *  `ApiError` on invalid; resolves on valid. */
  validateEmbedder: (provider: EmbedderProvider, openaiKey?: string) =>
    send<Record<string, never>>('POST', '/api/embedder/validate', { provider, openaiKey }),
  embedderCostEstimate: (provider: EmbedderProvider) =>
    getJson<EmbedderCostEstimate>('/api/embedder/cost-estimate?provider=' + encodeURIComponent(provider)),

  // Terminal CLIs ----------------------------------------------
  listClis: () => getJson<TerminalClisResponse>('/api/terminal/clis'),
  setCli: (id: string) =>
    send<{ current: string }>('PUT', '/api/terminal/cli', { id }),
  checkCli: (id: string) =>
    getJson<{ installed: boolean }>('/api/terminal/check/' + encodeURIComponent(id)),
  /** Rotate the global OpenAI key without touching per-space providers. */
  changeApiKey: (openaiKey: string) =>
    send<{ hasKey: true }>('PUT', '/api/embedder/key', { openaiKey }),
  /** Clear the global OpenAI key. Spaces configured as openai keep
   *  their per-space config but will fail to embed until a key is
   *  added back. */
  removeApiKey: () =>
    send<{ hasKey: false }>('DELETE', '/api/embedder/key'),
};

/** Asset URL for HTML files (used by the preview iframe so relative
 *  references inside the page — `<img src="X_files/figure.png">` —
 *  resolve correctly). Caller passes a space-relative path. */
export function assetUrl(name: string): string {
  return '/asset/' + encodePath(name);
}

/** Base URL for live HTML edit previews. The preview itself is a blob,
 *  but relative image/css/font URLs should still resolve next to the
 *  saved file in the current space. */
export function assetBaseUrl(name: string): string {
  const parts = name.split('/');
  parts.pop();
  const dir = parts.join('/');
  return '/asset/' + (dir ? encodePath(dir) + '/' : '');
}
