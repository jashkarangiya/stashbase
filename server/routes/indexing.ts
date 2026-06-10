/**
 * Indexing-related routes: hybrid search, manual full sync, and the
 * lightweight status poll the UI uses to grey out pending files.
 */
import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { errorMessage, logger } from '../log.ts';
import { fromKbRel, getApiKey, getCurrentSpace, getCurrentSpaceName, getKbRoot, isInsideKbRoot, toKbRel } from '../space.ts';
import { syncIndex } from '../sync.ts';
import { extractEmbeddedResources } from '../resources.ts';
import {
  isReservedMetadataFile,
  setFileMetadataEntry,
  type FileMetadata,
} from '../metadata.ts';
import { HIDDEN_DOT_DIRS } from '../files.ts';
import { derivedPathsForPdf, displayPathForHit, maybeConvertPdf } from '../pdf.ts';
import { derivedNotePathForImage, maybeConvertImage } from '../image.ts';
import { derivedNotePathForVideo, maybeConvertVideo } from '../video.ts';
import { getInFlightConversions } from '../conversion.ts';
import { isImageFile, isNoteName, isUnstructuredSource, isVideoFile } from '../format.ts';
import { clearRecord, listByStatus, readAll as readConversionStatus } from '../conversion-status.ts';
import { getFsChangeCounter } from '../watcher.ts';
import { getDaemon } from '../mfs-daemon.ts';
import { clearSnapshotWarning, getSnapshotWarning, indexer } from '../state.ts';
import { noteSelfWrite, noteTreeChanged } from '../watcher.ts';
import {
  getKbRules,
  getKbInfo,
  getKbOverview,
  getResolvedRules,
  getSpaceInfoFull,
  getSpaceRules,
  setKbOverview,
  setKbRules,
  setSpaceRules,
} from '../kb.ts';
import { sendError } from '../http.ts';

const log = logger('routes/indexing');

/** True when a kbRoot-relative path dips into an internal hidden
 *  directory (`.stashbase` config/secrets, `.git`, OS junk). The
 *  MCP-facing `/api/kb/file/*` routes refuse these so an external client
 *  can't read per-space config / secrets or other internals — the
 *  space-scoped `/api/files/*` surface already hides them via the tree
 *  walk; this brings the KB-wide surface in line. (`..`/root-escape is
 *  caught separately by `isInsideKbRoot`.) */
function dipsIntoHiddenKbDir(rel: string): boolean {
  return rel.replace(/\\/g, '/').split('/').some((seg) => HIDDEN_DOT_DIRS.has(seg));
}

export function mount(app: express.Express): void {
  // Trigger a space sync manually — useful after external edits / file
  // moves. Returns the diff (added / removed / failed). Defaults to the
  // active space; accepts `?space=<name>` to sync any known space
  // (powers MCP `update_index` so external agents can refresh an
  // unopened space's index without the user opening it first).
  app.post('/api/sync', async (req, res) => {
    try {
      const explicit = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      const space = explicit ?? getCurrentSpaceName() ?? undefined;
      if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      res.json(await syncIndex(indexer, space));
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
      const space = getCurrentSpaceName();
      const hits = await indexer.search(query, topK, space ?? undefined);
      const spaceRoot = getCurrentSpace();
      // Daemon hits arrive kbRoot-relative; translate fileName back to
      // space-relative for the sidebar (which only knows the current
      // space). Then `displayPathForHit` rewrites a derived note to its
      // source PDF/image (or drops an orphan) so a hidden `.md` never
      // shows — PdfPreview/ImagePreview pick up the chunk text from
      // pendingHighlight and jump to the matching passage.
      const out = space
        ? hits
            .map((h) => {
              const rel = fromKbRel(h.fileName);
              if (rel == null) return null;
              const display = spaceRoot ? displayPathForHit(rel, spaceRoot) : rel;
              return display == null ? null : { ...h, fileName: display };
            })
            .filter((h): h is NonNullable<typeof h> => h !== null)
        : hits;
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
      const spaceName = explicit ?? getCurrentSpaceName() ?? undefined;
      if (!spaceName) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const spaceDir = path.resolve(getKbRoot(), spaceName);
      // Reject paths that escape kbRoot (e.g. ?space=../etc) and
      // missing space dirs up front so ripgrep's ENOENT doesn't bubble
      // out as a confusing 500.
      const kbRoot = getKbRoot();
      const rel = path.relative(kbRoot, spaceDir);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
        return res.status(400).json({ error: 'invalid space' });
      }
      if (!fs.existsSync(spaceDir)) {
        return res.status(404).json({ error: `space not found: ${spaceName}` });
      }
      const caseStrict = req.query.case_strict === '1' || req.query.case_strict === 'true';
      const wholeWord = req.query.whole_word === '1' || req.query.whole_word === 'true';
      const result = await runRipgrep(query, spaceDir, { caseStrict, wholeWord });
      // ripgrep's `*.md` glob also matches the hidden dot-prefixed
      // derived notes (`.paper.pdf.md` / `.shot.png.md`). Apply the same
      // remap-or-drop rule as the semantic routes so a hit's row points
      // at the openable source PDF / image (the matched OCR / converted
      // snippet stays) and an orphan note never surfaces.
      const files = result.files
        .map((f) => {
          const display = displayPathForHit(f.path, spaceDir);
          return display == null ? null : { ...f, path: display };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);
      res.json({ query, space: spaceName, ...result, files });
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
  app.get('/api/index-status', async (_req, res) => {
    try {
      const cur = getCurrentSpace();
      if (!cur) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const space = getCurrentSpaceName();
      const status = await indexer.status(space ?? undefined);
      // Convert kbRoot-relative paths back to space-relative for the UI.
      // Drop `.pdf` and image files from `pending`: like PDFs, images are
      // visible in the sidebar (listFiles surfaces them) but never enter
      // the index themselves — only their hidden derived `.md` does.
      // Keeping them in `pending` would make the sidebar permanently
      // pulse "indexing…" on every unstructured (PDF / image) row.
      const pending = status.pending
        .map((p) => fromKbRel(p))
        .filter((p): p is string => p != null)
        .filter((p) => !isUnstructuredSource(p));
      const orphaned = status.orphaned
        .map((p) => fromKbRel(p))
        .filter((p): p is string => p != null);
      // Conversion status: space-scoped. `pendingConversions` keeps the
      // old shape (in-flight only) for the sidebar "Converting…"
      // indicator. `conversionFailures` surfaces the persistent failure
      // list so the UI can render Retry entries — for BOTH PDFs
      // (pdf_extract) and images (ocr_extract), which share this
      // status DB. `/api/conversion/retry` dispatches by extension, so a
      // failed image re-runs OCR (not pdf_extract).
      const conversionFailures = listByStatus('failed')
        .map(({ path: kbRel, entry }) => {
          const rel = fromKbRel(kbRel);
          return rel == null ? null : { path: rel, lastError: entry.lastError ?? '', attempts: entry.attempts };
        })
        .filter((x): x is { path: string; lastError: string; attempts: number } => x !== null);
      res.json({
        ...status,
        pending,
        orphaned,
        pendingConversions: getInFlightConversions(),
        conversionFailures,
        treeVersion: getFsChangeCounter(),
        // Surface any unresolved snapshot-import warning for the
        // current space so the renderer can show a banner. `null` when
        // nothing's wrong (the typical state).
        snapshotWarning: space ? getSnapshotWarning(space) : null,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Dismiss the current space's snapshot warning. Renderer calls this
  // when the user clicks "Dismiss" on the banner. Idempotent — a
  // dismissed warning won't reappear unless a new import surfaces a
  // fresh skip count.
  app.post('/api/snapshot-warning/dismiss', (_req, res) => {
    const space = getCurrentSpaceName();
    if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    clearSnapshotWarning(space);
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
      if (!rel) return res.status(400).json({ error: 'path required' });
      const isPdf = /\.pdf$/i.test(rel);
      const isImage = isImageFile(rel);
      const isVideo = isVideoFile(rel);
      if (!isPdf && !isImage && !isVideo) {
        return res.status(400).json({ error: 'not a convertible file (expected PDF, image, or video)' });
      }
      const space = getCurrentSpace();
      if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const abs = path.resolve(space, rel);
      // The source can sit at any depth inside the space, so use the
      // file-level kbRoot containment check, not the space-boundary
      // `isUnderRoot` (which restricts to one-segment children). Also
      // verify the path actually resolves inside the space (not "..").
      const spaceRel = path.relative(space, abs);
      if (spaceRel.startsWith('..') || path.isAbsolute(spaceRel) || !isInsideKbRoot(abs)) {
        return res.status(400).json({ error: 'path escapes space' });
      }
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
      // Clear by KB-relative form (matches what the converters write
      // when they spin back up).
      try {
        clearRecord(toKbRel(rel));
      } catch { /* no current space — guarded above, defensive */ }
      // Remove the stale derived note(s) so the converter's "skip if
      // note exists" guard doesn't immediately bail. The source binary
      // (.pdf / image) stays in place — Retry only re-derives the
      // dot-prefixed `.md` (+ PDF image bundle).
      if (isPdf) {
        const { notePath: staleNote, bundleDir: staleBundle } = derivedPathsForPdf(abs);
        try { fs.rmSync(staleNote, { force: true }); } catch { /* no stale to remove */ }
        try { fs.rmSync(staleBundle, { recursive: true, force: true }); } catch { /* no bundle */ }
        maybeConvertPdf(abs, rel);
      } else if (isVideo) {
        try { fs.rmSync(derivedNotePathForVideo(abs), { force: true }); } catch { /* no stale */ }
        maybeConvertVideo(abs, rel);
      } else {
        try { fs.rmSync(derivedNotePathForImage(abs), { force: true }); } catch { /* no stale */ }
        maybeConvertImage(abs, rel);
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // --- KB-scoped endpoints (powered by the same single daemon) ---
  //
  // These are the cross-space surface used by MCP. They speak in
  // kbRoot-relative paths and accept an optional `space` filter so an
  // AI client can search the whole knowledge base by default, or narrow to one
  // space when needed. Kept separate from the sidebar-facing /api/search
  // / /api/index-status / /api/files routes (which are space-scoped and
  // return space-relative paths the UI consumes directly).
  app.post('/api/kb/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const space = typeof req.body?.space === 'string' && req.body.space.trim()
        ? req.body.space.trim() : undefined;
      const pathPrefix = typeof req.body?.path_prefix === 'string' && req.body.path_prefix.trim()
        ? req.body.path_prefix.trim() : undefined;
      if (!query) return res.status(400).json({ error: 'query required' });
      // Same remap-or-drop rule as /api/search, but against KB root
      // since MCP callers (external AI clients) receive kbRoot-relative
      // paths and operate KB-wide — a hidden `.md` must never reach an
      // external client either.
      const kbRoot = getKbRoot();
      const hits = (await indexer.search(query, topK, space, pathPrefix))
        .map((h) => {
          const display = displayPathForHit(h.fileName, kbRoot);
          return display == null ? null : { ...h, fileName: display };
        })
        .filter((h): h is NonNullable<typeof h> => h !== null);
      res.json({ hits });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/kb/index-status', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      const status = await indexer.status(space);
      // Recently-indexed slice: intersect the indexed file set with
      // their on-disk mtime, return top N. Helps an agent answer "what
      // did I just embed?" without a state.db timestamp column.
      let recentlyIndexed: Array<{ path: string; mtimeMs: number }> = [];
      try {
        const indexed = await indexer.listFiles(space);
        const kbRoot = getKbRoot();
        const enriched: Array<{ path: string; mtimeMs: number }> = [];
        for (const kbRel of Object.keys(indexed)) {
          try {
            const st = fs.statSync(path.join(kbRoot, kbRel));
            enriched.push({ path: kbRel, mtimeMs: st.mtimeMs });
          } catch { /* file vanished — drop from list */ }
        }
        enriched.sort((a, b) => b.mtimeMs - a.mtimeMs);
        recentlyIndexed = enriched.slice(0, 10);
      } catch (err) {
        log.warn(`recently_indexed enrichment failed: ${errorMessage(err)}`);
      }
      // Surface snapshot-import warnings on the MCP-facing surface too —
      // the desktop UI sees them via /api/index-status, but an external
      // AI client polling `index_status` would otherwise be blind to a
      // partly-imported snapshot.
      res.json({
        ...status,
        snapshotWarning: space ? getSnapshotWarning(space) : null,
        recentlyIndexed,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // List indexed paths across the knowledge base (paths only — rich metadata
  // would require a filesystem walk per space and bloats the response).
  app.get('/api/kb/files', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      const files = await indexer.listFiles(space);
      res.json({ files: Object.keys(files).sort() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // KB 目录 (<kbRoot>/.stashbase/space-metadata.md). The KbPanel
  // in the renderer GETs this as a regular markdown blob; MCP forwards
  // both reads and writes here so the daemon shares one source of truth.
  app.get('/api/kb/overview', (_req, res) => {
    res.json({ content: getKbOverview() });
  });

  app.post('/api/kb/overview', (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    try {
      setKbOverview(content);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // KB info = overview + per-space structured facts. Powers MCP's
  // `kb_info` tool — Claude reads this when deciding which space
  // to search.
  app.get('/api/kb/info', async (_req, res) => {
    try {
      res.json(await getKbInfo());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Structured facts for ONE space + that space's slice of the library
  // 目录. Powers MCP's `space_info` tool — the per-space follow-up to
  // `kb_info`.
  app.get('/api/kb/space-info', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' ? req.query.space.trim() : '';
      if (!space) return res.status(400).json({ error: 'space required' });
      res.json(await getSpaceInfoFull(space));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Read/write one file's section of `<space>/file-metadata.md`
  // — the agent-maintained metadata sidecar kept out of the user's file.
  // Powers MCP's `set_file_metadata`. `path` is kbRoot-relative; the
  // first segment is the space, the rest the space-relative file path.
  // Passing an empty `metadata` object removes the section.
  app.post('/api/kb/file-metadata', (req, res) => {
    try {
      const kbRel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      const metadata = req.body?.metadata;
      if (!kbRel) return res.status(400).json({ error: 'path required' });
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        return res.status(400).json({ error: 'metadata (object) required' });
      }
      const split = splitSpacePath(kbRel);
      if (!split) {
        return res.status(400).json({ error: 'path must include a space segment, e.g. "cs183b/note.md"' });
      }
      if (isReservedMetadataFile(kbRel)) {
        return res.status(400).json({ error: 'cannot set metadata on a reserved metadata file' });
      }
      setFileMetadataEntry(split.space, split.spaceRel, metadata as FileMetadata);
      res.json({ ok: true, path: kbRel });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/rules', (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim()
        : getCurrentSpaceName() ?? undefined;
      res.json({ space: space ?? null, content: getResolvedRules(space) });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Raw KB-level STASHBASE.md content (no per-space concatenation).
  // Separate from `/api/rules` so the KbPanel can show each
  // rules file as its own openable tab.
  app.get('/api/kb/rules', (_req, res) => {
    try {
      res.json({ content: getKbRules() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/kb/rules', (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    try {
      setKbRules(content);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/spaces/:name/rules', (req, res) => {
    try {
      res.json({ name: req.params.name, content: getSpaceRules(req.params.name) });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/spaces/:name/rules', (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    try {
      setSpaceRules(req.params.name, content);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Read any file under kbRoot by kbRoot-relative path. Powers MCP's
  // `get_file` so an AI client can fetch a file outside the currently
  // open space. Refuses anything escaping the root.
  app.get('/api/kb/file/*', (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
      if (dipsIntoHiddenKbDir(rel)) return res.status(400).json({ error: 'path is inside an internal directory' });
      const abs = path.resolve(getKbRoot(), rel);
      if (!isInsideKbRoot(abs)) return res.status(400).json({ error: 'path escapes kbRoot' });
      const content = fs.readFileSync(abs, 'utf8');
      res.json({ path: rel, content });
    } catch (err: unknown) {
      if ((err as any)?.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      sendError(res, err);
    }
  });

  // Files in the KB sorted by mtime descending — the cheap way to give
  // an agent "what did I just touch?" without state.db. Walks the KB
  // root once, filters to indexable formats (md / html / .markdown,
  // hidden dotdirs skipped), returns paths + mtime in ms. Caps at
  // `limit` (default 20, max 200) so a giant KB doesn't blow the
  // response. Optional `space` query scopes to one space.
  app.get('/api/kb/recent-files', (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      const rawLimit = Number(req.query.limit);
      const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20));
      const root = space ? path.resolve(getKbRoot(), space) : getKbRoot();
      if (!fs.existsSync(root)) return res.status(404).json({ error: 'not found' });
      const files = walkForRecent(root, getKbRoot());
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      res.json({ files: files.slice(0, limit) });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Write a file at a kbRoot-relative path. Powers MCP `write_file` so
  // AI clients (especially web-based ones without shell access) can
  // create / update notes anywhere in the KB. Default `overwrite=false`
  // returns 409 when the target exists — an agent must opt in to
  // replace user content, matching 02-storage's "agent writes need
  // explicit overwrite" rule. The disk write returns immediately; the
  // semantic index updates in the background so generated peer files
  // don't hang on embedding latency / key problems / large content.
  app.put('/api/kb/file/*', async (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
      if (dipsIntoHiddenKbDir(rel)) return res.status(400).json({ error: 'path is inside an internal directory' });
      const content = (req.body ?? {}).content;
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content (string) required' });
      }
      const overwrite = req.body?.overwrite === true;
      const abs = path.resolve(getKbRoot(), rel);
      if (!isInsideKbRoot(abs)) return res.status(400).json({ error: 'path escapes kbRoot' });
      if (fs.existsSync(abs) && !overwrite) {
        return res.status(409).json({ error: 'file exists (pass overwrite=true to replace)', code: 'EXISTS' });
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Pipeline §4.2 steps 2-3: extract inline `data:` resources into
      // the note's `<stem>_files/` bundle and rewrite refs before write,
      // so agent/editor-authored notes don't bake in base64 images.
      let finalContent = content;
      try {
        const extracted = extractEmbeddedResources(rel, content);
        if (extracted.assets.length > 0) {
          finalContent = extracted.content;
          for (const a of extracted.assets) {
            const assetAbs = path.resolve(getKbRoot(), a.path);
            if (!isInsideKbRoot(assetAbs)) continue;
            fs.mkdirSync(path.dirname(assetAbs), { recursive: true });
            noteSelfWrite(assetAbs);
            fs.writeFileSync(assetAbs, a.bytes);
          }
          log.info(`write ${rel}: extracted ${extracted.assets.length} embedded resource(s)`);
        }
      } catch (err: unknown) {
        log.warn(`write ${rel}: resource extraction failed: ${errorMessage(err)}`);
      }
      // Mark before write so the watcher swallows the resulting fs
      // event. We bump treeVersion manually below and fire indexing in
      // the background; a watcher-triggered sync would just duplicate
      // that work.
      noteSelfWrite(abs);
      fs.writeFileSync(abs, finalContent);
      noteTreeChanged();
      res.json({ path: rel, indexDeferred: true });
      void indexer.upsertFile(rel, finalContent).catch((err) => {
        log.warn(`upsert ${rel} failed after write: ${errorMessage(err)}`);
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Delete a file at a kbRoot-relative path. Powers MCP `delete_file`.
  // Mirrors the `/api/files/*` DELETE pattern: respond as soon as the
  // file is off disk, fire the index cleanup async (a stale chunk for
  // a few seconds is harmless and the next sync sweeps it anyway).
  app.delete('/api/kb/file/*', (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
      const abs = path.resolve(getKbRoot(), rel);
      if (!isInsideKbRoot(abs)) return res.status(400).json({ error: 'path escapes kbRoot' });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
      noteSelfWrite(abs);
      fs.rmSync(abs);
      res.json({ path: rel });
      indexer.deleteFile(rel).catch((err) => {
        log.warn(`delete: index cleanup failed for ${rel}: ${errorMessage(err)}`);
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Rename a file at a kbRoot-relative path. Powers MCP `rename_file`.
  // V1 semantics: simple disk rename + re-embed under the new source.
  // Does NOT cascade-update inbound links (the `/api/files/*` PATCH on
  // the space-scoped surface does — that's the UX path with a confirm
  // dialog). MCP callers can `update_index` after if they edited links
  // by hand. Refuses if target exists; rolls disk rename back if the
  // indexer rename fails so caller state stays consistent.
  app.patch('/api/kb/file/*', async (req, res) => {
    try {
      const oldRel = (req.params as any)[0] as string;
      const newRel = typeof req.body?.new_path === 'string' ? req.body.new_path.trim() : '';
      if (!oldRel) return res.status(400).json({ error: 'path required' });
      if (!newRel) return res.status(400).json({ error: 'new_path required' });
      const oldAbs = path.resolve(getKbRoot(), oldRel);
      const newAbs = path.resolve(getKbRoot(), newRel);
      if (!isInsideKbRoot(oldAbs) || !isInsideKbRoot(newAbs)) {
        return res.status(400).json({ error: 'path escapes kbRoot' });
      }
      if (oldRel === newRel) return res.json({ path: oldRel });
      if (!fs.existsSync(oldAbs)) return res.status(404).json({ error: 'not found' });
      if (fs.existsSync(newAbs)) return res.status(409).json({ error: 'target exists', code: 'EXISTS' });
      let content: string | null = null;
      try { content = fs.readFileSync(oldAbs, 'utf8'); } catch { /* binary or unreadable — skip re-embed */ }
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      // Mark both endpoints — the rename fires events for the source
      // (delete) and target (create) and we want the watcher to ignore
      // both, since we already handle the index update inline.
      noteSelfWrite(oldAbs);
      noteSelfWrite(newAbs);
      fs.renameSync(oldAbs, newAbs);
      if (content !== null) {
        if (!getApiKey()) {
          return res.json({ path: newRel });
        }
        try {
          await indexer.renameFile(oldRel, newRel, content);
        } catch (err) {
          try { fs.renameSync(newAbs, oldAbs); } catch { /* best effort */ }
          throw err;
        }
      }
      res.json({ path: newRel });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Export the current space's embeddings to a portable snapshot at
  // `<space>/.stashbase/snapshot.parquet` (a pure {text_hash,
  // dense_vector} cache) plus a `snapshot.meta.json` descriptor.
  // Downstream consumers prime the cache on bind and reuse vectors
  // during reindex (see `maybeImportSnapshot` in state.ts).
  app.post('/api/space/export-snapshot', async (_req, res) => {
    try {
      const cur = getCurrentSpace();
      if (!cur) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const spaceName = getCurrentSpaceName();
      if (!spaceName) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const outPath = path.join(cur, '.stashbase', 'snapshot.parquet');
      const result = await getDaemon().call<{
        path: string;
        vectors: number;
        chunks: number;
        version: number;
        embedder: { provider: string; model: string | null; dim: number };
      }>('export_space', { space: spaceName, out_path: outPath });
      // The Parquet holds only vectors; the human-readable descriptor
      // (embedder identity, counts, timestamp) lives in a sibling JSON so
      // import can validate the embedder without decoding any vectors.
      const metaPath = path.join(cur, '.stashbase', 'snapshot.meta.json');
      const meta = {
        version: result.version,
        space: spaceName,
        embedder: result.embedder,
        vectors: result.vectors,
        chunks: result.chunks,
        exported_at: new Date().toISOString(),
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      log.info(
        `snapshot export ${spaceName}: ${result.vectors} vector(s) from ${result.chunks} chunk(s) → ${result.path}`,
      );
      res.json({ ...result, meta: metaPath });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

/** Split a kbRoot-relative path into `{space, spaceRel}`. Returns null
 *  when there's no space-relative remainder (i.e. the path is a bare
 *  space name with no file under it). */
function splitSpacePath(kbRel: string): { space: string; spaceRel: string } | null {
  const norm = kbRel.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = norm.indexOf('/');
  if (slash < 0) return null;
  const space = norm.slice(0, slash);
  const spaceRel = norm.slice(slash + 1).trim();
  if (!space || !spaceRel) return null;
  return { space, spaceRel };
}

// ---------- keyword search (ripgrep) ----------

interface KeywordMatch {
  /** 1-based line number, matches what every editor jump expects. */
  line: number;
  /** Line text (right-trimmed); truncated to 240 chars so the sidebar
   *  doesn't choke on minified HTML lines. */
  text: string;
  /** Byte ranges within `text` (post-truncation) the user query hit.
   *  Renderer uses these to `<mark>` the exact spans. */
  ranges: Array<[number, number]>;
}

interface KeywordHitFile {
  /** Space-relative POSIX path. */
  path: string;
  matches: KeywordMatch[];
  /** Match count for this file; may exceed `matches.length` when the
   *  per-file cap kicked in. */
  totalMatches: number;
}

interface KeywordSearchResult {
  files: KeywordHitFile[];
  totalMatches: number;
  truncated: boolean;
}

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

interface RecentFile {
  /** kbRoot-relative POSIX path. */
  path: string;
  /** `fs.statSync(...).mtimeMs` — milliseconds since epoch. */
  mtimeMs: number;
}

/** Hidden directories we never descend into. Mirrors
 *  `server/files.ts:HIDDEN_DOT_DIRS` plus `_files/` bundles which are
 *  attachments, not user-authored content. */
const RECENT_WALK_MAX_ENTRIES = 5000;

function walkForRecent(start: string, kbRoot: string): RecentFile[] {
  const out: RecentFile[] = [];
  const queue: string[] = [start];
  while (queue.length > 0 && out.length < RECENT_WALK_MAX_ENTRIES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
      if (e.name.endsWith('_files')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isNoteName(e.name)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      const rel = path.relative(kbRoot, abs).split(path.sep).join('/');
      out.push({ path: rel, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}
