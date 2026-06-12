/**
 * Space filesystem layer. The "space" is the currently open folder of
 * note files (`.md`, `.html`) with arbitrary nested subfolders. All
 * public functions accept a space-relative POSIX path like
 * `topic/note.md` and the layer is responsible for keeping operations
 * inside the space root.
 *
 * Format-aware bits (HTML viewer prep) live in html.ts; chunking +
 * embedding live in the Python MFS sidecar — this module only deals
 * with on-disk presence and identifies a file's format by suffix.
 *
 * The indexer (server/indexer.ts) keys on the same space-relative POSIX
 * path produced here, so the two layers reconcile by string equality.
 */
import fs from 'node:fs';
import path from 'node:path';
import { onSwitch, requireCurrentSpace } from './space.ts';
import { decodeEntities } from './html.ts';
import { errorCode, errorMessage, logger } from './log.ts';

const log = logger('files');
import { detectFormat, detectViewerFormat, isDerivedNoteName, isImageFile, matchNoteStem, type FileFormat, type ViewerFormat } from './format.ts';
import { isIndexExcludedDirName } from './indexable.ts';

export { detectFormat, type FileFormat } from './format.ts';

/** Resolve the current space root every time we touch the FS — the user
 *  can switch spaces at runtime from the welcome screen, so caching the
 *  path at module load would silently keep writing to the old folder. */
function spaceRoot(): string {
  return requireCurrentSpace();
}

/** Basename of the currently-open space. The web UI shows this as
 *  the folder label at the top of the sidebar. */
export function getSpaceName(): string {
  return path.basename(spaceRoot());
}

/** Validate + normalize a space-relative path. Allows `/`-separated
 *  subfolders but rejects:
 *    - absolute paths (`/foo`, `C:\…`)
 *    - parent-traversal segments (`..`, `.`)
 *    - control chars, quotes (LanceDB WHERE filters break on quotes)
 *  Returns the normalized POSIX path. */
/** Quietly transform a user-supplied filename so it survives writing
 *  to disk on any sane filesystem. Used at create / rename time only —
 *  reads still pass through `safePath` verbatim, so vaults imported
 *  from other tools (Obsidian etc.) that already have `:` in filenames
 *  keep working.
 *
 *  - Replaces Windows / FAT32 / exFAT reserved chars (`: ? * < > | \`)
 *    with `-`. This is what breaks Dropbox / iCloud / git on Windows.
 *  - Normalises Unicode to NFC — HFS+ stores filenames decomposed
 *    (NFD), APFS uses precomposed (NFC); without normalisation the same
 *    Chinese title can show up as two different files when the vault
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

/** Resolve relative-to-space path to an absolute filesystem path AND
 *  defend against any edge case where the result escapes the space root. */
function resolveSafe(rel: string): string {
  const root = spaceRoot();
  const safe = safePath(rel);
  const full = path.join(root, safe);
  const back = path.relative(root, full);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error('path escapes space');
  }
  return full;
}

export function saveText(relPath: string, content: string): void {
  saveBytes(relPath, Buffer.from(content, 'utf8'));
}

/** Write raw bytes (e.g. images / css / fonts that arrive alongside
 *  an HTML bundle on drag-import). Same atomic write-then-rename as
 *  saveText so partial writes don't leave a half-baked file in the
 *  space. */
export function saveBytes(relPath: string, bytes: Buffer): void {
  const target = resolveSafe(relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
}

/** Exclusive-create variant: returns false if the file already exists
 *  (POSIX O_EXCL via `wx` flag). Used by `+ new file` so concurrent
 *  clicks can't race-pick the same `untitled-N.md`. Creates intermediate
 *  directories if needed. */
export function createTextExclusive(relPath: string, content: string): boolean {
  const target = resolveSafe(relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
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
  fs.mkdirSync(path.dirname(n), { recursive: true });
  fs.renameSync(o, n);
  // Notes carry an implicit "<stem>_files/" attachment bundle (browser
  // "Save Page As Complete" output for HTML, paste/drag image targets
  // for both formats). When the note itself is renamed, keep the
  // bundle in lockstep so the iframe's relative URLs stay resolvable.
  renameBundleSibling(oldRel, newRel);
}

/** Resolve a space-relative path to an absolute filesystem path for
 *  asset serving (images, css, fonts referenced from an HTML iframe).
 *  Returns null if the path resolves outside the space, doesn't exist,
 *  or isn't a regular file. Safe to pass to `fs.createReadStream`. */
export function resolveAsset(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
  } catch { return null; }
  return target;
}

export function readText(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try { return fs.readFileSync(target, 'utf8'); } catch { return null; }
}

/** True if a file or directory exists at the space-relative path. */
export function pathExists(relPath: string): boolean {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return false; }
  try { fs.statSync(target); return true; } catch { return false; }
}

/** Resolve to an absolute path if anything exists at the space-relative
 *  location (file OR directory). Used by the reveal-in-OS route, which
 *  needs to accept both files and folders. */
export function resolveExisting(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return null; }
  try { fs.statSync(target); return target; } catch { return null; }
}

/** Delete a file at the given space-relative path. Returns false only
 *  when the file genuinely isn't there (ENOENT) — every other failure
 *  throws so the route can surface a real error instead of silently
 *  reporting success while the file stays on disk. */
export function deleteFile(relPath: string): boolean {
  const target = resolveSafe(relPath);
  let removed = false;
  try {
    fs.unlinkSync(target);
    removed = true;
  } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
  if (removed) {
    // Tear down the note's bundle (if any) so we don't leave an orphan
    // `<stem>_files/` behind. Best-effort: a missing bundle is fine.
    deleteBundleSibling(relPath);
    // Deleting a `paper.pdf` also tears down the dot-prefixed app-
    // derived sibling note (`.paper.pdf.md` / `.paper.html`) and its
    // bundle (`.paper.pdf_files/`). Without this, those orphaned files
    // would re-appear in the sidebar (the sibling-bound hide rule in
    // `walk()` depends on the parent PDF still being there).
    if (/\.pdf$/i.test(relPath)) deletePdfDerivedSiblings(relPath);
    // Same story for an image's OCR sibling note (`.shot.png.md`) — no
    // bundle, just the single derived note.
    else if (isImageFile(relPath)) deleteImageDerivedNote(relPath);
  }
  return removed;
}

/** Map a note's space-relative path to its `<stem>_files/` sibling
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

/** Tear down a PDF's app-derived siblings: the dot-prefixed
 *  `.<sourceBasename>.md` (or `.html`) note + `.<sourceBasename>_files/` bundle. Called
 *  from `deleteFile` whenever a `.pdf` goes away — otherwise the
 *  sibling-bound hide rule in `walk()` would un-hide these orphans
 *  on the next sidebar refresh. Best-effort: missing siblings are
 *  fine. */
function deletePdfDerivedSiblings(pdfRel: string): void {
  const base = path.posix.basename(pdfRel);
  const m = base.match(/^(.+)\.pdf$/i);
  if (!m) return;
  const stem = m[1];
  const parent = path.posix.dirname(pdfRel);
  const join = (name: string) => (parent === '.' ? name : `${parent}/${name}`);
  // Notes (md / html — md is the current default, html stays covered
  // for spaces that still have legacy derived html sitting around).
  for (const ext of ['md', 'markdown', 'html', 'htm']) {
    const rel = join(`.${stem}.${ext}`);
    let abs: string;
    try { abs = resolveSafe(rel); } catch { continue; }
    try { fs.unlinkSync(abs); } catch (err: any) {
      if (errorCode(err) !== 'ENOENT') {
        log.warn(`failed to unlink derived ${rel}: ${errorMessage(err)}`);
      }
    }
  }
  // Bundle dir
  const bundleRel = join(`.${stem}_files`);
  let bundleAbs: string;
  try { bundleAbs = resolveSafe(bundleRel); } catch { return; }
  try {
    if (fs.statSync(bundleAbs).isDirectory()) {
      fs.rmSync(bundleAbs, { recursive: true, force: true });
    }
  } catch { /* no bundle — fine */ }
}

/** Tear down an image's app-derived OCR note (`.<sourceBasename>.md`). Called
 *  from `deleteFile` whenever an image goes away — otherwise the
 *  orphaned dot-prefixed note would un-hide in the sidebar (the
 *  sibling-bound hide rule depends on the parent image still being
 *  there). Images have no `_files/` bundle, so this is note-only.
 *  Best-effort: a missing note is fine. */
function deleteImageDerivedNote(imageRel: string): void {
  const base = path.posix.basename(imageRel);
  const m = base.match(/^(.+)\.[^.]+$/);
  if (!m) return;
  const stem = m[1];
  const parent = path.posix.dirname(imageRel);
  const rel = parent === '.' ? `.${stem}.md` : `${parent}/.${stem}.md`;
  let abs: string;
  try { abs = resolveSafe(rel); } catch { return; }
  try { fs.unlinkSync(abs); } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn(`failed to unlink derived ${rel}: ${errorMessage(err)}`);
    }
  }
}

/** Create a (possibly nested) folder inside the space. Returns false if
 *  the folder already exists, throws on other errors. */
export function createFolder(relPath: string): boolean {
  const target = resolveSafe(relPath);
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(target, { recursive: true });
  return true;
}

/** Rename a folder in place. The PATCH route handles the index
 *  update separately (see Indexer.renamePathPrefix); this function
 *  only moves the directory on disk. Refuses to overwrite an existing
 *  target. */
export function renameFolder(oldRel: string, newRel: string): void {
  const oldAbs = resolveSafe(oldRel);
  const newAbs = resolveSafe(newRel);
  if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isDirectory()) {
    throw new Error('source folder not found');
  }
  if (fs.existsSync(newAbs)) {
    throw new Error('target already exists');
  }
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
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
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export interface FileEntry {
  /** Space-relative POSIX path (e.g. `topic/note.md`). */
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

export interface FolderEntry {
  /** Space-relative POSIX path (e.g. `topic/sub`). */
  path: string;
}

/** Per-file preview cache keyed by absolute path. Avoids re-reading
 *  every file on every `GET /api/files`. Invalidated by mtime: if the
 *  file's mtime hasn't moved, reuse the cached preview. Survives the
 *  lifetime of the process; bounded by the size of one vault. */
interface PreviewCacheEntry {
  mtimeMs: number;
  heading: string;
  snippet: string;
  imported_at: string;
}
const previewCache = new Map<string, PreviewCacheEntry>();

// Drop preview entries for the previous space when the user opens a
// new one — absolute paths from space A never overlap with space B, so
// without this the cache grows monotonically with every space the user
// visits in a session. Registered at module load.
onSwitch(() => previewCache.clear());

/** Recursive walk of the space. Returns every recognised note file with
 *  its relative path, format, first-heading preview, and disk mtime.
 *  Sorted by full path so the tree renders in a stable order.
 *  Per-file preview is cached by mtime so large vaults don't pay
 *  N × readFile on every sidebar refresh. */
export function listFiles(): FileEntry[] {
  const root = spaceRoot();
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
  const root = spaceRoot();
  const out: FolderEntry[] = [];
  walk(root, '', (rel, _full, ent) => {
    if (ent.isDirectory()) out.push({ path: rel });
  });
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Dot-prefixed dir / file names we **always** hide from the sidebar.
 *
 *  Three categories:
 *    1. Our own internal storage (`.stashbase/` — milvus.db, per-space
 *       config, cache). User deleting / renaming it would corrupt the
 *       index, so we just keep it invisible.
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
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(.+)\.(md|markdown|html|htm|pdf)$/i);
    if (m) noteStems.add(m[1]);
  }
  for (const e of entries) {
    // Hide only the load-bearing internals (`.stashbase`), git plumbing,
    // and OS junk — see `HIDDEN_DOT_DIRS`. Everything else with a `.`
    // prefix is the user's content (`.claude` / `.codex` / `.vscode` /
    // `.github` / `.obsidian`, …) and shows through.
    if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
    if (e.isDirectory() && isIndexExcludedDirName(e.name)) continue;
    // Always hide app-derived dot-prefixed notes (`.<name>.md` /
    // `.html`) and their bundle dirs — these are PDF converter
    // outputs (or other future derived content). The unconditional
    // rule means an orphaned derived file (PDF got deleted out from
    // under it, conversion crashed mid-write, git checkout left it
    // stale) stays hidden too, instead of leaking into the sidebar
    // and surprising users.
    //
    // Indexer / agent shell still see these files (the daemon's
    // scanner doesn't apply this rule); Cmd+P quick-open can target
    // them by exact path. The sidebar is the only surface that
    // hides them — and that's exactly what "dot-prefix = system
    // artifact" should mean.
    if (e.isFile() && e.name.startsWith('.')) {
      if (isDerivedNoteName(e.name)) continue;
    }
    if (e.isDirectory() && e.name.endsWith('_files')) {
      const stem = e.name.slice(0, -'_files'.length);
      // `<stem>_files/` siblings to user-authored notes (browser
      // "Save complete webpage" convention).
      if (noteStems.has(stem)) continue;
      // `.<sourceBasename>_files/` dot-prefixed app-derived bundle — always hide.
      if (stem.startsWith('.')) continue;
    }
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    fn(rel, full, e);
    if (e.isDirectory()) walk(full, rel, fn);
  }
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
 *  this on every file in the space, so the regex path is the right
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
