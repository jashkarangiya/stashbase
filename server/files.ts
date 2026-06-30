/**
 * Folder filesystem layer. The "folder" is the currently open folder of
 * note files (`.md`, `.html`) with arbitrary nested subfolders. All
 * public functions accept a folder-relative POSIX path like
 * `topic/note.md` and the layer is responsible for keeping operations
 * inside the folder root.
 *
 * Format-aware bits (HTML viewer prep) live in html.ts; chunking +
 * embedding live in the Python MFS sidecar — this module only deals
 * with on-disk presence and identifies a file's format by suffix.
 *
 * The indexer (server/indexer.ts) keys on the same folder-relative POSIX
 * path produced here, so the two layers reconcile by string equality.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { onSwitch, requireCurrentFolder } from './folder.ts';
import { decodeEntities } from './html.ts';
import { errorCode, errorMessage, logger } from './log.ts';

const log = logger('files');
import { detectFormat, detectViewerFormat, isDerivedNoteName, isImageFile, matchNoteStem, NOTE_EXTS, type FileFormat, type ViewerFormat } from './format.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName, shouldIndexFilePath } from './indexable.ts';

export { detectFormat, type FileFormat } from './format.ts';

/** Resolve the current folder root every time we touch the FS — the user
 *  can switch folders at runtime from the welcome screen, so caching the
 *  path at module load would silently keep writing to the old folder. */
function folderRoot(): string {
  return requireCurrentFolder();
}

/** Basename of the currently-open folder. The web UI shows this as
 *  the folder label at the top of the sidebar. */
export function getCurrentFolderBasename(): string {
  return path.basename(folderRoot());
}

/** Validate + normalize a folder-relative path. Allows `/`-separated
 *  subfolders but rejects:
 *    - absolute paths (`/foo`, `C:\…`)
 *    - parent-traversal segments (`..`, `.`)
 *    - control chars, quotes (LanceDB WHERE filters break on quotes)
 *  Returns the normalized POSIX path. */
/** Quietly transform a user-supplied filename so it survives writing
 *  to disk on any sane filesystem. Used at create / rename time only —
 *  reads still pass through `safePath` verbatim, so folders imported
 *  from other tools that already have `:` in filenames
 *  keep working.
 *
 *  - Replaces Windows / FAT32 / exFAT reserved chars (`: ? * < > | \`)
 *    with `-`. This is what breaks Dropbox / iCloud / git on Windows.
 *  - Normalises Unicode to NFC — HFS+ stores filenames decomposed
 *    (NFD), APFS uses precomposed (NFC); without normalisation the same
 *    Chinese title can show up as two different files when the folder
 *    moves between disks.
 *
 *  Slashes between path segments are preserved (so nested folders stay
 *  nested); sanitisation is applied per-segment. */
export function sanitizeFilename(name: string): string {
  return name
    .split('/')
    .map((seg) => seg.replace(/[:?*<>|\\]/g, '-'))
    .join('/')
    .normalize('NFC');
}

function safePath(rel: string): string {
  if (typeof rel !== 'string') throw new Error('path required');
  let norm = rel.replace(/\\/g, '/').replace(/\/+/g, '/');
  norm = norm.replace(/^\/+|\/+$/g, '');
  if (!norm) throw new Error('empty path');
  if (/[\x00-\x1f'"]/.test(norm)) {
    throw new Error('invalid path (control chars / quotes not allowed)');
  }
  for (const seg of norm.split('/')) {
    if (seg === '..' || seg === '.') throw new Error('invalid path segment');
  }
  return norm;
}

/** Resolve relative-to-folder path to an absolute filesystem path AND
 *  defend against any edge case where the result escapes the folder root. */
function resolveSafe(rel: string): string {
  const root = folderRoot();
  const safe = safePath(rel);
  const full = path.join(root, safe);
  const back = path.relative(root, full);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error('path escapes folder');
  }
  return full;
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realFolderRoot(): string {
  return fs.realpathSync.native(folderRoot());
}

function assertRealPathInsideFolder(absPath: string, label = 'path'): void {
  const real = fs.realpathSync.native(absPath);
  if (!isPathInsideOrSame(realFolderRoot(), real)) {
    throw new Error(`${label} escapes folder through symlink`);
  }
}

function assertCreatablePathInsideFolder(absPath: string, label = 'path'): void {
  const root = folderRoot();
  const rootReal = realFolderRoot();
  let probe = path.resolve(path.dirname(absPath));
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeRel = path.relative(root, probe);
  if (probeRel.startsWith('..') || path.isAbsolute(probeRel)) {
    throw new Error(`${label} escapes folder`);
  }
  const probeReal = fs.realpathSync.native(probe);
  if (!isPathInsideOrSame(rootReal, probeReal)) {
    throw new Error(`${label} escapes folder through symlink`);
  }
}

export function saveText(relPath: string, content: string): void {
  saveBytes(relPath, Buffer.from(content, 'utf8'));
}

export function fileVersion(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try {
    assertRealPathInsideFolder(target);
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Write raw bytes (e.g. images / css / fonts that arrive alongside
 *  an HTML bundle on drag-import). Same atomic write-then-rename as
 *  saveText so partial writes don't leave a half-baked file in the
 *  folder. */
export function saveBytes(relPath: string, bytes: Buffer): void {
  const target = resolveSafe(relPath);
  assertCreatablePathInsideFolder(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertCreatablePathInsideFolder(target);
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Exclusive-create variant: returns false if the file already exists
 *  (POSIX O_EXCL via `wx` flag). Used by `+ new file` so concurrent
 *  clicks can't race-pick the same `untitled-N.md`. Creates intermediate
 *  directories if needed. */
export function createTextExclusive(relPath: string, content: string): boolean {
  const target = resolveSafe(relPath);
  assertCreatablePathInsideFolder(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertCreatablePathInsideFolder(target);
  try {
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/** Atomic in-place rename / move. Same FS only. Creates the target's
 *  parent dirs as needed (moving across folders works). */
export function renameOnDisk(oldRel: string, newRel: string): void {
  const o = resolveSafe(oldRel);
  const n = resolveSafe(newRel);
  if (!fs.existsSync(o) || !fs.statSync(o).isFile()) {
    throw new Error('source file not found');
  }
  assertRealPathInsideFolder(o, 'source file');
  assertCreatablePathInsideFolder(n, 'target file');
  if (fs.existsSync(n)) {
    throw new Error('target already exists');
  }
  fs.mkdirSync(path.dirname(n), { recursive: true });
  assertCreatablePathInsideFolder(n, 'target file');
  fs.renameSync(o, n);
  // Notes carry an implicit "<stem>_files/" attachment bundle (browser
  // "Save Page As Complete" output for HTML, paste/drag image targets
  // for both formats). When the note itself is renamed, keep the
  // bundle in lockstep so the iframe's relative URLs stay resolvable.
  renameBundleSibling(oldRel, newRel);
  // Legacy cleanup: older builds kept PDF/image derived artifacts as hidden
  // siblings. Current AppData-derived artifacts are handled by the route layer
  // after the source path changes.
  if (/\.pdf$/i.test(oldRel) || isImageFile(oldRel)) {
    renameDerivedArtifactsForSource(oldRel, newRel);
  }
}

/** Resolve a folder-relative path to an absolute filesystem path for
 *  asset serving (images, css, fonts referenced from an HTML iframe).
 *  Returns null if the path resolves outside the folder, doesn't exist,
 *  or isn't a regular file. Safe to pass to `fs.createReadStream`. */
export function resolveAsset(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try {
    assertRealPathInsideFolder(target);
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
  } catch { return null; }
  return target;
}

export function readText(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try {
    assertRealPathInsideFolder(target);
    return fs.readFileSync(target, 'utf8');
  } catch { return null; }
}

/** True if a file or directory exists at the folder-relative path. */
export function pathExists(relPath: string): boolean {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return false; }
  try { assertRealPathInsideFolder(target); fs.statSync(target); return true; } catch { return false; }
}

/** Resolve to an absolute path if anything exists at the folder-relative
 *  location (file OR directory). Used by the reveal-in-OS route, which
 *  needs to accept both files and folders. */
export function resolveExisting(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try { assertRealPathInsideFolder(target); fs.statSync(target); return target; } catch { return null; }
}

/** Delete a file at the given folder-relative path. Returns false only
 *  when the file genuinely isn't there (ENOENT) — every other failure
 *  throws so the route can surface a real error instead of silently
 *  reporting success while the file stays on disk. */
export function deleteFile(relPath: string): boolean {
  const target = resolveSafe(relPath);
  let removed = false;
  try {
    if (!fs.existsSync(target)) return false;
    assertRealPathInsideFolder(target, 'file');
    fs.unlinkSync(target);
    removed = true;
  } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
  if (removed) {
    // Tear down the note's bundle (if any) so we don't leave an orphan
    // `<stem>_files/` behind. Best-effort: a missing bundle is fine.
    deleteBundleSibling(relPath);
    // Deleting a `paper.pdf` also tears down legacy dot-prefixed sibling
    // artifacts from older builds. Current AppData-derived artifacts are
    // cleaned by the route layer with the absolute source path.
    if (/\.pdf$/i.test(relPath)) deleteDerivedArtifactsForSource(relPath);
    // Same story for an image's legacy OCR sibling note.
    else if (isImageFile(relPath)) deleteDerivedArtifactsForSource(relPath);
  }
  return removed;
}

/** Map a note's folder-relative path to its `<stem>_files/` sibling
 *  bundle dir. Returns null when the path isn't a recognised note. */
function bundleDirSibling(noteRel: string): string | null {
  const m = matchNoteStem(path.posix.basename(noteRel));
  if (!m) return null;
  const dir = path.posix.dirname(noteRel);
  const bundle = `${m.stem}_files`;
  return dir === '.' ? bundle : `${dir}/${bundle}`;
}

function renameBundleSibling(oldNoteRel: string, newNoteRel: string): void {
  const oldBundle = bundleDirSibling(oldNoteRel);
  const newBundle = bundleDirSibling(newNoteRel);
  if (!oldBundle || !newBundle || oldBundle === newBundle) return;
  let oldAbs: string;
  let newAbs: string;
  try { oldAbs = resolveSafe(oldBundle); newAbs = resolveSafe(newBundle); }
  catch { return; }
  try {
    if (!fs.statSync(oldAbs).isDirectory()) return;
  } catch { return; /* no bundle to follow */ }
  if (fs.existsSync(newAbs)) return; // target taken — leave alone, surface as orphan
  fs.renameSync(oldAbs, newAbs);
}

function deleteBundleSibling(noteRel: string): void {
  const bundle = bundleDirSibling(noteRel);
  if (!bundle) return;
  let abs: string;
  try { abs = resolveSafe(bundle); } catch { return; }
  try {
    if (fs.statSync(abs).isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch { /* no bundle — fine */ }
}

export interface DerivedArtifacts {
  notes: string[];
  bundles: string[];
}

/** Legacy sibling-derived artifacts for a PDF/image source. Current derived
 *  Markdown lives in AppData (`derived-store.ts`); these names are kept only
 *  to clean up older on-disk artifacts and stale index rows. */
export function derivedArtifactsForSource(relPath: string): DerivedArtifacts {
  const base = path.posix.basename(relPath);
  const parent = path.posix.dirname(relPath);
  const join = (name: string) => (parent === '.' ? name : `${parent}/${name}`);
  const notes: string[] = [];
  const bundles: string[] = [];
  const addNote = (name: string) => {
    if (!notes.includes(name)) notes.push(name);
  };
  const addBundle = (name: string) => {
    if (!bundles.includes(name)) bundles.push(name);
  };

  if (/\.pdf$/i.test(base)) {
    const stem = base.replace(/\.pdf$/i, '');
    for (const sourceBase of [base, stem]) {
      if (!sourceBase) continue;
      for (const ext of NOTE_EXTS) addNote(join(`.${sourceBase}.${ext}`));
      addBundle(join(`.${sourceBase}_files`));
    }
  } else if (isImageFile(base)) {
    const stem = base.replace(/\.[^.]+$/, '');
    for (const sourceBase of [base, stem]) {
      if (!sourceBase) continue;
      addNote(join(`.${sourceBase}.md`));
      addNote(join(`.${sourceBase}.markdown`));
    }
  }

  return { notes, bundles };
}

/** Tear down a source file's legacy app-derived siblings. Best-effort: missing
 *  artifacts are fine, but permission/IO failures are logged so hidden
 *  stale conversion output is diagnosable. */
function deleteDerivedArtifactsForSource(sourceRel: string): void {
  const artifacts = derivedArtifactsForSource(sourceRel);
  for (const rel of artifacts.notes) {
    let abs: string;
    try { abs = resolveSafe(rel); } catch { continue; }
    try { fs.unlinkSync(abs); } catch (err: any) {
      if (errorCode(err) !== 'ENOENT') {
        log.warn(`failed to unlink derived ${rel}: ${errorMessage(err)}`);
      }
    }
  }
  for (const rel of artifacts.bundles) {
    let abs: string;
    try { abs = resolveSafe(rel); } catch { continue; }
    try {
      if (fs.statSync(abs).isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch { /* no bundle — fine */ }
  }
  deleteDerivedScratchBundlesForSource(sourceRel);
}

function renameDerivedArtifactsForSource(oldSourceRel: string, newSourceRel: string): void {
  const oldArtifacts = derivedArtifactsForSource(oldSourceRel);
  const newArtifacts = derivedArtifactsForSource(newSourceRel);
  renameFirstExistingArtifact(oldArtifacts.notes, newArtifacts.notes[0], 'file');
  renameFirstExistingArtifact(oldArtifacts.bundles, newArtifacts.bundles[0], 'dir');
}

function renameFirstExistingArtifact(oldRels: string[], newRel: string | undefined, kind: 'file' | 'dir'): void {
  let moved = false;
  for (const oldRel of oldRels) {
    let oldAbs: string;
    try { oldAbs = resolveSafe(oldRel); } catch { continue; }
    if (!fs.existsSync(oldAbs)) continue;
    if (!moved && newRel) {
      let newAbs: string;
      try { newAbs = resolveSafe(newRel); } catch { continue; }
      try {
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        // Target source was just claimed non-existent, so a matching
        // hidden target artifact can only be stale app output. Replace it
        // with the artifact that belongs to the file being renamed.
        fs.rmSync(newAbs, { recursive: kind === 'dir', force: true });
        fs.renameSync(oldAbs, newAbs);
        moved = true;
        continue;
      } catch (err: unknown) {
        log.warn(`failed to rename derived ${oldRel} -> ${newRel}: ${errorMessage(err)}`);
      }
    }
    try {
      fs.rmSync(oldAbs, { recursive: kind === 'dir', force: true });
    } catch (err: unknown) {
      log.warn(`failed to remove stale derived ${oldRel}: ${errorMessage(err)}`);
    }
  }
}

/** Create a (possibly nested) folder inside the folder. Returns false if
 *  the folder already exists, throws on other errors. */
export function createFolder(relPath: string): boolean {
  const target = resolveSafe(relPath);
  if (fs.existsSync(target)) return false;
  assertCreatablePathInsideFolder(target, 'folder');
  fs.mkdirSync(target, { recursive: true });
  assertRealPathInsideFolder(target, 'folder');
  return true;
}

/** Rename a folder in place. The PATCH route handles the index
 *  update separately (see Indexer.renamePathPrefix); this function
 *  only moves the directory on disk. Refuses to overwrite an existing
 *  target. */
export function renameFolder(oldRel: string, newRel: string): void {
  const oldAbs = resolveSafe(oldRel);
  const newAbs = resolveSafe(newRel);
  assertRealPathInsideFolder(oldAbs, 'source folder');
  assertCreatablePathInsideFolder(newAbs, 'target folder');
  if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isDirectory()) {
    throw new Error('source folder not found');
  }
  if (fs.existsSync(newAbs)) {
    throw new Error('target already exists');
  }
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  assertCreatablePathInsideFolder(newAbs, 'target folder');
  fs.renameSync(oldAbs, newAbs);
}

/** Delete a folder and everything inside it (recursively). The route
 *  layer already prompts the user for confirmation before calling
 *  this, so the "are you sure" guard lives in the UI rather than as
 *  a hard non-empty refusal at the FS level — that fence was painful
 *  with arxiv-style bundles where the user wants to delete an HTML
 *  paper + its `_files/` siblings in one shot. */
export function deleteFolder(relPath: string): boolean {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return false; }
  try {
    if (!fs.existsSync(target)) return false;
    assertRealPathInsideFolder(target, 'folder');
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export interface FileEntry {
  /** Folder-relative POSIX path (e.g. `topic/note.md`). */
  name: string;
  /** Widened to `ViewerFormat` to include viewable-only formats like
   *  `pdf` (which are surfaced in the sidebar but never indexed). */
  format: ViewerFormat;
  /** Raw file size on disk. Zero-byte notes are intentionally not indexed. */
  size: number;
  heading: string;
  snippet: string;
  imported_at: string;
}

interface FolderEntry {
  /** Folder-relative POSIX path (e.g. `topic/sub`). */
  path: string;
}

/** Per-file preview cache keyed by absolute path. Avoids re-reading
 *  every file on every `GET /api/files`. Invalidated by mtime: if the
 *  file's mtime hasn't moved, reuse the cached preview. Survives the
 *  lifetime of the process; bounded by the size of one opened folder. */
interface PreviewCacheEntry {
  mtimeMs: number;
  heading: string;
  snippet: string;
  imported_at: string;
}
const previewCache = new Map<string, PreviewCacheEntry>();

// Drop preview entries for the previous folder when the user opens a
// new one — absolute paths from folder A never overlap with folder B, so
// without this the cache grows monotonically with every folder the user
// visits in a session. Registered at module load.
onSwitch(() => previewCache.clear());

/** Recursive walk of the folder. Returns every recognised note file with
 *  its relative path, format, first-heading preview, and disk mtime.
 *  Sorted by full path so the tree renders in a stable order.
 *  Per-file preview is cached by mtime so large folders don't pay
 *  N × readFile on every sidebar refresh. */
export function listFiles(): FileEntry[] {
  const root = folderRoot();
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  walk(root, '', (rel, full, ent) => {
    if (!ent.isFile()) return;
    if (ent.name.endsWith('.tmp')) return;
    const format = detectViewerFormat(ent.name);
    if (!format) return;
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { return; }
    seen.add(full);

    const cached = previewCache.get(full);
    let entry: Pick<FileEntry, 'heading' | 'snippet' | 'imported_at'>;
    if (cached && cached.mtimeMs === st.mtimeMs) {
      entry = { heading: cached.heading, snippet: cached.snippet, imported_at: cached.imported_at };
    } else if (format === 'pdf' || format === 'image') {
      // No cheap server-side preview for binary files (PDF / image) —
      // generating a heading/snippet would require running pdfjs / OCR
      // in the server process (heavy). The sidebar already has the
      // filename to render; leave heading + snippet empty.
      const imported_at = st.mtime.toISOString();
      previewCache.set(full, { mtimeMs: st.mtimeMs, heading: '', snippet: '', imported_at });
      entry = { heading: '', snippet: '', imported_at };
    } else {
      let content: string;
      try { content = fs.readFileSync(full, 'utf8'); } catch { return; }
      const { heading, snippet } = preview(content, format);
      const imported_at = st.mtime.toISOString();
      previewCache.set(full, { mtimeMs: st.mtimeMs, heading, snippet, imported_at });
      entry = { heading, snippet, imported_at };
    }
    out.push({ name: rel, format, size: st.size, ...entry });
  });
  // Evict cache entries for files that no longer exist on disk —
  // otherwise renamed/deleted files accumulate forever.
  for (const key of previewCache.keys()) {
    if (!seen.has(key)) previewCache.delete(key);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** Every subfolder (recursive). Empty folders, intermediate folders,
 *  and folders that contain only files — all listed. Bundle dirs
 *  (`<stem>_files/` next to `<stem>.{md,html}`) are filtered out at
 *  the `walk` level, so they don't surface here either. */
export function listFolders(): FolderEntry[] {
  const root = folderRoot();
  const out: FolderEntry[] = [];
  walk(root, '', (rel, _full, ent) => {
    if (ent.isDirectory()) out.push({ path: rel });
  });
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Text files that should be carried through a folder-level index rename.
 *  Includes legacy hidden derived notes if they still exist on disk; current
 *  PDF/image AppData-derived notes are handled by conversion/index reconcile. */
export function listIndexableTextFilesUnder(relPrefix: string): Array<{ name: string; content: string }> {
  const safePrefix = safePath(relPrefix);
  const start = resolveSafe(safePrefix);
  assertRealPathInsideFolder(start, 'folder');
  const out: Array<{ name: string; content: string }> = [];
  walk(start, safePrefix, (rel, full, ent) => {
    if (!ent.isFile()) return;
    if (!detectFormat(ent.name)) return;
    if (!shouldIndexFilePath(rel)) return;
    try {
      out.push({ name: rel, content: fs.readFileSync(full, 'utf8') });
    } catch { /* unreadable files are skipped; sync can surface them later */ }
  }, { includeDerivedNotes: true });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** Dot-prefixed dir / file names we **always** hide from the sidebar.
 *
 *  Three categories:
 *    1. Legacy StashBase sidecars (`.stashbase/`). Current app-owned state
 *       lives in AppData, but old installs may still have sidecar files;
 *       keep them invisible so internal state never looks like user content.
 *    2. Huge, opaque, never-user-content: `.git/`. Cloned repos would
 *       otherwise flood the sidebar with object files.
 *    3. OS / iCloud junk: `.DS_Store`, `.Trashes`, `.fseventsd`, ...
 *
 *  Everything else with a `.` prefix passes through (`.claude/`,
 *  `.codex/`, `.vscode/`, `.github/`, `.obsidian/`, `.env`, ...) — it's
 *  the user's content; they get to see it. */
export const HIDDEN_DOT_DIRS = new Set<string>([
  '.stashbase',
  '.git',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.AppleDouble',
  '.TemporaryItems',
]);

function walk(
  dir: string,
  prefix: string,
  fn: (rel: string, full: string, ent: fs.Dirent) => void,
  opts: { includeDerivedNotes?: boolean } = {},
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  // Identify bundle dirs at this level — `<stem>_files/` where
  // `<stem>.{md,html}` lives alongside as a regular file. Those dirs
  // are attachments to a note, not standalone entries, so we hide
  // them entirely (don't fire the callback, don't recurse). The dir
  // is still reachable via `/asset/*` for the iframe; the sidebar
  // tree just sees the note as one row.
  const noteStems = new Set<string>();
  const legacyDerivedStems = new Set<string>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (m) noteStems.add(m[1]);
    const src = e.name.match(/^(.+)\.(pdf|png|jpe?g|webp)$/i);
    if (src) legacyDerivedStems.add(src[1]);
  }
  for (const e of entries) {
    if (isCloudPlaceholderName(e.name)) continue;
    // Hide only the load-bearing internals (`.stashbase`), git plumbing,
    // and OS junk — see `HIDDEN_DOT_DIRS`. Everything else with a `.`
    // prefix is the user's content (`.claude` / `.codex` / `.vscode` /
    // `.github` / `.obsidian`, …) and shows through.
    if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
    if (e.isDirectory() && isIndexExcludedDirName(e.name)) continue;
    // Always hide legacy dot-prefixed derived notes (`.<name>.md` /
    // `.html`) and their bundle dirs. Current PDF/image derived text
    // lives in AppData, but old artifacts can still exist in user
    // folders; an orphaned legacy file should stay hidden instead of
    // leaking into the sidebar and surprising users.
    //
    // Indexer / agent shell still see these files (the daemon's
    // scanner doesn't apply this rule); Cmd+P quick-open can target
    // them by exact path. The sidebar is the only surface that
    // hides them — and that's exactly what "dot-prefix = system
    // artifact" should mean.
    if (e.isFile() && e.name.startsWith('.')) {
      if (isDerivedScratchName(e.name)) continue;
      if (!opts.includeDerivedNotes && isDerivedNoteName(e.name)) continue;
      if (!opts.includeDerivedNotes && isLegacyDerivedNoteName(e.name, legacyDerivedStems)) continue;
    }
    if (e.isDirectory() && e.name.endsWith('_files')) {
      const stem = e.name.slice(0, -'_files'.length);
      // `<stem>_files/` siblings to user-authored notes (browser
      // "Save complete webpage" convention).
      if (noteStems.has(stem)) continue;
      // `.<sourceBasename>_files/` legacy dot-prefixed bundle — always hide.
      if (stem.startsWith('.')) continue;
    }
    // PDF extraction publishes the final dot-prefixed bundle only when
    // conversion succeeds, but long-running page batches create sibling
    // scratch dirs first. They are app-maintained artifacts too and must
    // not briefly surface as user folders while extraction is running.
    if (e.isDirectory() && isDerivedScratchName(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    fn(rel, full, e);
    if (e.isDirectory()) walk(full, rel, fn, opts);
  }
}

function isLegacyDerivedNoteName(name: string, sourceStems: Set<string>): boolean {
  const m = name.match(/^\.([^/]+)\.(md|markdown|html|htm)$/i);
  if (!m) return false;
  const stem = m[1];
  if (/\.(pdf|png|jpe?g|webp)$/i.test(stem)) return false;
  return sourceStems.has(stem);
}

function isDerivedScratchName(name: string): boolean {
  return /^\.\.?[^/]+_files\.(?:tmp|batch)-/i.test(name)
    || /^\.[^/]+\.pdf\.md\.tmp-/i.test(name)
    || /^\.[^/]+\.pdf\.md\.batches$/i.test(name);
}

function deleteDerivedScratchBundlesForSource(sourceRel: string): void {
  const base = path.posix.basename(sourceRel);
  if (!/\.pdf$/i.test(base)) return;
  const stem = base.replace(/\.pdf$/i, '');
  const sourceNames = [base, stem].filter(Boolean).map(escapeRegExp).join('|');
  const scratchRe = new RegExp(
    `^(?:\\.{1,2}(?:${sourceNames})_files\\.(?:tmp|batch)-.*|\\.${escapeRegExp(base)}\\.md\\.tmp-.*|\\.${escapeRegExp(base)}\\.md\\.batches)$`,
    'i',
  );
  let parentAbs: string;
  try { parentAbs = path.dirname(resolveSafe(sourceRel)); } catch { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parentAbs, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!scratchRe.test(ent.name)) continue;
    try {
      fs.rmSync(path.join(parentAbs, ent.name), { recursive: ent.isDirectory(), force: true });
    } catch (err: unknown) {
      log.warn(`failed to remove stale derived scratch ${ent.name}: ${errorMessage(err)}`);
    }
  }
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preview(
  content: string,
  format: FileFormat,
): { heading: string; snippet: string } {
  return format === 'md' ? previewMarkdown(content) : previewHtml(content);
}

function previewMarkdown(md: string): { heading: string; snippet: string } {
  let heading = '';
  let snippet = '';
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      if (!heading) heading = m[1];
      continue;
    }
    if (!snippet) {
      snippet = t.slice(0, 80);
      if (heading) break;
    }
    if (heading && snippet) break;
  }
  return { heading, snippet };
}

/** Cheap HTML preview without spinning up linkedom — file listing fires
 *  this on every file in the folder, so the regex path is the right
 *  tradeoff (the chunker does the proper DOM walk later). Strips tags
 *  and decodes the handful of entities that block readability. */
function previewHtml(html: string): { heading: string; snippet: string } {
  // Prefer <title> because templated pages often have static <title>
  // text but their <h1> is filled in at runtime by a script (which the
  // sandboxed preview happens to allow now, but the file scan that
  // builds the tree row runs without executing any JS). <h1> is a
  // fallback for static HTML where <title> may be absent or generic.
  let heading = '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) heading = decodeEntities(stripTags(tm[1])).trim();
  if (!heading) {
    const hm = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    if (hm) heading = decodeEntities(stripTags(hm[1])).trim();
  }

  // Snippet: first non-empty paragraph-ish text after stripping tags.
  // Drop <head>, <script>, <style> before stripping so we don't snippet
  // a stylesheet.
  const stripped = decodeEntities(
    stripTags(
      html
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, ''),
    ),
  );
  const snippet = stripped.replace(/\s+/g, ' ').trim().slice(0, 80);
  return { heading, snippet };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}
