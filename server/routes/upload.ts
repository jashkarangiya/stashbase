/**
 * Drop-zone / sidebar import route. Accepts multipart `files[]` with a
 * parallel `paths[]` array preserving the dropped folder layout, plus
 * an optional `dir` form field that scopes the import to a subfolder
 * of the active folder.
 *
 * Two non-obvious behaviours worth knowing about:
 *   1. A note `<stem>.{md,html}` and its iframe bundle `<stem>_files/`
 *      land as siblings at the drop target (NOT wrapped in `<stem>/`),
 *      matching how browsers' "Save Page As Complete" produces them.
 *   2. Stem collisions are renumbered (`stem-2.md`, `stem-2_files/`)
 *      across BOTH the note and its bundle in lockstep, so the iframe
 *      can still find its assets after the import.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectFormat,
  pathExists,
  sanitizeFilename,
} from '../files.ts';
import { isImageFile, isNoteName } from '../format.ts';
import { getApiKey } from '../app-config.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName } from '../indexable.ts';
import { errorMessage, logger } from '../log.ts';
import {
  getCurrentFolder,
  memberFolderRoots,
  resolveFolderRoot,
  runWithWindowId,
  toPosixAbs,
  WINDOW_ID_HEADER,
} from '../folder.ts';
import { maybeConvertImage } from '../image.ts';
import { maybeConvertPdf } from '../pdf.ts';
import { indexer } from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';

const log = logger('routes/upload');

// In-memory upload buffer. Bumped beyond the original 8 MB / 50-file
// limits to accommodate "Save Page As Complete" bundles (arxiv HTML
// pulls in dozens of figures + CSS) and large PDFs before the async
// extractor takes over.
const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;
const uploadParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 500 },
});

function resolveUploadFolder(explicitFolder: string): string {
  if (explicitFolder) {
    const root = resolveFolderRoot(explicitFolder);
    if (!memberFolderRoots().includes(root)) {
      const err = new Error('folder is not in your folders');
      (err as any).code = 'FOLDER_NOT_FOUND';
      throw err;
    }
    return root;
  }
  const current = getCurrentFolder();
  if (!current) {
    const err = new Error('no folder open');
    (err as any).code = 'NO_FOLDER';
    throw err;
  }
  return current;
}

export function mount(app: express.Express): void {
  app.post('/api/upload', (req, res, next) => {
    uploadParser.array('files', 500)(req, res, (err: unknown) => {
      if (err) {
        sendUploadError(res, err);
        return;
      }
      void (async () => {
        // Multer consumes the request body stream, and its callbacks run in the
        // connection-time async context — which drops the windowId that
        // `withWindowContext` stashed in AsyncLocalStorage. Without re-binding
        // it here, every folder-scoped lookup inside the handler
        // (getCurrentFolder, saveBytes → resolveSafe) falls back to
        // DEFAULT_WINDOW_ID and the upload fails with "no folder open" even
        // though the client sent the right window header. Re-establish the
        // context from the header before doing any per-window work.
        await runWithWindowId(req.header(WINDOW_ID_HEADER), () => handleUpload(req, res));
      })().catch(next);
    });
  });
}

function sendUploadError(res: express.Response, err: unknown): void {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `file is too large to upload (max ${Math.floor(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)} MB)`
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'too many files in one upload'
        : err.message;
    res.status(status).json({ error: message, code: err.code });
    return;
  }
  res.status(400).json({ error: errorMessage(err) });
}

function resolveInFolder(folderRoot: string, relPath: string): string {
  validateUploadPath(relPath);
  const full = path.join(folderRoot, relPath);
  const back = path.relative(folderRoot, full);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new Error('path escapes folder');
  return full;
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realFolderRoot(folderRoot: string): string {
  return fs.realpathSync.native(folderRoot);
}

function assertRealPathInsideFolder(folderRoot: string, absPath: string, label = 'path'): void {
  const real = fs.realpathSync.native(absPath);
  if (!isPathInsideOrSame(realFolderRoot(folderRoot), real)) {
    throw new Error(`${label} escapes folder through symlink`);
  }
}

function assertCreatablePathInsideFolder(folderRoot: string, absPath: string, label = 'path'): void {
  const rootReal = realFolderRoot(folderRoot);
  let probe = path.resolve(path.dirname(absPath));
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeRel = path.relative(folderRoot, probe);
  if (probeRel.startsWith('..') || path.isAbsolute(probeRel)) throw new Error(`${label} escapes folder`);
  const probeReal = fs.realpathSync.native(probe);
  if (!isPathInsideOrSame(rootReal, probeReal)) {
    throw new Error(`${label} escapes folder through symlink`);
  }
}

function pathExistsInFolder(folderRoot: string, relPath: string): boolean {
  try {
    const target = resolveInFolder(folderRoot, relPath);
    if (!fs.existsSync(target)) return false;
    assertRealPathInsideFolder(folderRoot, target);
    return true;
  } catch {
    return false;
  }
}

function saveBytesInFolder(folderRoot: string, relPath: string, bytes: Buffer): void {
  const target = resolveInFolder(folderRoot, relPath);
  assertCreatablePathInsideFolder(folderRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertCreatablePathInsideFolder(folderRoot, target);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

async function handleUpload(req: express.Request, res: express.Response): Promise<void> {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'no files' }); return; }
  const explicitFolder = typeof req.body?.folder === 'string' && req.body.folder.trim()
    ? req.body.folder.trim()
    : '';
  let folderAbs: string;
  try {
    folderAbs = resolveUploadFolder(explicitFolder);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'FOLDER_NOT_FOUND') {
      res.status(404).json({ error: 'folder not found', code: 'FOLDER_NOT_FOUND' });
      return;
    }
    if (code === 'NO_FOLDER') {
      res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
      return;
    }
    res.status(400).json({ error: errorMessage(err) });
    return;
  }
  const folderRoot = toPosixAbs(folderAbs);
  // Optional `dir` form field: folder-relative path of the folder to
  // drop the files into. Sanitised the same way we treat any other
  // write path so a stray `..` or absolute path can't escape the folder.
  let dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
  if (dir) dir = sanitizeFilename(dir).replace(/\/+$/, '');
  const prefix = dir ? dir + '/' : '';

  // Parallel `paths` array preserves the dropped folder layout —
  // see web `walkEntry`. Multer normalises a single value to a string
  // and ≥2 to an array; coerce to a string array.
  const rawPaths = req.body?.paths;
  const paths: string[] = Array.isArray(rawPaths)
    ? rawPaths.map(String)
    : typeof rawPaths === 'string' ? [rawPaths] : [];

  const finalNames = computeFinalNames(files, paths, prefix, (rel) => pathExistsInFolder(folderAbs, rel));

  const out: { file: string; error?: string }[] = [];
  const toIndex: { name: string; sourcePath: string; text: string }[] = [];
  const toConvertPdf: { abs: string; rel: string }[] = [];
  const toOcrImage: { abs: string; rel: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = finalNames[i];
    try {
      validateUploadPath(rawUploadPathFor(files, paths, i));
      validateUploadPath(name);
      // Always save bytes to disk — bundle assets (PNG / CSS / WOFF
      // shipped alongside an arxiv HTML) are needed by the iframe even
      // though they're not indexable. Only indexable formats go to
      // the indexer.
      saveBytesInFolder(folderAbs, name, f.buffer);
      out.push({ file: name });
      if (detectFormat(name)) {
        // Structured notes (Markdown / HTML) are saved and indexed
        // **exactly as dropped** — we never rewrite the user's file. Inline
        // `data:` resources stay inline (the preview renders them directly;
        // HTML's `analyzeHtml` flattens them out of the *indexed* text in
        // memory). This honours the "don't modify the opened folder" rule
        // now that any folder on disk can be opened in place.
        const text = f.buffer.toString('utf8');
        toIndex.push({ name, sourcePath: `${folderRoot}/${name}`, text });
      } else if (folderAbs && /\.pdf$/i.test(name)) {
        // PDFs run through the PyMuPDF pipeline so the
        // app gets AppData-derived Markdown + extracted assets, then pushes
        // the derived text into the index when semantic indexing is available.
        toConvertPdf.push({ abs: path.join(folderAbs, name), rel: name });
      } else if (folderAbs && isImageFile(name)) {
        // Images run through RapidOCR so any text in a screenshot /
        // photo becomes AppData-derived OCR Markdown for search.
        toOcrImage.push({ abs: path.join(folderAbs, name), rel: name });
      }
    } catch (err: unknown) {
      log.warn(`upload: save failed for ${name}: ${errorMessage(err)}`);
      out.push({ file: name, error: errorMessage(err) });
    }
  }
  if (out.some((x) => !x.error)) noteTreeChanged();
  res.json({ files: out });
  // Background indexing — don't await; the response has already been sent.
  if (getApiKey()) {
    (async () => {
      for (const { name, sourcePath, text } of toIndex) {
        try {
          await indexer.upsertFile(sourcePath, text);
        } catch (err: unknown) {
          log.warn(`upload: index failed for ${name}: ${errorMessage(err)}`);
        }
      }
    })();
  } else if (toIndex.length) {
    log.info(`upload: skipped indexing ${toIndex.length} file(s) because no OpenAI key is configured`);
  }
  // Kick off conversions fire-and-forget. They handle their own async
  // failures internally; guard only against a synchronous throw at
  // kickoff (the response is already sent, so it'd otherwise be an
  // unhandled error) — same discipline as the index loop above.
  for (const { abs, rel } of toConvertPdf) {
    try { maybeConvertPdf(abs); } catch (err: unknown) { log.warn(`upload: pdf convert kickoff failed for ${rel}: ${errorMessage(err)}`); }
  }
  for (const { abs, rel } of toOcrImage) {
    try { maybeConvertImage(abs); } catch (err: unknown) { log.warn(`upload: image OCR kickoff failed for ${rel}: ${errorMessage(err)}`); }
  }
}

/** Compute the on-disk paths for a batch up front so any top-level entry
 *  that would clash with an existing one gets a `-2` / `-3` suffix —
 *  a drag means "add this", so we keep both rather than silently
 *  overwriting (which `saveBytes` would otherwise do for non-note
 *  files). This applies to BOTH top-level files AND top-level folders:
 *  re-dropping the same folder lands a fresh `<folder>-2/` copy instead
 *  of overwriting the first in place — folder-nested paths previously
 *  fell through verbatim, so a second drop silently merged on top.
 *  Notes additionally reserve against their `<stem>_files/` bundle and
 *  carry it along when renamed. A renamed folder moves as a unit, so any
 *  bundle that lives *inside* it follows along untouched. */
export function validateUploadPath(relPath: string): void {
  const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error('upload path contains an invalid segment');
    if (isCloudPlaceholderName(seg)) {
      throw new Error('upload path points to an iCloud placeholder; download the file locally first');
    }
    if (seg === '.stashbase' || seg.startsWith('.stashbase-')) {
      throw new Error('upload path cannot write into .stashbase');
    }
    if (isIndexExcludedDirName(seg)) throw new Error(`upload path cannot include excluded directory "${seg}"`);
  }
}

function rawUploadPathFor(files: Express.Multer.File[], paths: string[], idx: number): string {
  const f = files[idx];
  return paths[idx] && paths[idx].length ? paths[idx] : f.originalname;
}

export function computeFinalNames(
  files: Express.Multer.File[],
  paths: string[],
  prefix: string,
  exists: (relPath: string) => boolean = pathExists,
): string[] {
  // Step 1: reserve a non-colliding name for every TOP-LEVEL file (any
  // type). "Top-level" = no folder separator (so it lives directly at
  // the drop target, alongside its `<stem>_files/` bundle if it's a
  // note). Bundle members (rel contains `/`) are handled in step 3.
  const reserved = new Set<string>();             // finalName (stem+ext) / dir name taken this batch
  const finalByIndex = new Map<number, string>(); // idx → final top-level name
  const noteStemRenames = new Map<string, string>(); // note origStem → finalStem (for bundles)
  const topLevelNoteStems = new Set<string>();    // stems of top-level notes (to spot their bundles)
  for (let i = 0; i < files.length; i++) {
    const rel = rawUploadPathFor(files, paths, i);
    if (rel.includes('/')) continue;
    const isNote = isNoteName(rel);
    const dot = rel.lastIndexOf('.');
    const origStem = dot > 0 ? rel.slice(0, dot) : rel;
    const ext = dot > 0 ? rel.slice(dot) : ''; // includes leading dot, '' if none
    if (isNote) topLevelNoteStems.add(origStem);
    let finalStem = origStem;
    let n = 2;
    while (
      exists(prefix + finalStem + ext)
      || reserved.has(finalStem + ext)
      || (isNote && exists(prefix + finalStem + '_files'))
    ) {
      finalStem = `${origStem}-${n}`;
      n++;
    }
    reserved.add(finalStem + ext);
    finalByIndex.set(i, finalStem + ext);
    if (isNote && finalStem !== origStem) noteStemRenames.set(origStem, finalStem);
  }
  // Step 2: renumber each distinct TOP-LEVEL folder that collides, as a
  // unit. A note's `<stem>_files/` bundle is NOT a folder here — it
  // tracks its note via `noteStemRenames` (step 3) — so skip those.
  const dirRenames = new Map<string, string>(); // origTopDir → finalTopDir
  const seenDirs = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const rel = rawUploadPathFor(files, paths, i);
    const dirEnd = rel.indexOf('/');
    if (dirEnd < 0) continue; // top-level file, handled above
    const top = rel.slice(0, dirEnd);
    if (seenDirs.has(top)) continue;
    seenDirs.add(top);
    const bm = top.match(/^(.+)_files$/);
    if (bm && topLevelNoteStems.has(bm[1])) continue; // a note bundle, not a folder
    let finalDir = top;
    let n = 2;
    while (exists(prefix + finalDir) || reserved.has(finalDir)) {
      finalDir = `${top}-${n}`;
      n++;
    }
    reserved.add(finalDir);
    if (finalDir !== top) dirRenames.set(top, finalDir);
  }
  // Step 3: rewrite every file's path. Top-level files use their
  // reserved final name; a renamed note's `<stem>_files/...` bundle
  // tracks the renumbered stem; everything under a renumbered folder
  // gets its first segment swapped; the rest stay verbatim.
  const finalNames = files.map((_, i) => {
    const rel = rawUploadPathFor(files, paths, i);
    const segments = rel.split('/');
    if (segments.length === 1) {
      return sanitizeFilename(prefix + (finalByIndex.get(i) ?? rel));
    }
    const top = segments[0];
    const bm = top.match(/^(.+)_files$/);
    if (bm && noteStemRenames.has(bm[1])) {
      segments[0] = noteStemRenames.get(bm[1])! + '_files';
      return sanitizeFilename(prefix + segments.join('/'));
    }
    if (dirRenames.has(top)) {
      segments[0] = dirRenames.get(top)!;
      return sanitizeFilename(prefix + segments.join('/'));
    }
    return sanitizeFilename(prefix + rel);
  });
  const used = new Set<string>();
  return finalNames.map((name) => reserveFinalPath(name, used, exists));
}

function reserveFinalPath(candidate: string, used: Set<string>, exists: (relPath: string) => boolean): string {
  if (!used.has(candidate) && !exists(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const slash = candidate.lastIndexOf('/');
  const dir = slash >= 0 ? candidate.slice(0, slash + 1) : '';
  const base = slash >= 0 ? candidate.slice(slash + 1) : candidate;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; ; n++) {
    const next = `${dir}${stem}-${n}${ext}`;
    if (!used.has(next) && !exists(next)) {
      used.add(next);
      return next;
    }
  }
}
