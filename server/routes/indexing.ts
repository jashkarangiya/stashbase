/**
 * Indexing-related routes: hybrid search, manual full sync, and the
 * lightweight status poll the UI uses to grey out pending files.
 */
import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { logger } from '../log.ts';
import {
  relInFolder,
  getCurrentFolder,
  memberFolderRoots,
  resolveFolderRoot,
  toPosixAbs,
} from '../folder.ts';
import { getApiKey } from '../app-config.ts';
import { hasNoExtractableText, isCloudPlaceholderName, isIndexExcludedDirName, shouldIndexFilePath } from '../indexable.ts';
import { derivedPathsForPdf, displayPathForHit, maybeConvertPdf } from '../pdf.ts';
import { derivedNotePathForImage, maybeConvertImage } from '../image.ts';
import { getInFlightConversions } from '../conversion.ts';
import { isImageFile } from '../format.ts';
import { clearRecord, isInFlight, listFailed, listInFlight, readAll as readConversionStatus, readProgress, type ConversionProgress } from '../conversion-status.ts';
import { getFsChangeCounter } from '../watcher.ts';
import { clearIndexWarning, getIndexWarning, indexer, syncFolderNow } from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';
import { sendError } from '../http.ts';
import { derivedNoteFor } from '../derived-store.ts';
import {
  remapKeywordFilesForDisplay,
  remapSearchHitsForDisplay,
  type KeywordHitFile,
  type KeywordMatch,
  type KeywordSearchResult,
} from '../search-display.ts';

const log = logger('routes/indexing');

function parseFolderParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireMemberFolderRoot(ref: string): string {
  const root = resolveFolderRoot(ref);
  if (!memberFolderRoots().includes(root)) {
    const err = new Error('folder is not in your folders');
    (err as any).status = 404;
    (err as any).code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  return root;
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
  return { folderRoot: toPosixAbs(folderRoot) };
}

function sourcePathForAbs(absPath: string): string {
  return toPosixAbs(absPath);
}

export function conversionFailuresForFolder(folderRoot: string): Array<{ path: string; lastError: string; attempts: number }> {
  const root = toPosixAbs(folderRoot);
  const out: Array<{ path: string; lastError: string; attempts: number }> = [];
  for (const { path: sourcePath, entry } of listFailed()) {
    const rel = relInFolder(sourcePath, root);
    if (rel == null) continue;
    if (!fs.existsSync(sourcePath)) {
      clearRecord(sourcePath);
      continue;
    }
    out.push({ path: rel, lastError: entry.lastError ?? '', attempts: entry.attempts });
  }
  return out;
}

export function conversionProgressForFolder(folderRoot: string): Record<string, ConversionProgress> {
  const root = toPosixAbs(folderRoot);
  const out: Record<string, ConversionProgress> = {};
  for (const sourcePath of listInFlight()) {
    const rel = relInFolder(sourcePath, root);
    if (rel == null) continue;
    const progress = readProgress(sourcePath);
    if (progress) out[rel] = progress;
  }
  return out;
}

export function retryConversionInFolder(relPath: string, folderName?: string): void {
  const rel = typeof relPath === 'string' ? relPath.trim() : '';
  if (!rel) {
    const err = new Error('path required');
    (err as any).status = 400;
    throw err;
  }
  const isPdf = /\.pdf$/i.test(rel);
  const isImage = isImageFile(rel);
  if (!isPdf && !isImage) {
    const err = new Error('not a convertible file (expected PDF or image)');
    (err as any).status = 400;
    throw err;
  }

  const { folderRoot } = requireRequestFolder(folderName?.trim() || undefined);

  const abs = path.resolve(folderRoot, rel);
  const folderRel = path.relative(folderRoot, abs);
  if (folderRel.startsWith('..') || path.isAbsolute(folderRel)) {
    const err = new Error('path escapes folder');
    (err as any).status = 400;
    throw err;
  }
  const sourcePath = sourcePathForAbs(abs);
  if (!fs.existsSync(abs)) {
    clearRecord(sourcePath);
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }
  if (isInFlight(sourcePath)) return;

  clearRecord(sourcePath);
  if (isPdf) {
    const { notePath: staleNote, bundleDir: staleBundle } = derivedPathsForPdf(abs);
    try { fs.rmSync(staleNote, { force: true }); } catch { /* no stale to remove */ }
    try { fs.rmSync(staleBundle, { recursive: true, force: true }); } catch { /* no bundle */ }
    maybeConvertPdf(abs);
  } else {
    try { fs.rmSync(derivedNotePathForImage(abs), { force: true }); } catch { /* no stale */ }
    maybeConvertImage(abs);
  }
}

export function mount(app: express.Express): void {
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
  // I'm currently editing").
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
      const root = toPosixAbs(folderRoot);
      const hits = await indexer.search(query, topK, root);
      // Daemon hits arrive as absolute paths; translate fileName back to
      // folder-relative for the sidebar (which only knows the current
      // folder). Then `displayPathForHit` rewrites a derived note to its
      // source PDF/image (or drops an orphan) so a hidden `.md` never
      // shows — PdfPreview/ImagePreview pick up the chunk text from
      // pendingHighlight and jump to the matching passage.
      const out = remapSearchHitsForDisplay(
        hits
          .map((h) => {
            const rel = relInFolder(h.fileName, root);
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
      const result = mergeKeywordResults(
        await runRipgrep(query, folderDir, { caseStrict, wholeWord }),
        searchDerivedMarkdown(query, folderDir, { caseStrict, wholeWord }),
      );
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
      const { folderRoot: cur } = requireRequestFolder(parseFolderParam(req.query.folder));
      const curRoot = toPosixAbs(cur);
      const status = await indexer.status(curRoot);
      // Convert absolute paths back to folder-relative for the UI.
      // The daemon should already apply the same admission rules Node
      // pushes via `set_rules`, but status is a user-facing indicator:
      // defensively re-check Node's source-of-truth path rules here so
      // a non-indexable source (PDF/image original, hidden scratch dir,
      // old daemon rules) cannot pulse "indexing…" forever. The second
      // Node-side filter is content-semantic and deliberately stays out
      // of the daemon: files with no extractable text chunk to nothing,
      // never enter Milvus, and would otherwise remain pending forever.
      const pendingSet = new Set<string>();
      for (const sourcePath of status.pending) {
        const rel = relInFolder(sourcePath, curRoot);
        if (rel == null) continue;
        if (!shouldIndexFilePath(rel)) continue;
        if (hasNoExtractableText(path.join(cur, rel))) continue;
        const visible = displayPathForHit(rel, cur);
        if (visible) pendingSet.add(visible);
      }
      const pending = [...pendingSet].sort();
      const orphaned = status.orphaned
        .map((p) => relInFolder(p, curRoot))
        .filter((p): p is string => p != null);
      // Conversion status: folder-scoped. `pendingConversions` keeps the
      // old shape (in-flight only) for the sidebar "Converting…"
      // indicator. `conversionFailures` surfaces the persistent failure
      // list so the UI can render Retry entries — for BOTH PDFs
      // (pdf_extract) and images (ocr_extract), which share this
      // status DB. `/api/conversion/retry` dispatches by extension, so a
      // failed image re-runs OCR (not pdf_extract).
      const conversionFailures = conversionFailuresForFolder(curRoot);
      res.json({
        folder: curRoot,
        ...status,
        pending,
        pendingCount: pending.length,
        orphaned,
        orphanedCount: orphaned.length,
        visibleIndexingSettled: pending.length === 0,
        pendingConversions: getInFlightConversions(curRoot),
        conversionProgress: conversionProgressForFolder(curRoot),
        conversionFailures,
        treeVersion: getFsChangeCounter(),
        indexWarning: getIndexWarning(curRoot),
      });
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

  // PDF conversion status: full map, library-wide. Used by PdfPreview to
  // render the per-file failure banner (cheaper than polling the
  // folder-scoped /api/index-status when the viewer just needs one
  // PDF's status).
  app.get('/api/pdf/status', (_req, res) => {
    try {
      res.json({ entries: readConversionStatus() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Conversion Retry: take a folder-relative path, clear its status
  // record, remove the stale derived note, then re-fire the right
  // converter — pdf_extract for `.pdf`, ocr_extract for images. The
  // fire-and-forget convert path writes back to state.db with the new
  // outcome; the client polls /api/index-status to observe the result.
  app.post('/api/conversion/retry', (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const targetFolder = typeof req.body?.folder === 'string' && req.body.folder.trim()
        ? req.body.folder.trim()
        : undefined;
      retryConversionInFolder(rel, targetFolder);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

}



// ---------- keyword search (ripgrep) ----------

const RG_PER_FILE_CAP = 50;
const RG_TOTAL_CAP = 500;
const RG_TIMEOUT_MS = 8000;
const RG_MAX_LINE_CHARS = 240;

interface RipgrepOpts {
  /** false → `--smart-case` (case-insensitive unless query has caps);
   *  true → `--case-sensitive` regardless of query shape. */
  caseStrict: boolean;
  /** true → Unicode-aware app-side whole-token filtering. We do not use
   *  ripgrep's `--word-regexp`: its boundary semantics do not line up
   *  with the renderer and are especially poor for CJK text. */
  wholeWord: boolean;
}

/** Spawn ripgrep on `cwd` with `query` as a literal pattern (no shell).
 *  `--json` gives structured `match` events; we group them into
 *  per-file buckets, applying caps and truncations. */
function runRipgrep(query: string, cwd: string, opts: RipgrepOpts): Promise<KeywordSearchResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      opts.caseStrict ? '--case-sensitive' : '--smart-case',
      '--fixed-strings',
      '--max-count', String(RG_PER_FILE_CAP),
      '--max-filesize', '5M',
      '--glob', '*.md',
      '--glob', '*.markdown',
      '--glob', '*.html',
      '--glob', '*.htm',
    ];
    args.push('-e', query, '.');
    execFile(rgPath, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: RG_TIMEOUT_MS,
      // Ripgrep exits 1 when no matches — execFile treats non-zero as
      // error, so we have to inspect `code` ourselves.
    }, (err, stdout) => {
      // ripgrep exits 1 when no matches — execFile treats non-zero as
      // error, so we have to inspect `code` ourselves. 2 means bad
      // regex; report that as a user error rather than 500.
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const codeStr = String(code ?? '');
        if (codeStr !== '1') {
          if (codeStr === '2') {
            return reject(new Error(`invalid query: ${query}`));
          }
          return reject(new Error(`ripgrep failed (code ${codeStr}): ${err.message}`));
        }
      }
      const byFile = new Map<string, KeywordHitFile>();
      let total = 0;
      let truncated = false;
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        let evt: any;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== 'match') continue;
        const dataPath = evt.data?.path?.text;
        const lineNum = evt.data?.line_number;
        const rawText = evt.data?.lines?.text;
        if (typeof dataPath !== 'string' || typeof lineNum !== 'number' || typeof rawText !== 'string') continue;
        // ripgrep paths are relative to cwd already (we passed `.`),
        // but normalise just in case.
        const relPath = dataPath.replace(/^\.\//, '').replace(/\\/g, '/');
        // Drop trailing newline that ripgrep includes in `lines.text`.
        const stripped = rawText.replace(/\r?\n$/, '');
        const subs = Array.isArray(evt.data?.submatches) ? evt.data.submatches : [];
        const matchRanges = normalizeRipgrepSubmatches(stripped, subs)
          .filter(([start, end]) => !opts.wholeWord || hasWholeTokenBoundaries(stripped, start, end));
        if (matchRanges.length === 0) continue;
        // Center the visible snippet around the first match so highlight
        // ranges stay inside the window for long lines (e.g. 500-char
        // markdown paragraphs). Without this, a match at position 400
        // gets truncated away and the user sees no `<mark>`.
        let windowStart = 0;
        if (stripped.length > RG_MAX_LINE_CHARS && matchRanges.length > 0) {
          const firstStart = matchRanges[0]?.[0] ?? 0;
          windowStart = Math.max(0, Math.min(
            stripped.length - RG_MAX_LINE_CHARS,
            firstStart - Math.floor(RG_MAX_LINE_CHARS / 3),
          ));
        }
        const windowEnd = Math.min(stripped.length, windowStart + RG_MAX_LINE_CHARS);
        const leading = windowStart > 0 ? '…' : '';
        const trailing = windowEnd < stripped.length ? '…' : '';
        const text = leading + stripped.slice(windowStart, windowEnd) + trailing;
        const ranges: Array<[number, number]> = [];
        for (const [start, end] of matchRanges) {
          // Shift each match into snippet-local coordinates and skip
          // anything that fell entirely outside the visible window.
          const localStart = start - windowStart + leading.length;
          const localEnd = end - windowStart + leading.length;
          if (localEnd <= leading.length) continue;
          if (localStart >= text.length - trailing.length) continue;
          ranges.push([
            Math.max(leading.length, localStart),
            Math.min(text.length - trailing.length, localEnd),
          ]);
        }
        let bucket = byFile.get(relPath);
        if (!bucket) {
          bucket = { path: relPath, matches: [], totalMatches: 0 };
          byFile.set(relPath, bucket);
        }
        bucket.totalMatches += matchRanges.length;
        if (total < RG_TOTAL_CAP) {
          bucket.matches.push({ line: lineNum, text, ranges });
          total += matchRanges.length;
        } else {
          truncated = true;
        }
      }
      const files = Array.from(byFile.values()).sort((a, b) => a.path.localeCompare(b.path));
      resolve({ files, totalMatches: total, truncated });
    });
  });
}

function searchDerivedMarkdown(query: string, folderRoot: string, opts: RipgrepOpts): KeywordSearchResult {
  const files: KeywordHitFile[] = [];
  let total = 0;
  let truncated = false;
  const caseSensitive = opts.caseStrict || /[A-Z]/.test(query);

  walkConvertibleSources(folderRoot, '', (rel, abs) => {
    if (total >= RG_TOTAL_CAP) {
      truncated = true;
      return;
    }
    let text: string;
    try { text = fs.readFileSync(derivedNoteFor(abs), 'utf8'); } catch { return; }
    const lines = text.split(/\r?\n/);
    const matches: KeywordMatch[] = [];
    let fileMatches = 0;
    lines.forEach((line, i) => {
      if (fileMatches >= RG_PER_FILE_CAP || total >= RG_TOTAL_CAP) {
        truncated = true;
        return;
      }
      const ranges = findLiteralRanges(line, query, caseSensitive)
        .filter(([start, end]) => !opts.wholeWord || hasWholeTokenBoundaries(line, start, end));
      if (ranges.length === 0) return;
      const snippet = snippetForLine(line, ranges);
      matches.push({
        line: i + 1,
        text: snippet.text,
        ranges: snippet.ranges,
        ...(/\.pdf$/i.test(rel) ? { pdfPage: pdfPageForDerivedLine(lines, i + 1) } : {}),
      });
      fileMatches += ranges.length;
      total += ranges.length;
    });
    if (matches.length > 0) {
      files.push({ path: rel, matches, totalMatches: fileMatches });
    }
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalMatches: total, truncated };
}

function walkConvertibleSources(
  dir: string,
  prefix: string,
  fn: (rel: string, abs: string) => void,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (isCloudPlaceholderName(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory() && isIndexExcludedDirName(ent.name)) continue;
    if (ent.isDirectory() && ent.name.endsWith('_files')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkConvertibleSources(abs, rel, fn);
    } else if (ent.isFile() && (/\.pdf$/i.test(ent.name) || isImageFile(ent.name))) {
      fn(rel, abs);
    }
  }
}

function findLiteralRanges(line: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  const haystack = caseSensitive ? line : line.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  while (needle) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) break;
    ranges.push([idx, idx + needle.length]);
    offset = idx + Math.max(needle.length, 1);
  }
  return ranges;
}

function snippetForLine(line: string, matchRanges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } {
  let windowStart = 0;
  if (line.length > RG_MAX_LINE_CHARS && matchRanges.length > 0) {
    const firstStart = matchRanges[0]?.[0] ?? 0;
    windowStart = Math.max(0, Math.min(
      line.length - RG_MAX_LINE_CHARS,
      firstStart - Math.floor(RG_MAX_LINE_CHARS / 3),
    ));
  }
  const windowEnd = Math.min(line.length, windowStart + RG_MAX_LINE_CHARS);
  const leading = windowStart > 0 ? '…' : '';
  const trailing = windowEnd < line.length ? '…' : '';
  const text = leading + line.slice(windowStart, windowEnd) + trailing;
  const ranges: Array<[number, number]> = [];
  for (const [start, end] of matchRanges) {
    const localStart = start - windowStart + leading.length;
    const localEnd = end - windowStart + leading.length;
    if (localEnd <= leading.length) continue;
    if (localStart >= text.length - trailing.length) continue;
    ranges.push([
      Math.max(leading.length, localStart),
      Math.min(text.length - trailing.length, localEnd),
    ]);
  }
  return { text, ranges };
}

function pdfPageForDerivedLine(lines: string[], lineNumber: number): number | undefined {
  let page: number | undefined;
  for (let i = 0; i < Math.min(lines.length, lineNumber); i++) {
    const line = lines[i] ?? '';
    const marker = line.match(/stashbase-pdf-pages?:\s*(\d+)(?:\s*-\s*(\d+))?/i);
    const pageHeading = line.match(/^#{1,6}\s+Page\s+(\d+)\b/i);
    const next = marker ? Number(marker[1]) : pageHeading ? Number(pageHeading[1]) : NaN;
    if (Number.isFinite(next) && next > 0) page = next;
  }
  return page;
}

function mergeKeywordResults(a: KeywordSearchResult, b: KeywordSearchResult): KeywordSearchResult {
  const byPath = new Map<string, KeywordHitFile>();
  for (const file of [...a.files, ...b.files]) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file, matches: [...file.matches] });
      continue;
    }
    existing.matches.push(...file.matches);
    existing.matches.sort((x, y) => x.line - y.line);
    existing.totalMatches += file.totalMatches;
  }
  const files = [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path));
  return {
    files,
    totalMatches: files.reduce((sum, file) => sum + file.totalMatches, 0),
    truncated: a.truncated || b.truncated,
  };
}

function normalizeRipgrepSubmatches(line: string, subs: unknown[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const s of subs) {
    if (!s || typeof s !== 'object') continue;
    const start = (s as { start?: unknown }).start;
    const end = (s as { end?: unknown }).end;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    ranges.push([
      utf8ByteOffsetToUtf16Index(line, start),
      utf8ByteOffsetToUtf16Index(line, end),
    ]);
  }
  return ranges;
}

function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const next = bytes + Buffer.byteLength(ch, 'utf8');
    if (next > byteOffset) return index;
    index += ch.length;
    bytes = next;
    if (bytes === byteOffset) return index;
  }
  return text.length;
}

function hasWholeTokenBoundaries(text: string, start: number, end: number): boolean {
  const before = charBefore(text, start);
  const after = charAt(text, end);
  return !isKeywordWordChar(before) && !isKeywordWordChar(after);
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const prev = Array.from(text.slice(0, index)).pop();
  return prev ?? '';
}

function charAt(text: string, index: number): string {
  if (index >= text.length) return '';
  return Array.from(text.slice(index))[0] ?? '';
}

function isKeywordWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}_]/u.test(ch);
}

// ---------- recent-files walk ----------
