/**
 * Indexing-related routes: hybrid search, manual full sync, and the
 * lightweight status poll the UI uses to grey out pending files.
 */
import express from 'express';
import fs from 'node:fs';
import { logger } from '../log.ts';
import {
  getCurrentFolder,
  exactMemberFolderRoot,
  resolveFolderRoot,
} from '../folder.ts';
import { getApiKey } from '../app-config.ts';
import { derivedPathsForPdf, maybeConvertPdf } from '../pdf.ts';
import { derivedNotePathForImage, maybeConvertImage } from '../image.ts';
import { derivedHtmlPathForDocx, maybeConvertDocx } from '../docx.ts';
import { isConversionPending, isConversionTextUnavailable, promoteConversion } from '../conversion.ts';
import { isDocxFile, isImageFile } from '../format.ts';
import { clearRecord, readAll as readConversionStatus } from '../conversion-status.ts';
import { clearIndexWarning, indexer, syncFolderNow } from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';
import { sendError } from '../http.ts';
import { filesystemPath } from '../filesystem-path.ts';
import { searchExtensionsForTypes } from '../format.ts';
import { isSearchTypeCategory, type SearchTypeCategory } from '../../shared/search-types.ts';
import { buildIndexStatus } from '../index-status.ts';
import { runKeywordSearch } from '../keyword-search.ts';
import {
  remapKeywordFilesForDisplay,
  remapSearchHitsForDisplay,
} from '../search-display.ts';

const log = logger('routes/indexing');

function parseFolderParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireMemberFolderRoot(ref: string): string {
  const root = resolveFolderRoot(ref);
  const memberRoot = exactMemberFolderRoot(root);
  if (!memberRoot) {
    const err = new Error('folder is not in your folders');
    (err as any).status = 404;
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  return memberRoot;
}

function requireRequestFolder(explicit?: string): { folderRoot: string } {
  if (explicit) {
    const root = requireMemberFolderRoot(explicit);
    return { folderRoot: root };
  }
  const folderRoot = getCurrentFolder();
  if (!folderRoot) {
    const err = new Error('no folder open');
    (err as any).status = 412;
    (err as any).code = 'NO_FOLDER';
    throw err;
  }
  return { folderRoot: filesystemPath.absolute(folderRoot) };
}

function sourcePathForAbs(absPath: string): string {
  return filesystemPath.absolute(absPath);
}

/** Resolve an explicit-folder request without allowing a symlink inside the
 * library folder to redirect preparation/extraction outside that folder. */
function requireExistingFileInFolder(folderRoot: string, rel: string): string {
  let abs: string;
  try {
    abs = filesystemPath.resolveUnder(folderRoot, rel);
  } catch (cause) {
    const err = new Error('path escapes folder', { cause });
    (err as any).status = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    clearRecord(sourcePathForAbs(abs));
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }

  try {
    abs = filesystemPath.resolveUnder(folderRoot, rel, { access: 'existing' });
  } catch (cause) {
    const err = new Error('path escapes folder through symlink', { cause });
    (err as any).status = 400;
    throw err;
  }
  if (!fs.statSync(abs).isFile()) {
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }
  return abs;
}

export function reprocessFileInFolder(relPath: string, folderName?: string): 'conversion' | 'index' {
  const rel = typeof relPath === 'string' ? relPath.trim() : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }

  const { folderRoot } = requireRequestFolder(folderName?.trim() || undefined);

  const abs = requireExistingFileInFolder(folderRoot, rel);
  const sourcePath = sourcePathForAbs(abs);
  const isPdf = /\.pdf$/i.test(rel);
  const isImage = isImageFile(rel);
  const isDocx = isDocxFile(rel);
  if (isConversionPending(sourcePath)) {
    // A manual retry promotes queued work; running work is non-preemptive.
    promoteConversion(sourcePath, 'interactive');
    return isPdf || isImage || isDocx ? 'conversion' : 'index';
  }

  clearRecord(sourcePath);
  if (isPdf) {
    const { notePath: staleNote, bundleDir: staleBundle } = derivedPathsForPdf(abs);
    try { fs.rmSync(staleNote, { force: true }); } catch { /* no stale to remove */ }
    try { fs.rmSync(staleBundle, { recursive: true, force: true }); } catch { /* no bundle */ }
    maybeConvertPdf(abs, { urgency: 'interactive' });
    return 'conversion';
  }
  if (isImage) {
    try { fs.rmSync(derivedNotePathForImage(abs), { force: true }); } catch { /* no stale */ }
    maybeConvertImage(abs, { urgency: 'interactive' });
    return 'conversion';
  }
  if (isDocx) {
    try { fs.rmSync(derivedHtmlPathForDocx(abs), { force: true }); } catch { /* no stale */ }
    maybeConvertDocx(abs, { urgency: 'interactive' });
    return 'conversion';
  }

  void syncFolderNow(folderRoot, { reason: `manual reprocess ${rel}` })
    .then((result) => {
      if (!result.cancelled) noteTreeChanged();
    })
    .catch((err: unknown) => {
      log.warn(`manual reprocess sync failed for ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  return 'index';
}

function prepareDocxInFolder(relPath: string, folderName?: string): void {
  const rel = typeof relPath === 'string' ? relPath.trim() : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }
  if (!isDocxFile(rel)) {
    const err = new Error('only DOCX files require interactive preview preparation');
    (err as any).status = 415;
    throw err;
  }

  const { folderRoot } = requireRequestFolder(folderName?.trim() || undefined);
  const abs = requireExistingFileInFolder(folderRoot, rel);
  const sourcePath = sourcePathForAbs(abs);
  if (!promoteConversion(sourcePath, 'interactive')) {
    maybeConvertDocx(abs, { urgency: 'interactive' });
  }
}

export function mount(app: express.Express): void {
  // Opening a DOCX is an explicit user gesture. Queue it in the light lane
  // at interactive priority (or promote the existing queued task).
  app.post('/api/files/prepare', (req, res) => {
    try {
      prepareDocxInFolder(req.body?.path, parseFolderParam(req.body?.folder));
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Trigger a folder sync manually — useful after external edits / file
  // moves. Returns the diff (added / removed / failed). Defaults to the
  // active folder; accepts `?folder=<name>` to sync any known folder
  // (powers MCP `reindex` so external agents can refresh an
  // unopened folder's index without the user opening it first).
  app.post('/api/sync', async (req, res) => {
    try {
      const explicit = parseFolderParam(req.query.folder);
      const { folderRoot } = requireRequestFolder(explicit);
      const result = await syncFolderNow(folderRoot, { reason: 'manual sync' });
      // `/api/sync` is also the explicit "something outside the app may
      // have changed" reconcile hook. Bump even when the semantic diff is
      // empty: no-key mode, non-indexable assets, empty dirs, and fast
      // no-op syncs still need the renderer to refresh its visible tree
      // and active read-only tab from disk.
      if (!result.cancelled) noteTreeChanged();
      res.json(result);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Hybrid (vector + BM25) search, scoped to the current open folder.
  // Cross-folder search lives behind the MCP `search_library` tool (different
  // mental model: "AI searching all my notes" vs "I'm searching the library
  // I'm currently editing"). Optional narrowing: `path_prefix` (folder-
  // relative subfolder, resolved escape-safe) and `types` (file-type
  // categories mapped to source extensions, applied daemon-side before
  // the final top-k cut).
  app.post('/api/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      if (!query) return res.status(400).json({ error: 'query required' });
      if (!getApiKey()) {
        return res.status(412).json({
          error: 'semantic search is disabled until you add an OpenAI API key',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
      const explicit = parseFolderParam(req.body?.folder);
      const { folderRoot } = requireRequestFolder(explicit);
      const types = parseSearchTypes(req.body?.types);
      if (types == null) return res.status(400).json({ error: 'unknown types value' });
      const prefixAbs = resolveScopePrefix(folderRoot, req.body?.path_prefix);
      if (prefixAbs === false) return res.status(400).json({ error: 'path_prefix must be a folder-relative subfolder' });
      const root = filesystemPath.absolute(folderRoot);
      const hits = await indexer.search(
        query, topK, root, prefixAbs, searchExtensionsForTypes(types) ?? undefined,
      );
      // Daemon hits arrive as absolute paths; translate fileName back to
      // folder-relative for the sidebar (which only knows the current
      // folder). Then `displayPathForHit` rewrites a derived note to its
      // source PDF/image (or drops an orphan) so a hidden `.md` never
      // shows — PdfPreview/ImagePreview pick up the chunk text from
      // pendingHighlight and jump to the matching passage.
      const out = remapSearchHitsForDisplay(
        hits
          .filter((hit) => !isConversionTextUnavailable(hit.fileName))
          .map((h) => {
            const rel = filesystemPath.relative(root, h.fileName);
            return rel == null ? null : { ...h, fileName: rel };
          })
          .filter((h): h is NonNullable<typeof h> => h !== null),
        folderRoot,
      );
      res.json({ hits: out });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Keyword (substring / regex) search via ripgrep, scoped to the
  // active folder directory. Bypasses the daemon and the index — useful
  // for finding specific tokens (function names, exact phrases) that
  // semantic search blurs out. Defaults to smart-case, restricts to
  // markdown / HTML (the only formats we index anyway), caps per-file
  // and total match counts so a generic query can't OOM the renderer.
  app.get('/api/keyword-search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!query) return res.status(400).json({ error: 'q required' });
      const explicit = parseFolderParam(req.query.folder);
      const { folderRoot: folderDir } = requireRequestFolder(explicit);
      const caseStrict = req.query.case_strict === '1' || req.query.case_strict === 'true';
      const wholeWord = req.query.whole_word === '1' || req.query.whole_word === 'true';
      const types = parseSearchTypes(
        typeof req.query.types === 'string' && req.query.types
          ? req.query.types.split(',')
          : undefined,
      );
      if (types == null) return res.status(400).json({ error: 'unknown types value' });
      const rawPrefix = typeof req.query.path_prefix === 'string' ? req.query.path_prefix : undefined;
      const prefixAbs = resolveScopePrefix(folderDir, rawPrefix);
      if (prefixAbs === false) return res.status(400).json({ error: 'path_prefix must be a folder-relative subfolder' });
      const result = await runKeywordSearch(query, folderDir, {
        caseStrict,
        wholeWord,
        pathPrefix: prefixAbs ? (filesystemPath.relative(filesystemPath.absolute(folderDir), prefixAbs) ?? undefined) : undefined,
        types,
      });
      // ripgrep's `*.md` glob may also match legacy hidden dot-prefixed
      // derived notes (`.paper.pdf.md` / `.shot.png.md`). Apply the same
      // remap-or-drop rule as the semantic routes so a hit's row points
      // at the openable source PDF / image (the matched OCR / converted
      // snippet stays) and an orphan note never surfaces.
      const remapped = remapKeywordFilesForDisplay(result.files, folderDir);
      res.json({ query, folder: folderDir, ...result, ...remapped });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Lightweight status — full `pending` list (not a sample) so the
  // sidebar can grey out the right rows. Scoped to the current folder.
  // `treeVersion` bumps on every external fs event, covering writes
  // from Claude Code / `touch` that wouldn't move `pending`
  // (non-indexable files, empty dirs). Also surfaces in-flight PDF
  // conversions for the conversion indicator.
  app.get('/api/index-status', async (req, res) => {
    try {
      const { folderRoot } = requireRequestFolder(parseFolderParam(req.query.folder));
      res.json(await buildIndexStatus(folderRoot));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/index-warning/dismiss', (req, res) => {
    try {
      const explicit = parseFolderParam(req.body?.folder);
      const { folderRoot } = requireRequestFolder(explicit);
      clearIndexWarning(folderRoot);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // File preparation status: full map, library-wide. Used by rich
  // viewers to render per-file failure banners (cheaper than polling
  // folder-scoped /api/index-status when the viewer just needs one
  // file's status).
  app.get('/api/pdf/status', (_req, res) => {
    try {
      res.json({ entries: readConversionStatus() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // File reprocess: take a folder-relative path and clear its durable
  // failure row. PDF/image/DOCX sources also clear stale final derived
  // artifacts and re-run extraction; directly readable files schedule a
  // reconcile so the index is rebuilt from source.
  app.post('/api/files/reprocess', (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const targetFolder = typeof req.body?.folder === 'string' && req.body.folder.trim()
        ? req.body.folder.trim()
        : undefined;
      const mode = reprocessFileInFolder(rel, targetFolder);
      res.json({ ok: true, mode });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

/** Validates a `types` request value into search categories. Absent →
 *  empty list (no filter); any unknown entry → null (caller 400s). */
function parseSearchTypes(raw: unknown): SearchTypeCategory[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: SearchTypeCategory[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry.trim() : entry;
    if (!isSearchTypeCategory(value)) return null;
    out.push(value);
  }
  return out;
}

/** Resolves a folder-relative subfolder scope to an absolute directory
 *  inside `folderRoot`. Absent/empty → undefined (folder-wide search);
 *  escaping, missing, or non-directory values → false (caller 400s). */
function resolveScopePrefix(folderRoot: string, raw: unknown): string | undefined | false {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') return false;
  const rel = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!rel) return undefined;
  try {
    const abs = filesystemPath.resolveUnder(folderRoot, rel, { access: 'existing' });
    return fs.statSync(abs).isDirectory() ? abs : false;
  } catch {
    return false;
  }
}
// ---------- recent-files walk ----------
