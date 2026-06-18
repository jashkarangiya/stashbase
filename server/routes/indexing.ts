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
import { fromKbRelForSpace, getCurrentSpace, getCurrentSpaceName, getKbRoot, isInsideKbRoot, requireSpaceExistsByName, validateSpaceRef } from '../space.ts';
import { getApiKey } from '../app-config.ts';
import { hasNoExtractableText } from '../indexable.ts';
import { derivedPathsForPdf, displayPathForHit, maybeConvertPdf } from '../pdf.ts';
import { derivedNotePathForImage, maybeConvertImage } from '../image.ts';
import { getInFlightConversions } from '../conversion.ts';
import { isImageFile } from '../format.ts';
import { clearRecord, isInFlight, listFailed, readAll as readConversionStatus } from '../conversion-status.ts';
import { getFsChangeCounter } from '../watcher.ts';
import { getDaemon } from '../mfs-daemon.ts';
import { clearIndexWarning, clearSnapshotWarning, getIndexWarning, getSnapshotWarning, indexer, syncSpaceNow } from '../state.ts';
import { noteTreeChanged } from '../watcher.ts';
import { sendError } from '../http.ts';
import {
  remapKeywordFilesForDisplay,
  remapSearchHitsForDisplay,
  type KeywordHitFile,
  type KeywordMatch,
  type KeywordSearchResult,
} from '../search-display.ts';

const log = logger('routes/indexing');

export interface SnapshotExportResult {
  path: string;
  vectors: number;
  chunks: number;
  version: number;
  embedder: { provider: string; model: string | null; dim: number };
}

export interface SnapshotMeta {
  version: number;
  space: string;
  embedder: { provider: string; model: string | null; dim: number };
  vectors: number;
  chunks: number;
  exported_at: string;
}

function parseSpaceParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireRequestSpace(explicit?: string): { spaceName: string; spaceRoot: string } {
  if (explicit) {
    const bad = validateSpaceRef(explicit);
    if (bad) {
      const err = new Error(bad);
      (err as any).status = 400;
      throw err;
    }
    return { spaceName: explicit, spaceRoot: requireSpaceExistsByName(explicit) };
  }
  const spaceName = getCurrentSpaceName();
  const spaceRoot = getCurrentSpace();
  if (!spaceName || !spaceRoot) {
    const err = new Error('no space open');
    (err as any).status = 412;
    (err as any).code = 'NO_SPACE';
    throw err;
  }
  return { spaceName, spaceRoot };
}

function kbRelForAbs(absPath: string): string | null {
  const rel = path.relative(getKbRoot(), absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function conversionFailuresForSpace(space: string): Array<{ path: string; lastError: string; attempts: number }> {
  const out: Array<{ path: string; lastError: string; attempts: number }> = [];
  for (const { path: kbRel, entry } of listFailed()) {
    const rel = fromKbRelForSpace(kbRel, space);
    if (rel == null) continue;
    if (!fs.existsSync(path.join(getKbRoot(), kbRel))) {
      clearRecord(kbRel);
      continue;
    }
    out.push({ path: rel, lastError: entry.lastError ?? '', attempts: entry.attempts });
  }
  return out;
}

export function retryConversionInSpace(relPath: string, spaceName?: string): void {
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

  let spaceRoot: string | null;
  let resolvedSpace = spaceName?.trim();
  if (resolvedSpace) {
    const bad = validateSpaceRef(resolvedSpace);
    if (bad) {
      const err = new Error(bad);
      (err as any).status = 400;
      throw err;
    }
    spaceRoot = requireSpaceExistsByName(resolvedSpace);
  } else {
    spaceRoot = getCurrentSpace();
    resolvedSpace = getCurrentSpaceName() ?? undefined;
  }
  if (!spaceRoot || !resolvedSpace) {
    const err = new Error('no space open');
    (err as any).status = 412;
    (err as any).code = 'NO_SPACE';
    throw err;
  }

  const abs = path.resolve(spaceRoot, rel);
  const spaceRel = path.relative(spaceRoot, abs);
  if (spaceRel.startsWith('..') || path.isAbsolute(spaceRel) || !isInsideKbRoot(abs)) {
    const err = new Error('path escapes space');
    (err as any).status = 400;
    throw err;
  }
  const kbRel = kbRelForAbs(abs);
  if (!kbRel) {
    const err = new Error('path escapes KB root');
    (err as any).status = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    clearRecord(kbRel);
    const err = new Error('file not found');
    (err as any).status = 404;
    throw err;
  }
  if (isInFlight(kbRel)) return;

  clearRecord(kbRel);
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
  // Trigger a space sync manually — useful after external edits / file
  // moves. Returns the diff (added / removed / failed). Defaults to the
  // active space; accepts `?space=<name>` to sync any known space
  // (powers MCP `reindex` so external agents can refresh an
  // unopened space's index without the user opening it first).
  app.post('/api/sync', async (req, res) => {
    try {
      const explicit = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      if (explicit) {
        const bad = validateSpaceRef(explicit);
        if (bad) return res.status(400).json({ error: bad });
      }
      const space = explicit ?? getCurrentSpaceName() ?? undefined;
      if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const result = await syncSpaceNow(requireSpaceExistsByName(space), { reason: 'manual sync' });
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

  // Hybrid (vector + BM25) search, scoped to the current open space.
  // Cross-space search lives behind the MCP `search_kb` tool (different
  // mental model: "AI searching all my notes" vs "I'm searching the KB
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
      const explicit = typeof req.body?.space === 'string' && req.body.space.trim()
        ? req.body.space.trim() : undefined;
      if (explicit) {
        const bad = validateSpaceRef(explicit);
        if (bad) return res.status(400).json({ error: bad });
      }
      const space = explicit ?? getCurrentSpaceName();
      const spaceRoot = explicit ? requireSpaceExistsByName(explicit) : getCurrentSpace();
      if (!space || !spaceRoot) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const hits = await indexer.search(query, topK, space);
      // Daemon hits arrive kbRoot-relative; translate fileName back to
      // space-relative for the sidebar (which only knows the current
      // space). Then `displayPathForHit` rewrites a derived note to its
      // source PDF/image (or drops an orphan) so a hidden `.md` never
      // shows — PdfPreview/ImagePreview pick up the chunk text from
      // pendingHighlight and jump to the matching passage.
      const out = remapSearchHitsForDisplay(
        hits
          .map((h) => {
            const rel = fromKbRelForSpace(h.fileName, space);
            return rel == null ? null : { ...h, fileName: rel };
          })
          .filter((h): h is NonNullable<typeof h> => h !== null),
        spaceRoot,
      );
      res.json({ hits: out });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Keyword (substring / regex) search via ripgrep, scoped to the
  // active space directory. Bypasses the daemon and the index — useful
  // for finding specific tokens (function names, exact phrases) that
  // semantic search blurs out. Defaults to smart-case, restricts to
  // markdown / HTML (the only formats we index anyway), caps per-file
  // and total match counts so a generic query can't OOM the renderer.
  app.get('/api/keyword-search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!query) return res.status(400).json({ error: 'q required' });
      const explicit = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      if (explicit) {
        const bad = validateSpaceRef(explicit);
        if (bad) return res.status(400).json({ error: bad });
      }
      const spaceName = explicit ?? getCurrentSpaceName() ?? undefined;
      if (!spaceName) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const spaceDir = requireSpaceExistsByName(spaceName);
      const caseStrict = req.query.case_strict === '1' || req.query.case_strict === 'true';
      const wholeWord = req.query.whole_word === '1' || req.query.whole_word === 'true';
      const result = await runRipgrep(query, spaceDir, { caseStrict, wholeWord });
      // ripgrep's `*.md` glob also matches the hidden dot-prefixed
      // derived notes (`.paper.pdf.md` / `.shot.png.md`). Apply the same
      // remap-or-drop rule as the semantic routes so a hit's row points
      // at the openable source PDF / image (the matched OCR / converted
      // snippet stays) and an orphan note never surfaces.
      const remapped = remapKeywordFilesForDisplay(result.files, spaceDir);
      res.json({ query, space: spaceName, ...result, ...remapped });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Lightweight status — full `pending` list (not a sample) so the
  // sidebar can grey out the right rows. Scoped to the current space.
  // `treeVersion` bumps on every external fs event, covering writes
  // from Claude Code / `touch` that wouldn't move `pending`
  // (non-indexable files, empty dirs). Also surfaces in-flight PDF
  // conversions for the conversion indicator.
  app.get('/api/index-status', async (req, res) => {
    try {
      const { spaceName: space, spaceRoot: cur } = requireRequestSpace(parseSpaceParam(req.query.space));
      const status = await indexer.status(space);
      // Convert kbRoot-relative paths back to space-relative for the UI.
      // Admission filtering (extensions / excluded dirs / empty / over-
      // size) happens daemon-side with the rules Node pushes via
      // `set_rules` — no second copy here. The ONE Node-side filter left
      // is content-semantic and deliberately stays out of the daemon
      // ("daemon never touches format logic"): files with no extractable
      // text (bundler-format HTML that is one giant <script>,
      // whitespace-only notes) chunk to nothing, never enter Milvus, and
      // would pulse "indexing…" forever.
      const pendingSet = new Set<string>();
      for (const kbRel of status.pending) {
        const rel = fromKbRelForSpace(kbRel, space);
        if (rel == null) continue;
        if (hasNoExtractableText(path.join(cur, rel))) continue;
        const visible = displayPathForHit(rel, cur);
        if (visible) pendingSet.add(visible);
      }
      const pending = [...pendingSet].sort();
      const orphaned = status.orphaned
        .map((p) => fromKbRelForSpace(p, space))
        .filter((p): p is string => p != null);
      // Conversion status: space-scoped. `pendingConversions` keeps the
      // old shape (in-flight only) for the sidebar "Converting…"
      // indicator. `conversionFailures` surfaces the persistent failure
      // list so the UI can render Retry entries — for BOTH PDFs
      // (pdf_extract) and images (ocr_extract), which share this
      // status DB. `/api/conversion/retry` dispatches by extension, so a
      // failed image re-runs OCR (not pdf_extract).
      const conversionFailures = space ? conversionFailuresForSpace(space) : [];
      res.json({
        space,
        ...status,
        pending,
        pendingCount: pending.length,
        orphaned,
        pendingConversions: getInFlightConversions(space),
        conversionFailures,
        treeVersion: getFsChangeCounter(),
        // Surface any unresolved snapshot-import warning for the
        // current space so the renderer can show a banner. `null` when
        // nothing's wrong (the typical state).
        snapshotWarning: space ? getSnapshotWarning(space) : null,
        indexWarning: space ? getIndexWarning(space) : null,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Dismiss the current space's snapshot warning. Renderer calls this
  // when the user clicks "Dismiss" on the banner. Idempotent — a
  // dismissed warning won't reappear unless a new import surfaces a
  // fresh skip count.
  app.post('/api/snapshot-warning/dismiss', (req, res) => {
    const explicit = typeof req.body?.space === 'string' && req.body.space.trim()
      ? req.body.space.trim()
      : undefined;
    if (explicit) {
      const bad = validateSpaceRef(explicit);
      if (bad) return res.status(400).json({ error: bad });
    }
    const space = explicit ?? getCurrentSpaceName();
    if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    clearSnapshotWarning(space);
    res.json({ ok: true });
  });

  app.post('/api/index-warning/dismiss', (req, res) => {
    const explicit = typeof req.body?.space === 'string' && req.body.space.trim()
      ? req.body.space.trim()
      : undefined;
    if (explicit) {
      const bad = validateSpaceRef(explicit);
      if (bad) return res.status(400).json({ error: bad });
    }
    const space = explicit ?? getCurrentSpaceName();
    if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    clearIndexWarning(space);
    res.json({ ok: true });
  });

  // PDF conversion status: full map, KB-wide. Used by PdfPreview to
  // render the per-file failure banner (cheaper than polling the
  // space-scoped /api/index-status when the viewer just needs one
  // PDF's status).
  app.get('/api/pdf/status', (_req, res) => {
    try {
      res.json({ entries: readConversionStatus() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Conversion Retry: take a space-relative path, clear its status
  // record, remove the stale derived note, then re-fire the right
  // converter — pdf_extract for `.pdf`, ocr_extract for images. The
  // fire-and-forget convert path writes back to state.db with the new
  // outcome; the client polls /api/index-status to observe the result.
  app.post('/api/conversion/retry', (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const targetSpace = typeof req.body?.space === 'string' && req.body.space.trim()
        ? req.body.space.trim()
        : undefined;
      retryConversionInSpace(rel, targetSpace);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Export the current space's embeddings to a portable snapshot at
  // `<space>/.stashbase/snapshot.parquet` (a pure {text_hash,
  // dense_vector} cache) plus a `snapshot.meta.json` descriptor.
  // Downstream consumers prime the cache on bind and reuse vectors
  // during reindex (see `maybeImportSnapshot` in state.ts).
  app.post('/api/space/export-snapshot', async (req, res) => {
    try {
      const { spaceName, spaceRoot: cur } = requireRequestSpace(parseSpaceParam(req.body?.space));
      const outPath = path.join(cur, '.stashbase', 'snapshot.parquet');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const result = await getDaemon().call<SnapshotExportResult>('export_space', { space: spaceName, out_path: outPath });
      // The Parquet holds only vectors; the human-readable descriptor
      // (embedder identity, counts, timestamp) lives in a sibling JSON so
      // import can validate the embedder without decoding any vectors.
      const metaPath = path.join(cur, '.stashbase', 'snapshot.meta.json');
      writeSnapshotMetaOrCleanup(metaPath, outPath, makeSnapshotMeta(spaceName, result));
      log.info(
        `snapshot export ${spaceName}: ${result.vectors} vector(s) from ${result.chunks} chunk(s) → ${result.path}`,
      );
      res.json({ ...result, meta: metaPath });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

export function makeSnapshotMeta(spaceName: string, result: SnapshotExportResult, now = new Date()): SnapshotMeta {
  return {
    version: result.version,
    space: spaceName,
    embedder: result.embedder,
    vectors: result.vectors,
    chunks: result.chunks,
    exported_at: now.toISOString(),
  };
}

export function writeSnapshotMetaOrCleanup(metaPath: string, snapshotPath: string, meta: SnapshotMeta): void {
  try {
    writeTextAtomic(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch (err) {
    try { fs.rmSync(snapshotPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function writeTextAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
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
