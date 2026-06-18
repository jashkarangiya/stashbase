/**
 * Space registry, window context, and KB-root management.
 *
 * Persistence reuses `app-config.ts`'s `~/.stashbase/config.json`
 * primitives for the kbRoot / recents fields; credentials and user
 * preferences (API keys, terminal CLI) live in app-config.ts entirely.
 *
 * The currently-open space is in-memory only — server restart goes
 * back to the welcome screen. Other modules subscribe to switches via
 * `onSwitch()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { logger, errorMessage } from './log.ts';
import { copyDirectoryDereferenced } from './fs-move.ts';
import { isIndexExcludedDirName } from './indexable.ts';
import { kbLocalDataDir } from './local-data.ts';
import {
  readAppConfig as readConfig,
  writeAppConfig as writeConfig,
  type RecentSpace,
} from './app-config.ts';

// Type re-exports so existing `from './space.ts'` type imports keep
// working; the values live in app-config.ts.
export type { EmbedderProvider, RecentSpace } from './app-config.ts';

const log = logger('space');

const MAX_RECENT = 50;
const MIGRATION_STAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default KB root: `~/Documents/StashBase/`. All spaces must live
 *  under this folder. Persisted in `config.json` so a future "change
 *  KB location" UI can edit it; for now it's just the constant. */
const DEFAULT_KB_ROOT = path.join(os.homedir(), 'Documents', 'StashBase');
export const WINDOW_ID_HEADER = 'x-stashbase-window-id';

/** Space-folder name of the bundled product manual, seeded into a fresh
 *  KB on first launch so the user never faces an empty app. Doubles as
 *  the disk directory name and the Welcome-screen recents label. */
const BUILTIN_SPACE_NAME = '👋 Start Here';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where bundled assets live. Packaged: `extraResources` under
 *  `process.resourcesPath` (injected via `STASHBASE_RESOURCES_PATH`).
 *  Dev: the project root. Mirrors `mfs-daemon.ts`'s resolution. */
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : process.env.STASHBASE_APP_ROOT
    ? path.resolve(process.env.STASHBASE_APP_ROOT)
    : path.resolve(__dirname, '..');

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SpaceConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

const DEFAULT_WINDOW_ID = 'default';
const requestWindow = new AsyncLocalStorage<string>();
const currentSpaces = new Map<string, string>();
const switchListeners: Array<(newRoot: string, windowId: string) => void> = [];
const closeListeners: Array<(oldRoot: string, windowId: string) => void> = [];
const beforeKbRootListeners: Array<(oldRoot: string, newRoot: string) => void | Promise<void>> = [];
const kbRootListeners: Array<(newRoot: string) => void | Promise<void>> = [];

export function runWithWindowId<T>(windowId: string | null | undefined, fn: () => T): T {
  return requestWindow.run(normalizeWindowId(windowId), fn);
}

/** Run a backend operation against a named space without changing any
 *  user window, recents, or switch listeners. KB-wide routes use this
 *  to reuse the space-relative filesystem layer while accepting
 *  kbRoot-relative paths from MCP.
 */
export async function runWithSpaceName<T>(
  spaceName: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const root = requireSpaceExistsByName(spaceName);
  return runWithWindowId(`__kb:${spaceName}`, async () => {
    const windowId = currentWindowId();
    const hadPrev = currentSpaces.has(windowId);
    const prev = currentSpaces.get(windowId);
    currentSpaces.set(windowId, root);
    try {
      return await fn();
    } finally {
      if (hadPrev && prev) currentSpaces.set(windowId, prev);
      else currentSpaces.delete(windowId);
    }
  });
}

export function currentWindowId(): string {
  return requestWindow.getStore() ?? DEFAULT_WINDOW_ID;
}

function normalizeWindowId(windowId: string | null | undefined): string {
  const raw = typeof windowId === 'string' ? windowId.trim() : '';
  return raw ? raw.slice(0, 128) : DEFAULT_WINDOW_ID;
}

// ---------- KB root (KB folder) ----------

/** Absolute path of the KB root folder. Reads from config if set,
 *  otherwise the default `~/Documents/StashBase/`. Always returns a
 *  normalised path — caller can compare directly. */
export function getKbRoot(): string {
  const raw = readConfig().kbRoot;
  const p = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_KB_ROOT;
  return path.resolve(p);
}

export function needsKbRootPicker(): boolean {
  const raw = readConfig().kbRoot;
  if (typeof raw === 'string' && raw.trim()) return false;
  return listAvailableSpaceNames().length === 0;
}

/** Expand `~`, require absolute, and resolve. Shared by `setKbRoot`
 *  and the migration preview so they agree on what a path means. */
function resolveRootPath(absPath: string): string {
  if (typeof absPath !== 'string' || !absPath.trim()) throw new Error('path required');
  let expanded = absPath.trim();
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  return path.resolve(expanded);
}

/** Per-space resolution for a KB-root migration. `move` = no collision
 *  (or the caller decided to just move it), `overwrite` = replace the
 *  same-named space already in the target, `rename` = move under a
 *  free `"<name> N"`. Spaces absent from the list stay in the old root. */
export type MigrateAction = 'move' | 'overwrite' | 'rename';
export interface MigrateEntry { name: string; action: MigrateAction; }

export interface KbRootMigrationPreview {
  /** Space folders under the *current* root that could be moved. */
  spaces: string[];
  /** Of those, the names that already exist in the target root. */
  collisions: string[];
  /** Target resolves to the current root — nothing to migrate. */
  sameRoot: boolean;
}

/** Look before the leap: what would moving spaces into `targetPath`
 *  involve? Drives the migration dialog without touching anything. */
export function previewKbRootMigration(targetPath: string): KbRootMigrationPreview {
  const oldRoot = getKbRoot();
  const target = validateKbRootTarget(targetPath);
  if (target === oldRoot) return { spaces: [], collisions: [], sameRoot: true };
  const spaces = listSpaceNamesUnder(oldRoot);
  const existing = new Set(listSpaceNamesUnder(target));
  return { spaces, collisions: spaces.filter((s) => existing.has(s)), sameRoot: false };
}

/** Validate a candidate KB root before any migration or config write.
 *  Existing targets must be writable directories. Missing targets may be
 *  created, but only as one final path segment under an existing writable
 *  parent; this avoids turning typos like `/Volumes/Missing/StashBase`
 *  into surprising recursive mkdir attempts. */
export function validateKbRootTarget(absPath: string): string {
  const root = resolveRootPath(absPath);
  if (fs.existsSync(root)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(root); } catch (err) { throwPathAccessError(root, err); }
    if (!stat.isDirectory()) throw new Error('path is not a directory');
    assertDirectoryAccess(root, 'directory');
    return root;
  }

  const parent = path.dirname(root);
  if (parent === root || !fs.existsSync(parent)) {
    throw new Error('parent directory does not exist');
  }
  let parentStat: fs.Stats;
  try { parentStat = fs.statSync(parent); } catch (err) { throwPathAccessError(parent, err); }
  if (!parentStat.isDirectory()) throw new Error('parent path is not a directory');
  assertDirectoryAccess(parent, 'parent directory');
  return root;
}

function assertDirectoryAccess(dir: string, label: string): void {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`${label} is not writable`);
  }
}

function throwPathAccessError(target: string, err: unknown): never {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') throw new Error(`${target} is not accessible`);
  throw err;
}

export async function setKbRoot(
  absPath: string,
  opts: { allowNonEmpty?: boolean; migrate?: MigrateEntry[] } = {},
): Promise<{ warnings: string[] }> {
  const root = validateKbRootTarget(absPath);
  const oldRoot = getKbRoot();
  const migrate = opts.migrate ?? [];
  const migrating = migrate.length > 0;
  const changingRoot = root !== oldRoot;
  if (changingRoot) assertRootNotNested(oldRoot, root);
  if (migrating && !changingRoot) throw new Error('cannot migrate into the same root');

  // Non-empty guard — skipped when migrating, since the whole point is
  // to move spaces *into* a populated target.
  if (fs.existsSync(root) && !opts.allowNonEmpty && !migrating) {
    if (!fs.statSync(root).isDirectory()) throw new Error('path is not a directory');
    const entries = fs.readdirSync(root);
    const selfEntries = new Set(['.DS_Store', '.stashbase', 'STASHBASE.md']);
    if (entries.some((name) => !selfEntries.has(name))) {
      const err = new Error('directory is not empty');
      (err as any).code = 'NON_EMPTY';
      throw err;
    }
  }
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error('path is not a directory');
  assertDirectoryAccess(root, 'directory');

  let rootChangeStarted = false;
  let configWritten = false;
  try {
    if (changingRoot) {
      rootChangeStarted = true;
      await beforeKbRootChange(oldRoot, root);
    }

    // Move spaces from the old root into the new one *before* switching —
    // `getKbRoot()` still points at the old root here, and each move is a
    // staged copy + commit (cross-filesystem safe; see migrateSpacesToRoot).
    const warnings: string[] = [];
    let movedSpaces: MigratedSpace[] = [];
    if (migrating) {
      const result = migrateSpacesToRoot(oldRoot, root, migrate);
      movedSpaces = result.moved;
      warnings.push(...result.warnings);
    }
    const preserveSources = migrateLocalSpaceConfigs(oldRoot, root, movedSpaces, warnings);

    ensureKbMetadata(root);
    const cfg = readConfig();
    cfg.kbRoot = root;
    cfg.recentSpaces = recentSpacesForRoot(root);
    delete cfg.recentVaults;
    writeConfig(cfg);
    configWritten = true;
    // Make the post-save state immediately observable to the route
    // response: the first-run picker refreshes Welcome right after
    // `PUT /api/kb-root`, so the bundled starter space should already be
    // on disk and in recents. The kbRoot-change listener also calls this;
    // the latch makes the second call a no-op.
    seedBuiltinSpace();
    for (const [windowId, prevRoot] of currentSpaces.entries()) {
      for (const fn of closeListeners) {
        try { fn(prevRoot, windowId); } catch (err) {
          log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
        }
      }
    }
    currentSpaces.clear();
    for (const fn of kbRootListeners) {
      try {
        await fn(root);
      } catch (err) {
        const message = (err as any)?.message ?? String(err);
        warnings.push(`Root folder was saved, but runtime cleanup reported: ${message}`);
        log.warn(`kbRoot listener threw: ${message}`);
      }
    }
    deleteMigratedSources(movedSpaces, warnings, preserveSources);
    return { warnings };
  } catch (err) {
    if (rootChangeStarted && !configWritten) {
      await restoreKbRootRuntimeAfterFailedChange(oldRoot);
    }
    throw err;
  }
}

interface MigratedSpace {
  oldName: string;
  newName: string;
  source: string;
  destination: string;
}

interface MigrationPlan extends MigratedSpace {
  action: MigrateAction;
  staged: string;
  backup?: string;
}

function assertRootNotNested(oldRoot: string, newRoot: string): void {
  if (pathContains(oldRoot, newRoot) || pathContains(newRoot, oldRoot)) {
    throw new Error('new root cannot be inside the current root, or contain the current root');
  }
}

function pathContains(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function beforeKbRootChange(oldRoot: string, newRoot: string): Promise<void> {
  for (const fn of beforeKbRootListeners) {
    await fn(oldRoot, newRoot);
  }
}

async function restoreKbRootRuntimeAfterFailedChange(root: string): Promise<void> {
  for (const fn of kbRootListeners) {
    try {
      await fn(root);
    } catch (err) {
      log.warn(`kbRoot restore listener threw: ${(err as any)?.message ?? err}`);
    }
  }
  for (const [windowId, spaceRoot] of currentSpaces.entries()) {
    for (const fn of switchListeners) {
      try { fn(spaceRoot, windowId); } catch (err) {
        log.warn(`switch restore listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

function migrateSpacesToRoot(
  oldRoot: string,
  newRoot: string,
  entries: MigrateEntry[],
): { moved: MigratedSpace[]; warnings: string[] } {
  if (entries.length === 0) return { moved: [], warnings: [] };
  const stash = path.join(newRoot, '.stashbase');
  fs.mkdirSync(stash, { recursive: true });
  cleanupOldMigrationStages(stash);
  const staging = fs.mkdtempSync(path.join(stash, 'migration-stage-'));
  const backupRoot = fs.mkdtempSync(path.join(stash, 'migration-backup-'));
  const reserved = new Set(listSpaceNamesUnder(newRoot));
  const seenSources = new Set<string>();
  const plans: MigrationPlan[] = [];

  try {
    for (const entry of entries) {
      if (entry.action !== 'move' && entry.action !== 'overwrite' && entry.action !== 'rename') {
        throw new Error(`invalid migrate action for "${entry.name}"`);
      }
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const bad = validateSpaceName(name);
      if (bad) throw new Error(`invalid space "${entry.name}": ${bad}`);
      if (seenSources.has(name)) throw new Error(`duplicate migrate entry for "${name}"`);
      seenSources.add(name);
      const source = path.join(oldRoot, name);
      let isDir = false;
      try { isDir = fs.statSync(source).isDirectory(); } catch { /* gone since preview */ }
      if (!isDir) continue;

      let newName = name;
      const destinationExists = fs.existsSync(path.join(newRoot, newName));
      if (entry.action === 'rename' && (destinationExists || reserved.has(newName))) {
        newName = freeSpaceNameReserved(reserved, name);
      } else if (entry.action !== 'overwrite' && reserved.has(newName)) {
        throw new Error(`space "${newName}" already exists in the new root`);
      }
      reserved.add(newName);

      const staged = path.join(staging, newName);
      copyDirectoryDereferenced(source, staged);
      plans.push({
        oldName: name,
        newName,
        source,
        destination: path.join(newRoot, newName),
        action: entry.action,
        staged,
      });
    }
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  const committed: MigrationPlan[] = [];
  try {
    for (const plan of plans) {
      if (fs.existsSync(plan.destination)) {
        if (plan.action !== 'overwrite') throw new Error(`destination already exists: ${plan.destination}`);
        plan.backup = path.join(backupRoot, plan.newName);
        fs.renameSync(plan.destination, plan.backup);
      }
      fs.renameSync(plan.staged, plan.destination);
      pruneStashbasePerMachineState(path.join(plan.destination, '.stashbase'));
      ensureSpaceMetadata(plan.destination);
      committed.push(plan);
    }
  } catch (err) {
    rollbackCommittedMigration(committed);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  return { moved: committed, warnings: [] };
}

function rollbackCommittedMigration(plans: MigrationPlan[]): void {
  for (const plan of [...plans].reverse()) {
    try { fs.rmSync(plan.destination, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (plan.backup && fs.existsSync(plan.backup)) {
      try { fs.renameSync(plan.backup, plan.destination); } catch { /* best-effort */ }
    }
  }
}

function freeSpaceNameReserved(reserved: Set<string>, base: string): string {
  for (let n = 2; ; n++) {
    const cand = `${base} ${n}`;
    if (!reserved.has(cand)) return cand;
  }
}

function migrateLocalSpaceConfigs(
  oldRoot: string,
  newRoot: string,
  moved: MigratedSpace[],
  warnings: string[],
): Set<string> {
  const preserveSources = new Set<string>();
  for (const space of moved) {
    const oldPath = spaceConfigPathForRoot(oldRoot, space.oldName);
    const legacyPath = path.join(oldRoot, space.oldName, '.stashbase', 'config.json');
    const source = fs.existsSync(oldPath) ? oldPath : legacyPath;
    if (!fs.existsSync(source)) continue;
    const target = spaceConfigPathForRoot(newRoot, space.newName);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
    } catch (err: unknown) {
      preserveSources.add(space.source);
      warnings.push(`Could not copy local config for "${space.oldName}": ${errorMessage(err)}`);
    }
  }
  return preserveSources;
}

function deleteMigratedSources(
  moved: MigratedSpace[],
  warnings: string[],
  preserveSources: Set<string>,
): void {
  for (const space of moved) {
    if (preserveSources.has(space.source)) {
      warnings.push(
        `Copied "${space.oldName}" into ${space.destination}, but left the original at ${space.source} ` +
        'because its local config could not be migrated.',
      );
      continue;
    }
    try {
      fs.rmSync(space.source, { recursive: true, force: false });
      deleteSpaceConfigForRoot(path.dirname(space.source), space.oldName);
    } catch {
      warnings.push(
        `Copied "${space.oldName}" into ${space.destination}, but the original at ${space.source} ` +
        "couldn't be fully removed and may be partially deleted; delete it manually.",
      );
    }
  }
}

function recentSpacesForRoot(root: string): RecentSpace[] {
  const now = new Date().toISOString();
  return listSpaceNamesUnder(root)
    .slice(0, MAX_RECENT)
    .map((name) => ({ path: path.join(root, name), openedAt: now }));
}

/** True if `absPath` is a **direct child** of the KB root. Spaces are
 *  flat: nesting isn't allowed, so `<root>/foo` is valid but
 *  `<root>/foo/bar` and the root itself are not. */
export function isUnderRoot(absPath: string): boolean {
  const root = getKbRoot();
  const target = path.resolve(absPath);
  if (target === root) return false;
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // Reject anything deeper than one segment — spaces are flat under
  // the KB root. Caller silently filters; the daemon/indexer
  // depend on the one-segment invariant for O(1) routing.
  if (rel.includes(path.sep)) return false;
  return true;
}

/** True if `absPath` lives anywhere inside the KB root (any depth).
 *  Use this for file-level operations on kbRoot-relative paths like
 *  `cs183b/lecture-01.md` — `isUnderRoot` rejects them because it
 *  enforces the one-segment space-boundary invariant. The kbRoot
 *  itself doesn't qualify (it's the container, not "inside" it). */
export function isInsideKbRoot(absPath: string): boolean {
  const root = getKbRoot();
  const target = path.resolve(absPath);
  if (target === root) return false;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Validate a user-supplied space name. Names must be a single,
 *  cross-platform-safe filename segment: no slashes, no dots-only, no
 *  leading/trailing dot, none of the Windows/FAT-reserved chars
 *  (`< > : " | ? *`), no control chars. Rejecting these here (not just
 *  the macOS-illegal `/`) keeps spaces portable to Windows / git /
 *  cloud sync — symmetric with `sanitizeFilename` on the upload path.
 *  Returns null when valid, error message otherwise. */
export function validateSpaceName(name: string): string | null {
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

/** Validate a reference to an already-existing/opened space. Kept as a
 *  separate helper from create/rename validation so route code reads as
 *  "this is a scope", while preserving the flat-space invariant.
 */
export function validateSpaceRef(spaceName: string): string | null {
  return validateSpaceName(spaceName);
}

/** Internal entries under `.stashbase/` that **must** be wiped when a
 *  space arrives from elsewhere — a git clone or a folder import.
 *  These are per-machine state (embedder routing, the local vector store,
 *  the storage-state DB, the cache) and never portable. Everything else
 *  stays; `snapshot.parquet` lives here intentionally and is preserved.
 *  Shared by the clone and import-folder flows so a rename here only
 *  happens once. (`mfs` is the pre-rename store dir, kept until legacy
 *  spaces age out.) */
export const STASHBASE_PER_MACHINE_ENTRIES = [
  'config.json',
  'store.nosync',
  'store',
  'mfs',
  'cache',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'pdf-status.json',
  'pdf-status.json.migrated',
];

/** Selectively delete per-machine internal state out of a space's
 *  `.stashbase/` directory, leaving portable artefacts (notably
 *  `snapshot.parquet`) intact. No-op if the directory doesn't exist. */
export function pruneStashbasePerMachineState(stashbaseDir: string): void {
  if (!fs.existsSync(stashbaseDir)) return;
  for (const entry of STASHBASE_PER_MACHINE_ENTRIES) {
    fs.rmSync(path.join(stashbaseDir, entry), { recursive: true, force: true });
  }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stashbaseDir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('state.db-')) {
      fs.rmSync(path.join(stashbaseDir, entry.name), { recursive: true, force: true });
    }
  }
}

/** Direct-child directory names under `root` that count as spaces
 *  (skips dotfiles like `.stashbase`). Sorted. */
function listSpaceNamesUnder(root: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      !isIndexExcludedDirName(e.name) &&
      validateSpaceName(e.name) == null)
    .map((e) => e.name)
    .sort();
}

export function listAvailableSpaceNames(): string[] {
  return listSpaceNamesUnder(getKbRoot());
}

/** Current space's name, expressed as a kbRoot-relative POSIX path.
 *  In normal operation this is a single direct-child segment (`cs183b`)
 *  because spaces are flat under the KB root. null if no space open.
 *
 *  This is the bridge between the rest of the server (which operates
 *  in space-relative paths) and the indexer (which uses kbRoot-relative
 *  paths so it can route to per-provider collections). See `toKbRel`
 *  / `fromKbRel`. */
export function getCurrentSpaceName(): string | null {
  const cs = getCurrentSpace();
  if (!cs) return null;
  const root = getKbRoot();
  if (cs === root) return null;
  const rel = path.relative(root, cs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Convert a space-relative path (`topic/note.md`) to a kbRoot-relative
 *  one (`cs183b/topic/note.md`). Throws if no space is open — every
 *  call site should already be inside a request that has space context. */
export function toKbRel(spaceRel: string): string {
  const name = getCurrentSpaceName();
  if (!name) throw new Error('no space open');
  return spaceRel ? `${name}/${spaceRel}` : name;
}

/** Convert a kbRoot-relative path to a space-relative one, or null if
 *  the path doesn't fall under the current space. Used to translate
 *  daemon-returned paths (search hits, status lists) back into the
 *  space-relative form the UI expects. */
export function fromKbRel(kbRel: string): string | null {
  const name = getCurrentSpaceName();
  return name ? fromKbRelForSpace(kbRel, name) : null;
}

/** Convert a kbRoot-relative path to a path relative to `spaceName`,
 *  without consulting the current window binding. Use this when a
 *  route accepts an explicit space scope.
 */
export function fromKbRelForSpace(kbRel: string, spaceName: string): string | null {
  const name = spaceName.trim();
  if (!name) return null;
  if (kbRel === name) return '';
  const prefix = `${name}/`;
  if (!kbRel.startsWith(prefix)) return null;
  return kbRel.slice(prefix.length);
}

/** Direct-child spaces of the KB root that have been opened before
 *  (their directory contains a `.stashbase/` subdir). Returns
 *  kbRoot-relative names. Used at server boot to bind every known
 *  space so MCP cross-space search has them all available. */
export function listKnownSpaces(): string[] {
  const root = getKbRoot();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const inner = path.join(root, e.name, '.stashbase');
    try {
      if (fs.statSync(inner).isDirectory()) out.push(e.name);
    } catch { /* not yet opened — skip */ }
  }
  out.sort();
  return out;
}

/** Idempotent startup hook:
 *   1. Ensure the KB root exists (mkdir -p).
 *   2. Prune `recentSpaces` entries that are outside the root —
 *      enforces the new invariant ("all spaces must live under the
 *      root") so old recents from the unrestricted era don't keep
 *      offering invalid one-click opens. Persists the trimmed list. */
export function ensureKbRoot(): void {
  const root = getKbRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    ensureKbMetadata(root);
  } catch (err: any) {
    log.warn(`failed to create kbRoot ${root}: ${errorMessage(err)}`);
  }
  const cfg = readConfig();
  let dirty = false;
  if (typeof cfg.kbRoot !== 'string' || !cfg.kbRoot.trim()) {
    cfg.kbRoot = root;
    dirty = true;
  }
  const before = cfg.recentSpaces ?? [];
  const after = before.filter((r) => isUnderRoot(r.path));
  if (after.length !== before.length) {
    cfg.recentSpaces = after;
    dirty = true;
    log.info(`pruned ${before.length - after.length} out-of-root recent(s) (kbRoot=${root})`);
  }
  if (dirty) writeConfig(cfg);
  // Seed the built-in manual here — `ensureKbRoot` is THE idempotent
  // "root is now established" hook, hit by both boot and the lazy
  // `GET /api/kb-root` adopt-default path. The picker path doesn't call
  // this (it goes through `setKbRoot`), so it seeds via `onKbRootChange`.
  seedBuiltinSpace();
}

/** Absolute path of the bundled built-in space's source content, or null
 *  if it isn't shipped with this build. */
function builtinSpaceSource(): string | null {
  const src = path.join(RESOURCES_ROOT, 'assets', 'builtin-space');
  try {
    return fs.statSync(src).isDirectory() ? src : null;
  } catch {
    return null;
  }
}

/** First-launch onboarding: copy the bundled product-manual space into a
 *  fresh KB and surface it in the Welcome screen's recents, so a new user
 *  opens the app to content instead of an empty shell.
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
 *      it). An existing library (upgrading user / root re-pointed at a
 *      populated folder) is latched and left untouched.
 *
 *  Idempotent and failure-tolerant: any error is logged and swallowed —
 *  onboarding content must never block boot. Call before binding spaces
 *  so the seeded space is picked up by `bootBindAllSpaces`. */
export function seedBuiltinSpace(): void {
  const root = getKbRoot();
  const dest = path.join(root, BUILTIN_SPACE_NAME);

  const latch = () => {
    const c = readConfig();
    if (!c.builtinSeeded) { c.builtinSeeded = true; writeConfig(c); }
  };

  // (1) Already on disk → ensure it's in recents, regardless of the latch.
  if (fs.existsSync(dest)) {
    try {
      ensureSpaceMetadata(dest); // idempotent; makes it a known space
      const inRecents = (readConfig().recentSpaces ?? []).some((r) => r.path === dest);
      if (!inRecents) pushRecent(dest);
    } catch (err) {
      log.warn(`failed to surface built-in space: ${errorMessage(err)}`);
    }
    latch();
    return;
  }

  // (2) Not on disk. If we already seeded once, the user deleted the
  // folder — don't resurrect it.
  if (readConfig().builtinSeeded) return;

  // Only seed a brand-new, empty library — never inject into an existing
  // user's KB. Latch either way so this runs only once.
  if (listAvailableSpaceNames().length > 0) {
    latch();
    return;
  }

  const src = builtinSpaceSource();
  if (!src) return; // not bundled in this build — try again next boot

  try {
    fs.mkdirSync(root, { recursive: true });
    copyDirectoryDereferenced(src, dest);
    ensureSpaceMetadata(dest); // scaffolds .stashbase/ so it's a known space
    pushRecent(dest);          // show it on the Welcome screen
    latch();
    log.info(`seeded built-in space at ${dest}`);
  } catch (err) {
    log.warn(`failed to seed built-in space: ${errorMessage(err)}`);
  }
}

function getSpaceRootPath(spaceName: string): string {
  const bad = validateSpaceRef(spaceName);
  if (bad) throw new Error(bad);
  return path.join(getKbRoot(), spaceName);
}


export function requireSpaceExistsByName(spaceName: string): string {
  const root = getSpaceRootPath(spaceName);
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    /* fall through */
  }
  const err = new Error('space not found');
  (err as any).code = 'SPACE_NOT_FOUND';
  throw err;
}

/** Absolute path of the currently open space, or null if none. */
export function getCurrentSpace(): string | null {
  return currentSpaces.get(currentWindowId()) ?? null;
}

/** Throws if no space is open — call this from request handlers that
 *  need space state. The thrown error carries a `code` so the route
 *  layer can map it to HTTP 412. */
export function requireCurrentSpace(): string {
  const currentSpace = getCurrentSpace();
  if (!currentSpace) {
    const err = new Error('no space open');
    (err as any).code = 'NO_SPACE';
    throw err;
  }
  return currentSpace;
}

/** Open a space at the given absolute path. Creates the directory if
 *  needed. Pushes to the recents list. Notifies switch listeners so
 *  cached resources can be reset. */
export function setCurrentSpace(absPath: string, opts?: { create?: boolean; exclusiveCreate?: boolean }): void {
  if (typeof absPath !== 'string' || !absPath) throw new Error('path required');
  // Expand a leading `~` so the welcome screen can accept `~/Notes`
  // without forcing the user to spell out their home directory.
  let expanded = absPath;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) throw new Error('path must be absolute');
  const normalized = path.resolve(expanded);
  // Spaces are strictly constrained to live under the KB root. The
  // SpacePicker UI only surfaces in-root folders, but this check is
  // defence-in-depth for direct API hits / stale recent entries that
  // slipped through the boot prune.
  if (!isUnderRoot(normalized)) {
    throw new Error(`space must live under ${getKbRoot()}`);
  }
  // Creating a folder only happens on the explicit New-space flow
  // (`opts.create`). Open / recent flows must NOT mkdir: a missing
  // folder there means the space was deleted/moved out from under us,
  // and silently re-creating it would resurrect an empty ghost space
  // (and turn a typo'd `~/Notess` into a stray dir). Error instead.
  const existed = fs.existsSync(normalized);
  if (existed && opts?.create && opts.exclusiveCreate) {
    const err = new Error(`space "${path.basename(normalized)}" already exists`);
    (err as any).code = 'SPACE_EXISTS';
    throw err;
  }
  if (!existed) {
    if (!opts?.create) throw new Error('space does not exist (it may have been moved or deleted)');
    fs.mkdirSync(normalized, { recursive: true });
    log.warn(`created new space directory: ${normalized}`);
  }
  const st = fs.statSync(normalized);
  if (!st.isDirectory()) throw new Error('path is not a directory');

  ensureSpaceMetadata(normalized);
  const windowId = currentWindowId();
  const prev = currentSpaces.get(windowId) ?? null;
  const changed = prev !== normalized;
  currentSpaces.set(windowId, normalized);
  pushRecent(normalized);
  if (changed) {
    for (const fn of switchListeners) {
      try { fn(normalized, windowId); } catch (err) {
        log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearCurrentSpace(windowId = currentWindowId()): void {
  const id = normalizeWindowId(windowId);
  const oldRoot = currentSpaces.get(id);
  currentSpaces.delete(id);
  if (oldRoot) {
    for (const fn of closeListeners) {
      try { fn(oldRoot, id); } catch (err) {
        log.warn(`close listener threw: ${(err as any)?.message ?? err}`);
      }
    }
  }
}

export function clearSpacePath(absPath: string): void {
  for (const [windowId, value] of [...currentSpaces.entries()]) {
    if (value === absPath) clearCurrentSpace(windowId);
  }
}

export function replaceCurrentSpacePath(oldPath: string, newPath: string): void {
  for (const [windowId, value] of currentSpaces.entries()) {
    if (value === oldPath) {
      currentSpaces.set(windowId, newPath);
      for (const fn of switchListeners) {
        try { fn(newPath, windowId); } catch (err) {
          log.warn(`switch listener threw: ${(err as any)?.message ?? err}`);
        }
      }
    }
  }
  const cfg = readConfig();
  if (cfg.recentSpaces?.length) {
    cfg.recentSpaces = cfg.recentSpaces.map((r) => (
      r.path === oldPath ? { ...r, path: newPath } : r
    ));
    writeConfig(cfg);
  }
}

/** Subscribe to space switches. The listener receives the absolute path
 *  of the newly-current space; fires after the switch is in place. */
export function onSwitch(fn: (newRoot: string, windowId: string) => void): void {
  switchListeners.push(fn);
}

export function onClose(fn: (oldRoot: string, windowId: string) => void): void {
  closeListeners.push(fn);
}

export function onBeforeKbRootChange(fn: (oldRoot: string, newRoot: string) => void | Promise<void>): void {
  beforeKbRootListeners.push(fn);
}

export function onKbRootChange(fn: (newRoot: string) => void | Promise<void>): void {
  kbRootListeners.push(fn);
}

export function getActiveSpaces(): { windowId: string; path: string }[] {
  return [...currentSpaces.entries()].map(([windowId, path]) => ({ windowId, path }));
}

/** Returns recent spaces, most-recent first. Filters out paths that no
 *  longer exist on disk OR have drifted outside the KB root (e.g. a
 *  user moved the KB folder externally) so the Welcome list only
 *  shows one-click-openable spaces. */
export function getRecentSpaces(): RecentSpace[] {
  const all = readConfig().recentSpaces ?? [];
  return all.filter((v) => {
    if (!isUnderRoot(v.path)) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
}

function pushRecent(absPath: string): void {
  const cfg = readConfig();
  const list = cfg.recentSpaces ?? [];
  // Filter out the entry we're about to re-add (avoid dupes) AND
  // entries whose target folder no longer exists — keeps the persisted
  // recents from accumulating dead tmp dirs / deleted folders over
  // time. Opportunistic cleanup on every write.
  const filtered = list.filter((v) => {
    if (v.path === absPath) return false;
    try { return fs.statSync(v.path).isDirectory(); } catch { return false; }
  });
  filtered.unshift({ path: absPath, openedAt: new Date().toISOString() });
  cfg.recentSpaces = filtered.slice(0, MAX_RECENT);
  // Drop the legacy field once we've migrated its content forward.
  delete cfg.recentVaults;
  writeConfig(cfg);
}

export function getSpaceConfigPath(spaceName: string): string {
  const bad = validateSpaceRef(spaceName);
  if (bad) throw new Error(bad);
  return spaceConfigPathForRoot(getKbRoot(), spaceName);
}

export function readSpaceConfig(spaceName: string): SpaceConfigFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSpaceConfigPath(spaceName), 'utf8'));
    return sanitizeSpaceConfig(parsed);
  } catch {
    return migrateLegacySpaceConfig(spaceName);
  }
}

export function writeSpaceConfig(spaceName: string, cfg: SpaceConfigFile): void {
  const file = getSpaceConfigPath(spaceName);
  writeSpaceConfigFileAtomic(file, sanitizeSpaceConfig(cfg));
}

export function deleteSpaceConfig(spaceName: string): void {
  deleteSpaceConfigForRoot(getKbRoot(), spaceName);
}

export function renameSpaceConfig(oldName: string, newName: string): void {
  if (oldName === newName) return;
  const oldDir = path.dirname(getSpaceConfigPath(oldName));
  const newDir = path.dirname(getSpaceConfigPath(newName));
  fs.rmSync(newDir, { recursive: true, force: true });
  if (!fs.existsSync(oldDir)) return;
  fs.mkdirSync(path.dirname(newDir), { recursive: true, mode: 0o700 });
  fs.renameSync(oldDir, newDir);
}

export interface ResolvedSpaceConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function resolveSpaceConfig(spaceName: string): ResolvedSpaceConfig {
  const base = sanitizeSpaceConfig(readConfig());
  const local = readSpaceConfig(spaceName);
  return {
    mcpServers: { ...(base.mcpServers ?? {}), ...(local.mcpServers ?? {}) },
  };
}

function sanitizeSpaceConfig(raw: unknown): SpaceConfigFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: SpaceConfigFile = {};
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      if (typeof v.command !== 'string' || !v.command.trim()) continue;
      servers[name] = {
        command: v.command.trim(),
        ...(Array.isArray(v.args) ? { args: v.args.filter((a): a is string => typeof a === 'string') } : {}),
        ...(v.env && typeof v.env === 'object' && !Array.isArray(v.env)
          ? { env: Object.fromEntries(
              Object.entries(v.env as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            ) }
          : {}),
      };
    }
    out.mcpServers = servers;
  }
  return out;
}

function spaceConfigDirName(spaceName: string): string {
  const hash = crypto.createHash('sha256').update(spaceName).digest('hex').slice(0, 16);
  const base = spaceName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'space';
  return `${base.slice(0, 48)}-${hash}`;
}

function spaceConfigPathForRoot(root: string, spaceName: string): string {
  return path.join(kbLocalDataDir(root), 'space-config', spaceConfigDirName(spaceName), 'config.json');
}

function deleteSpaceConfigForRoot(root: string, spaceName: string): void {
  fs.rmSync(path.dirname(spaceConfigPathForRoot(root, spaceName)), { recursive: true, force: true });
}

function cleanupOldMigrationStages(stash: string, maxAgeMs = MIGRATION_STAGE_MAX_AGE_MS): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stash, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('migration-stage-') && !entry.name.startsWith('migration-backup-')) continue;
    const full = path.join(stash, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs <= cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function writeSpaceConfigFileAtomic(file: string, cfg: SpaceConfigFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.config.json.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function legacySpaceConfigPath(spaceName: string): string {
  return path.join(getKbRoot(), spaceName, '.stashbase', 'config.json');
}

function hasSpaceConfigEntries(cfg: SpaceConfigFile): boolean {
  return Object.keys(cfg.mcpServers ?? {}).length > 0;
}

function migrateLegacySpaceConfig(spaceName: string): SpaceConfigFile {
  const legacy = legacySpaceConfigPath(spaceName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  } catch {
    return {};
  }
  const cfg = sanitizeSpaceConfig(parsed);
  try {
    if (hasSpaceConfigEntries(cfg)) {
      writeSpaceConfig(spaceName, cfg);
    }
    fs.rmSync(legacy, { force: true });
    log.info(`migrated space config for "${spaceName}" out of the space folder`);
  } catch (err: unknown) {
    log.warn(`failed to migrate legacy space config for "${spaceName}": ${errorMessage(err)}`);
  }
  return cfg;
}

export function ensureSpaceMetadata(spaceRoot: string): void {
  const stash = path.join(spaceRoot, '.stashbase');
  fs.mkdirSync(stash, { recursive: true });
  ensureSpaceStashbaseIgnore(stash);
  // Auto-create an **empty** `<spaceRoot>/STASHBASE.md` by default
  // (user request, reversing the earlier "opt-in only" stance). Empty =
  // 0-byte on purpose: zero-byte notes are never indexed (see
  // `files.ts` FileEntry.size), so this adds no search noise and writes
  // no content the user didn't ask for — it's just a placeholder the
  // user or an agent fills in when the space needs its own rules. It's
  // reachable from the KbPanel per-space row and shows in the tree
  // as an empty file. Mirrors `ensureKbMetadata` for the KB root.
  const rules = path.join(spaceRoot, 'STASHBASE.md');
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, '', 'utf8');
  }
}

function ensureSpaceStashbaseIgnore(stash: string): void {
  const ignore = path.join(stash, '.gitignore');
  const ignoreEntries = [
    'config.json',
    'store.nosync/',
    'store/',
    'mfs/',
    'cache/',
    'state.db',
    'state.db-*',
  ];
  const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = ignoreEntries.filter((entry) => !existingLines.has(entry));
  if (missing.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ignore, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
  }
}

function ensureKbMetadata(root: string): void {
  const stash = path.join(root, '.stashbase');
  fs.mkdirSync(stash, { recursive: true });
  const ignore = path.join(stash, '.gitignore');
  const ignoreEntries = [
    'store.nosync/',
    'store/',
    'mfs/',
    'cache/',
    'state.db',
    'state.db-*',
    'pdf-status.json',
    'pdf-status.json.migrated',
  ];
  const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = ignoreEntries.filter((entry) => !existingLines.has(entry));
  if (missing.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ignore, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8');
  }
  const rules = path.join(root, 'STASHBASE.md');
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, DEFAULT_KB_RULES, 'utf8');
  }
}

/** Seed contents for the KB-level `STASHBASE.md`. This is the user's place
 *  for knowledge-base-specific rules — assistants read it via the `kb_info`
 *  MCP tool and follow it. The universal agent contract (use your own
 *  filesystem tools for CRUD, call `reindex` after writes, mark generated
 *  files with `generated_by: stashbase-agent`) is delivered separately via
 *  the MCP server's `instructions`, so this file stays short and KB-specific
 *  rather than duplicating it. */
const DEFAULT_KB_RULES = `# StashBase Rules

Maintenance rules for AI assistants working in this knowledge base. Write
whatever is specific to YOUR library here — how notes should be organized,
naming conventions, what to summarize, what to leave untouched. Assistants
read this file via the \`kb_info\` tool and follow it.

(Empty by default — add your rules below.)
`;

// ---------- API key (global) ----------

/** Returns the user's stored OpenAI key, or undefined if none. */
