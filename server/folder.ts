/**
 * Folder registry, window context, and folder-home management.
 *
 * Persistence reuses `app-config.ts`'s `~/.stashbase/config.json`
 * primitives for library membership; credentials and user preferences
 * (API keys, terminal CLI) live in app-config.ts entirely.
 *
 * The currently-open folder is in-memory only — server restart goes
 * back to the welcome screen. Other modules subscribe to switches via
 * `onSwitch()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { logger, errorMessage } from './log.ts';
import { copyDirectoryDereferenced } from './fs-move.ts';
import { isIndexExcludedDirName } from './indexable.ts';
import {
  readAppConfig as readConfig,
  writeAppConfig as writeConfig,
  type RecentFolder,
} from './app-config.ts';

// Type re-exports so existing `from './folder.ts'` type imports keep
// working; the values live in app-config.ts.
export type { EmbedderProvider, RecentFolder } from './app-config.ts';

const log = logger('folder');

const MAX_RECENT = 50;

export const WINDOW_ID_HEADER = 'x-stashbase-window-id';

/** Folder name of the bundled product manual, seeded into the default
 *  folder home on first launch so the user never faces an empty app. Doubles as
 *  the disk directory name and the Welcome-screen recents label. */
const BUILTIN_FOLDER_NAME = '👋 Start Here';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where bundled assets live. Packaged: `extraResources` under
 *  `process.resourcesPath` (injected via `STASHBASE_RESOURCES_PATH`).
 *  Dev: the project root. Mirrors `mfs-daemon.ts`'s resolution. */
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : process.env.STASHBASE_APP_ROOT
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(__dirname, '..');

const DEFAULT_WINDOW_ID = 'default';
const requestWindow = new AsyncLocalStorage<string>();
const currentFolders = new Map<string, string>();
const switchListeners: Array<(newRoot: string, windowId: string) => void> = [];
const closeListeners: Array<(oldRoot: string, windowId: string) => void> = [];

export function runWithWindowId<T>(windowId: string | null | undefined, fn: () => T): T {
  return requestWindow.run(normalizeWindowId(windowId), fn);
}

/** Run a backend operation against an arbitrary **absolute** folder root
 *  (a member of "Your Folders", which can live anywhere on disk), without
 *  changing any user window. The MCP file layer uses this so its host-side
 *  file ops resolve against the right member folder — the filesystem layer
 *  (`files.ts`) is already rooted at `getCurrentFolder()`, so setting the
 *  window's current folder to `absRoot` is all that's needed. */
export async function runWithFolderRoot<T>(
  absRoot: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const root = resolveFolderRoot(absRoot);
  return runWithWindowId(`__folder:${root}`, async () => {
    const windowId = currentWindowId();
    const hadPrev = currentFolders.has(windowId);
    const prev = currentFolders.get(windowId);
    currentFolders.set(windowId, root);
    try {
      return await fn();
    } finally {
      if (hadPrev && prev) currentFolders.set(windowId, prev);
      else currentFolders.delete(windowId);
    }
  });
}

export function currentWindowId(): string {
  return requestWindow.getStore() ?? DEFAULT_WINDOW_ID;
}

/** Absolute POSIX roots of every member folder ("Your Folders"). The MCP
 *  layer scopes file/search ops to these — a path must live under one. */
export function memberFolderRoots(): string[] {
  return getRecentFolders().map((r) => toPosixAbs(r.path));
}

/** The member folder (longest-prefix) that contains `abs`, or null when
 *  the path isn't inside any member folder. The longest-prefix rule keeps
 *  nested members (`<root>/foo` and `<root>/foo/bar` both opened) correct. */
export function memberRootForAbs(abs: string): string | null {
  const target = toPosixAbs(abs);
  let best: string | null = null;
  for (const root of memberFolderRoots()) {
    if (target === root || target.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

/** Resolve a folder reference to its absolute POSIX root, validating it is a
 *  real directory. Absolute paths are the normal API. A non-absolute ref is
 *  accepted only as a compatibility path under the default folder home.
 *  Throws with `code = FOLDER_NOT_FOUND` otherwise. */
export function resolveFolderRoot(ref: string): string {
  if (typeof ref !== 'string' || !ref.trim()) {
    const err = new Error('folder reference required');
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  const abs = path.isAbsolute(ref) ? ref : path.join(getFolderHome(), ref);
  const root = toPosixAbs(abs);
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    /* fall through to the not-found error */
  }
  const err = new Error('folder not found');
  (err as any).code = 'FOLDER_NOT_FOUND';
  throw err;
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : DEFAULT_WINDOW_ID;
}

// ---------- Default folder home ----------

/** Absolute path of the **default folder home** — the fixed directory where
 *  "new folder by name" is created and the built-in manual is seeded. It is
 *  NOT a configurable root, an isolation boundary, or an index scope: the
 *  daemon keys one global collection by absolute path, and folders are
 *  opened in place from anywhere on disk. There is no UI to change it.
 *  `STASHBASE_FOLDER_HOME` overrides it for tests / power users. */
export function getFolderHome(): string {
  const env = process.env.STASHBASE_FOLDER_HOME;
  if (typeof env === 'string' && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), 'Documents', 'StashBase');
}

/** True if `absPath` lives anywhere inside the folder home (any depth); the
 *  folderHome itself doesn't qualify (it's the container, not "inside" it).
 *  Used when validating absolute paths against the default folder home. */
export function isInsideFolderHome(absPath: string): boolean {
  const root = getFolderHome();
  const target = path.resolve(absPath);
  if (target === root) return false;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Validate a user-supplied folder name. Names must be a single,
 *  cross-platform-safe filename segment: no slashes, no dots-only, no
 *  leading/trailing dot, none of the Windows/FAT-reserved chars
 *  (`< > : " | ? *`), no control chars. Rejecting these here (not just
 *  the macOS-illegal `/`) keeps folders portable to Windows / git /
 *  cloud sync — symmetric with `sanitizeFilename` on the upload path.
 *  Returns null when valid, error message otherwise. */
export function validateFolderName(name: string): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name required';
  const n = name.trim();
  if (n === '.' || n === '..') return 'name cannot be "." or ".."';
  if (n.startsWith('.')) return 'name cannot start with "."';
  if (n.endsWith('.')) return 'name cannot end with "."';
  if (n.includes('/') || n.includes('\\')) return 'name cannot contain slashes';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return 'name cannot contain < > : " | ? * or control characters';
  if (n.length > 64) return 'name too long (max 64 chars)';
  return null;
}

/** Direct-child directory names under the default folder home. This is
 *  used only to decide whether first-launch seeding should run; it is
 *  not the library membership list. */
function listFolderNamesUnder(root: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      !isIndexExcludedDirName(e.name) &&
      validateFolderName(e.name) == null)
    .map((e) => e.name)
    .sort();
}

function listDefaultHomeFolderNames(): string[] {
  return listFolderNamesUnder(getFolderHome());
}

/** Normalise any path to an absolute POSIX string — the canonical form
 *  the indexer/daemon use as a file's `source` and a folder's bound root.
 *  `path.resolve` collapses `.`/`..` and trailing slashes so two callers
 *  deriving the same folder agree byte-for-byte. */
export function toPosixAbs(p: string): string {
  return path.resolve(p).split(path.sep).join('/');
}

/** Human-facing label for the open folder: relative display text when under
 *  the default home, else the folder basename. null if no folder is open. */
export function getCurrentFolderLabel(): string | null {
  const cs = getCurrentFolder();
  if (!cs) return null;
  const root = getFolderHome();
  const rel = path.relative(root, cs);
  if (cs !== root && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return path.basename(cs);
}

/** Convert a folder-relative path (`topic/note.md`) to the **absolute
 *  POSIX** path the indexer/daemon use as identity, rooted at the
 *  currently-open folder (`getCurrentFolder()`), which may live anywhere on
 *  disk. Throws if no folder is open — every call site should already be
 *  inside a request that has folder context. (Name kept for call-site
 *  stability; the value is now absolute — the daemon
 *  speaks absolute paths, see `indexer.mfs.ts`.) */
export function toSourcePath(folderRel: string): string {
  const cs = getCurrentFolder();
  if (!cs) throw new Error('no folder open');
  return joinUnderRoot(toPosixAbs(cs), folderRel);
}

/** Convert an absolute path (a daemon reply) back to a path relative to
 *  the currently-open folder, or null if it doesn't fall under it. */
export function fromSourcePath(sourcePath: string): string | null {
  const cs = getCurrentFolder();
  return cs ? relUnderRoot(sourcePath, toPosixAbs(cs)) : null;
}

/** Convert an absolute path to a path relative to `folderRoot` (an
 *  **absolute** folder root), without consulting the current window
 *  binding. Use this when a route accepts an explicit folder scope.
 *  Use this instead of ambient window context when the caller already has
 *  the folder root. */
export function relInFolder(abs: string, folderRoot: string): string | null {
  return folderRoot ? relUnderRoot(abs, toPosixAbs(folderRoot)) : null;
}

function joinUnderRoot(root: string, rel: string): string {
  const r = (rel ?? '').split(path.sep).join('/').replace(/^\/+/, '');
  return r ? `${root}/${r}` : root;
}

function relUnderRoot(abs: string, root: string): string | null {
  if (abs === root) return '';
  const prefix = `${root}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length);
}

/** Idempotent startup hook:
 *   1. Ensure the default folder home exists (mkdir -p) + seed the manual.
 *   2. Prune `recentFolders` entries whose folder no longer exists on disk
 *      (members can live anywhere; the only requirement is existence). */
export function ensureFolderHome(): void {
  const root = getFolderHome();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err: any) {
    log.warn(`failed to create folder home ${root}: ${errorMessage(err)}`);
  }
  const cfg = readConfig();
  const before = cfg.recentFolders ?? [];
  // Recents can live anywhere on disk (a Folder is openable from any
  // location); only drop entries whose folder no longer exists.
  const after = before.filter((r) => {
    try { return fs.statSync(r.path).isDirectory(); } catch { return false; }
  });
  if (after.length !== before.length) {
    cfg.recentFolders = after;
    log.info(`pruned ${before.length - after.length} stale recent(s)`);
    writeConfig(cfg);
  }
  // Seed the built-in manual here — `ensureFolderHome` is THE idempotent
  // "folder home is established" hook, hit on every boot.
  seedBuiltinFolder();
}

/** Absolute path of the bundled built-in folder's source content, or null
 *  if it isn't shipped with this build. */
function builtinFolderSource(): string | null {
  const src = path.join(RESOURCES_ROOT, 'assets', 'builtin-library');
  try {
    return fs.statSync(src).isDirectory() ? src : null;
  } catch {
    return null;
  }
}

/** First-launch onboarding: copy the bundled product-manual folder into the
 *  default folder home and surface it in the Welcome screen's recents, so a
 *  new user opens the app to content instead of an empty shell.
 *
 *  Two distinct jobs, in order:
 *
 *   1. **Surface** — if the manual is already on disk (`<root>/<name>`),
 *      make sure it's reachable from Welcome recents. This is independent
 *      of the `builtinSeeded` latch: surfacing isn't re-seeding. It
 *      covers the "config/recents wiped but the folder is still there"
 *      case (e.g. the user deletes `~/.stashbase`) — otherwise the manual
 *      exists but never shows. Only re-adds when it has fallen off recents,
 *      so a normal boot doesn't keep bumping it to the top.
 *
 *   2. **Seed** — otherwise, copy the bundled content in, but only into a
 *      brand-new empty library. The `builtinSeeded` latch means "we did
 *      the initial copy already": once set, a user who *deletes the
 *      folder* won't get it resurrected (delete the folder to be rid of
 *      it). An existing folder home is latched and left untouched.
 *
 *  Idempotent and failure-tolerant: any error is logged and swallowed —
 *  onboarding content must never block boot. Call before binding folders
 *  so the seeded folder is picked up by `bootBindAllFolders`. */
export function seedBuiltinFolder(): void {
  const root = getFolderHome();
  const dest = path.join(root, BUILTIN_FOLDER_NAME);

  const latch = () => {
    const c = readConfig();
    if (!c.builtinSeeded) { c.builtinSeeded = true; writeConfig(c); }
  };

  // (1) Already on disk → ensure it's in recents, regardless of the latch.
  if (fs.existsSync(dest)) {
    try {
      const inRecents = (readConfig().recentFolders ?? []).some((r) => r.path === dest);
      if (!inRecents) pushRecent(dest);
    } catch (err) {
      log.warn(`failed to surface built-in folder: ${errorMessage(err)}`);
    }
    latch();
    return;
  }

  // (2) Not on disk. If we already seeded once, the user deleted the
  // folder — don't resurrect it.
  if (readConfig().builtinSeeded) return;

  // Only seed a brand-new, empty folder home — never inject into an existing
  // user directory. Latch either way so this runs only once.
  if (listDefaultHomeFolderNames().length > 0) {
    latch();
    return;
  }

  const src = builtinFolderSource();
  if (!src) return; // not bundled in this build — try again next boot

  try {
    fs.mkdirSync(root, { recursive: true });
    copyDirectoryDereferenced(src, dest);
    pushRecent(dest);          // show it on the Welcome screen
    latch();
    log.info(`seeded built-in folder at ${dest}`);
  } catch (err) {
    log.warn(`failed to seed built-in folder: ${errorMessage(err)}`);
  }
}

/** Absolute path of the currently open folder, or null if none. */
export function getCurrentFolder(): string | null {
  return currentFolders.get(currentWindowId()) ?? null;
}

/** Throws if no folder is open — call this from request handlers that
 *  need folder state. The thrown error carries a `code` so the route
 *  layer can map it to HTTP 412. */
export function requireCurrentFolder(): string {
  const currentFolder = getCurrentFolder();
  if (!currentFolder) {
    const err = new Error('no folder open');
    (err as any).code = 'NO_FOLDER';
    throw err;
  }
  return currentFolder;
}

/** Open a folder at the given absolute path. Creates the directory if
 *  needed. Pushes to the recents list. Notifies switch listeners so
 *  cached resources can be reset. */
export function setCurrentFolder(absPath: string, opts?: { create?: boolean; exclusiveCreate?: boolean }): void {
  if (typeof absPath !== 'string' || !absPath) throw new Error('path required');
  // Expand a leading `~` so the welcome screen can accept `~/Notes`
  // without forcing the user to spell out their home directory.
  let expanded = absPath;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  const normalized = path.resolve(expanded);
  // A Folder can be opened from anywhere on disk — there is no unified root
  // constraint. The folder home is only the default location for the built-in
  // folder and new-folder-by-name; opening an arbitrary folder is the
  // norm (the daemon keys one global collection by absolute path, so a
  // folder outside the root indexes just fine).
  // Creating a folder only happens on the explicit New-folder flow
  // (`opts.create`). Open / recent flows must NOT mkdir: a missing
  // folder there means the folder was deleted/moved out from under us,
  // and silently re-creating it would resurrect an empty ghost folder
  // (and turn a typo'd `~/Notess` into a stray dir). Error instead.
  const existed = fs.existsSync(normalized);
  if (existed && opts?.create && opts.exclusiveCreate) {
    const err = new Error(`folder "${path.basename(normalized)}" already exists`);
    (err as any).code = 'FOLDER_EXISTS';
    throw err;
  }
  if (!existed) {
    if (!opts?.create) throw new Error('folder does not exist (it may have been moved or deleted)');
    fs.mkdirSync(normalized, { recursive: true });
    log.warn(`created new folder directory: ${normalized}`);
  }
  const st = fs.statSync(normalized);
  if (!st.isDirectory()) throw new Error('path is not a directory');

  const windowId = currentWindowId();
  const prev = currentFolders.get(windowId) ?? null;
  const changed = prev !== normalized;
  currentFolders.set(windowId, normalized);
  pushRecent(normalized);
  if (changed) {
    for (const fn of switchListeners) {
      try { fn(normalized, windowId); } catch (err) {
        log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearCurrentFolder(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  const oldRoot = currentFolders.get(id);
  currentFolders.delete(id);
  if (oldRoot) {
    for (const fn of closeListeners) {
      try { fn(oldRoot, id); } catch (err) {
        log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearFolderPath(absPath: string): void {
  for (const [windowId, value] of [...currentFolders.entries()]) {
    if (value === absPath) clearCurrentFolder(windowId);
  }
}

export function replaceCurrentFolderPath(oldPath: string, newPath: string): void {
  for (const [windowId, value] of currentFolders.entries()) {
    if (value === oldPath) {
      currentFolders.set(windowId, newPath);
      for (const fn of switchListeners) {
        try { fn(newPath, windowId); } catch (err) {
          log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
        }
      }
    }
  }
  const cfg = readConfig();
  if (cfg.recentFolders?.length) {
    cfg.recentFolders = cfg.recentFolders.map((r) => (
      r.path === oldPath ? { ...r, path: newPath } : r
    ));
    writeConfig(cfg);
  }
}

/** Subscribe to folder switches. The listener receives the absolute path
 *  of the newly-current folder; fires after the switch is in place. */
export function onSwitch(fn: (newRoot: string, windowId: string) => void): void {
  switchListeners.push(fn);
}

export function onClose(fn: (oldRoot: string, windowId: string) => void): void {
  closeListeners.push(fn);
}

export function getActiveFolders(): { windowId: string; path: string }[] {
  return [...currentFolders.entries()].map(([windowId, path]) => ({ windowId, path }));
}

/** Returns recent folders, most-recent first. Filters out paths that no
 *  longer exist on disk so the Welcome list only shows one-click-openable
 *  folders. */
export function getRecentFolders(): RecentFolder[] {
  const all = readConfig().recentFolders ?? [];
  // A Folder is openable from anywhere, so the only requirement is that it
  // still exists as a directory (handles a moved/deleted folder).
  return all.filter((v) => {
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
}

function pushRecent(absPath: string): void {
  const cfg = readConfig();
  const list = cfg.recentFolders ?? [];
  // Filter out the entry we're about to re-add (avoid dupes) AND
  // entries whose target folder no longer exists — keeps the persisted
  // recents from accumulating dead tmp dirs / deleted folders over
  // time. Opportunistic cleanup on every write.
  const existing = list.find((v) => v.path === absPath);
  const filtered = list.filter((v) => {
    if (v.path === absPath) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
  filtered.unshift({ ...(existing ?? {}), path: absPath, openedAt: new Date().toISOString() });
  // No cap: this list IS the knowledge-base membership ("Your Folders"),
  // not a transient recency log. Opening a folder joins it; the only way
  // out is an explicit remove (`removeRecent`). A hard cap would silently
  // evict the oldest member's searchability — see the folder-redesign
  // model (data-layer.md §membership).
  cfg.recentFolders = filtered;
  // Drop the legacy field once we've migrated its content forward.
  delete cfg.recentVaults;
  writeConfig(cfg);
}

/** Remove a folder from the membership list ("Your Folders"). Does NOT
 *  touch the folder on disk — removal only forgets it from the knowledge
 *  base; the caller clears its index rows separately. No-op if absent. */
export function removeRecent(absPath: string): void {
  const target = toPosixAbs(absPath);
  const cfg = readConfig();
  const list = cfg.recentFolders ?? [];
  const filtered = list.filter((v) => toPosixAbs(v.path) !== target);
  if (filtered.length === list.length) return;
  cfg.recentFolders = filtered;
  writeConfig(cfg);
}

// ---------- API key (global) ----------

/** Returns the user's stored OpenAI key, or undefined if none. */
