/**
 * Indexing-related routes: hybrid search, manual full sync, the
 * lightweight status poll the UI uses to grey out pending files, and
 * the skills-sync route that mirrors `skills/<name>/SKILL.md` into the
 * active CLI's per-project prompt dir.
 */
import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { errorMessage, logger } from '../log.ts';
import { fromKbRel, getCurrentSpace, getCurrentSpaceName, getKbRoot, isInsideKbRoot, toKbRel } from '../space.ts';
import { syncIndex } from '../sync.ts';
import { syncSkillsToCli } from '../skills.ts';
import { mirrorRulesToCli } from '../stashbase-md.ts';
import {
  isReservedMetadataFile,
  setFileMetadataEntry,
  type FileMetadata,
} from '../metadata.ts';
import { derivedPathsForPdf, getInFlightPdfs, maybeConvertPdf, pdfPathForDerivedRel } from '../pdf.ts';
import { clearRecord, listByStatus, readAll as readPdfStatus } from '../pdf-status.ts';
import { getFsChangeCounter } from '../watcher.ts';
import { getDaemon } from '../mfs-daemon.ts';
import { clearSnapshotWarning, getSnapshotWarning, indexer } from '../state.ts';
import { noteSelfWrite } from '../watcher.ts';
import {
  getKbRules,
  getLibraryInfo,
  getLibraryOverview,
  getResolvedRules,
  getSpaceInfoFull,
  getSpaceRules,
  setLibraryOverview,
  setSpaceRules,
} from '../library.ts';
import { sendError } from '../http.ts';

const log = logger('routes/indexing');

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
      const space = getCurrentSpaceName();
      const hits = await indexer.search(query, topK, space ?? undefined);
      const spaceRoot = getCurrentSpace();
      // Daemon hits arrive kbRoot-relative; translate fileName back to
      // space-relative for the sidebar (which only knows the current
      // space). Hits outside the current space (shouldn't happen with
      // the space filter, defensive) get dropped.
      //
      // Then rewrite any PDF-derived dot-prefixed note (`.paper.md`) to
      // point at its parent PDF — the derived file is hidden from the
      // sidebar so leaving it as the click target gives a dead row.
      // PdfPreview picks up the chunk text from pendingHighlight and
      // jumps the pdfjs find controller to the matching passage.
      const out = space
        ? hits
            .map((h) => {
              const rel = fromKbRel(h.fileName);
              if (rel == null) return null;
              const remapped = spaceRoot ? pdfPathForDerivedRel(rel, spaceRoot) : null;
              return { ...h, fileName: remapped ?? rel };
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
      res.json({ query, space: spaceName, ...result });
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
      // Drop `.pdf` from `pending`: PDFs are visible in the sidebar
      // (listFiles surfaces them) but never enter the index — keeping
      // them in `pending` would mean the sidebar permanently pulses
      // "indexing…" on every PDF row, since they'd never clear.
      const pending = status.pending
        .map((p) => fromKbRel(p))
        .filter((p): p is string => p != null)
        .filter((p) => !/\.pdf$/i.test(p));
      const orphaned = status.orphaned
        .map((p) => fromKbRel(p))
        .filter((p): p is string => p != null);
      // PDF status: space-scoped. `pendingConversions` keeps the old
      // shape (in-flight only) for backwards compatibility with the
      // sidebar "Converting…" indicator. `pdfFailures` surfaces the
      // persistent failure list so the UI can render Retry entries.
      const pdfFailures = listByStatus('failed')
        .map(({ path: kbRel, entry }) => {
          const rel = fromKbRel(kbRel);
          return rel == null ? null : { path: rel, lastError: entry.lastError ?? '', attempts: entry.attempts };
        })
        .filter((x): x is { path: string; lastError: string; attempts: number } => x !== null);
      res.json({
        ...status,
        pending,
        orphaned,
        pendingConversions: getInFlightPdfs(),
        pdfFailures,
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
      res.json({ entries: readPdfStatus() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // PDF Retry: take a space-relative path, clear its status record,
  // then fire the converter again. The fire-and-forget convert path
  // writes back to state.db with the new outcome; the client
  // polls /api/index-status or /api/pdf/status to observe the
  // result.
  app.post('/api/pdf/retry', (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!rel) return res.status(400).json({ error: 'path required' });
      const space = getCurrentSpace();
      if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const abs = path.resolve(space, rel);
      // PDFs can sit at any depth inside the space, so use the
      // file-level kbRoot containment check, not the space-boundary
      // `isUnderRoot` (which restricts to one-segment children). Also
      // verify the path actually resolves inside the space (not "..").
      const spaceRel = path.relative(space, abs);
      if (spaceRel.startsWith('..') || path.isAbsolute(spaceRel) || !isInsideKbRoot(abs)) {
        return res.status(400).json({ error: 'path escapes space' });
      }
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
      // Clear by KB-relative form (matches what maybeConvertPdf writes
      // when it spins back up).
      try {
        const kbRel = toKbRel(rel);
        clearRecord(kbRel);
      } catch { /* no current space — guarded above, defensive */ }
      // Also remove any stale derived files so maybeConvertPdf's
      // "skip if note exists" guard doesn't immediately bail. We
      // leave the .pdf in place (it's the source); the user's Retry
      // intent is to re-derive the dot-prefixed `.md` + image bundle.
      const { notePath: staleNote, bundleDir: staleBundle } = derivedPathsForPdf(abs);
      try { fs.rmSync(staleNote, { force: true }); } catch { /* no stale to remove */ }
      try { fs.rmSync(staleBundle, { recursive: true, force: true }); } catch { /* no bundle */ }
      maybeConvertPdf(abs, rel);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // --- Library-scoped endpoints (powered by the same single daemon) ---
  //
  // These are the cross-space surface used by MCP. They speak in
  // kbRoot-relative paths and accept an optional `space` filter so an
  // AI client can search the whole library by default, or narrow to one
  // space when needed. Kept separate from the sidebar-facing /api/search
  // / /api/index-status / /api/files routes (which are space-scoped and
  // return space-relative paths the UI consumes directly).
  app.post('/api/library/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const space = typeof req.body?.space === 'string' && req.body.space.trim()
        ? req.body.space.trim() : undefined;
      const pathPrefix = typeof req.body?.path_prefix === 'string' && req.body.path_prefix.trim()
        ? req.body.path_prefix.trim() : undefined;
      if (!query) return res.status(400).json({ error: 'query required' });
      // Same PDF-derived rewrite as /api/search, but against kb-root
      // since MCP callers (external AI clients) receive kbRoot-relative
      // paths and operate library-wide.
      const kbRoot = getKbRoot();
      const hits = (await indexer.search(query, topK, space, pathPrefix)).map((h) => {
        const remapped = pdfPathForDerivedRel(h.fileName, kbRoot);
        return { ...h, fileName: remapped ?? h.fileName };
      });
      res.json({ hits });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/index-status', async (req, res) => {
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

  // List indexed paths across the library (paths only — rich metadata
  // would require a filesystem walk per space and bloats the response).
  app.get('/api/library/files', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      const files = await indexer.listFiles(space);
      res.json({ files: Object.keys(files).sort() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Library 目录 (<kbRoot>/.stashbase/space-metadata.md). The LibraryPanel
  // in the renderer GETs this as a regular markdown blob; MCP forwards
  // both reads and writes here so the daemon shares one source of truth.
  app.get('/api/library/overview', (_req, res) => {
    res.json({ content: getLibraryOverview() });
  });

  app.post('/api/library/overview', (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    try {
      setLibraryOverview(content);
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Library info = overview + per-space structured facts. Powers MCP's
  // `library_info` tool — Claude reads this when deciding which space
  // to search.
  app.get('/api/library/info', async (_req, res) => {
    try {
      res.json(await getLibraryInfo());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Structured facts for ONE space + that space's slice of the library
  // 目录. Powers MCP's `space_info` tool — the per-space follow-up to
  // `library_info`.
  app.get('/api/library/space-info', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' ? req.query.space.trim() : '';
      if (!space) return res.status(400).json({ error: 'space required' });
      res.json(await getSpaceInfoFull(space));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Read/write one file's section of `<space>/.stashbase/file-metadata.md`
  // — the agent-maintained metadata sidecar kept out of the user's file.
  // Powers MCP's `set_file_metadata`. `path` is kbRoot-relative; the
  // first segment is the space, the rest the space-relative file path.
  // Passing an empty `metadata` object removes the section.
  app.post('/api/library/file-metadata', (req, res) => {
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
  // Separate from `/api/rules` so the LibraryPanel can show each
  // rules file as its own openable tab.
  app.get('/api/library/rules', (_req, res) => {
    try {
      res.json({ content: getKbRules() });
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
  app.get('/api/library/file/*', (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
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
  app.get('/api/library/recent-files', (req, res) => {
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
  // explicit overwrite" rule. Indexes the file synchronously so a
  // follow-up `search_kb` sees it immediately. Creates parent
  // directories as needed.
  app.put('/api/library/file/*', async (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
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
      // Mark before write so the watcher swallows the resulting fs
      // event — we've already upserted below; another sync would just
      // be a wasted scan_diff round-trip.
      noteSelfWrite(abs);
      fs.writeFileSync(abs, content);
      try { await indexer.upsertFile(rel, content); }
      catch (err) { log.warn(`upsert ${rel} failed after write: ${errorMessage(err)}`); }
      res.json({ path: rel });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Delete a file at a kbRoot-relative path. Powers MCP `delete_file`.
  // Mirrors the `/api/files/*` DELETE pattern: respond as soon as the
  // file is off disk, fire the index cleanup async (a stale chunk for
  // a few seconds is harmless and the next sync sweeps it anyway).
  app.delete('/api/library/file/*', (req, res) => {
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
  app.patch('/api/library/file/*', async (req, res) => {
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

  // Export the current space's chunks to a portable Parquet snapshot
  // at `<space>/.stashbase/snapshot.parquet`. Downstream consumers
  // auto-import on bind (see `maybeImportSnapshot` in state.ts).
  app.post('/api/space/export-snapshot', async (_req, res) => {
    try {
      const cur = getCurrentSpace();
      if (!cur) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const spaceName = getCurrentSpaceName();
      if (!spaceName) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const outPath = path.join(cur, '.stashbase', 'snapshot.parquet');
      const result = await getDaemon().call<{
        path: string;
        chunks: number;
        providers: { provider: string; dim: number; chunks: number }[];
      }>('export_space', { space: spaceName, out_path: outPath });
      log.info(
        `snapshot export ${spaceName}: ${result.chunks} chunk(s) → ${result.path}`,
      );
      res.json(result);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Mirror `skills/<name>/SKILL.md` into the active CLI's per-project
  // prompt directory (Claude Code's `.claude/commands/` or Codex's
  // `.codex/prompts/`). The renderer fires this on terminal panel
  // open / CLI switch so the user can author commands once under
  // `skills/` and have them appear for whichever CLI they pick.
  app.post('/api/skills/sync', (req, res) => {
    const cur = getCurrentSpace();
    if (!cur) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    const cli = req.body?.cli;
    if (cli !== 'claude' && cli !== 'codex') {
      return res.status(400).json({ error: 'cli must be "claude" or "codex"' });
    }
    try {
      const result = syncSkillsToCli(cur, cli);
      // Same trigger mirrors the merged STASHBASE.md rules into the
      // space's CLAUDE.md / AGENTS.md so a CLI agent reads them too.
      try { mirrorRulesToCli(cur); }
      catch (err: unknown) { log.warn(`mirror rules failed: ${errorMessage(err)}`); }
      res.json(result);
    } catch (err: unknown) {
      sendError(res, err);
    }
    // Mark log as used (currently silent on the happy path).
    void log;
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
  /** true → `--word-regexp` (only match whole words, so "agent" won't
   *  match "agents"). */
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
      '--max-count', String(RG_PER_FILE_CAP),
      '--max-filesize', '5M',
      '--glob', '*.md',
      '--glob', '*.markdown',
      '--glob', '*.html',
      '--glob', '*.htm',
    ];
    if (opts.wholeWord) args.push('--word-regexp');
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
        // Center the visible snippet around the first match so highlight
        // ranges stay inside the window for long lines (e.g. 500-char
        // markdown paragraphs). Without this, a match at position 400
        // gets truncated away and the user sees no `<mark>`.
        let windowStart = 0;
        if (stripped.length > RG_MAX_LINE_CHARS && subs.length > 0) {
          const firstStart = typeof subs[0]?.start === 'number' ? subs[0].start : 0;
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
        for (const s of subs) {
          if (typeof s?.start !== 'number' || typeof s?.end !== 'number') continue;
          // Shift each match into snippet-local coordinates and skip
          // anything that fell entirely outside the visible window.
          const localStart = s.start - windowStart + leading.length;
          const localEnd = s.end - windowStart + leading.length;
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
        bucket.totalMatches += 1;
        if (total < RG_TOTAL_CAP) {
          bucket.matches.push({ line: lineNum, text, ranges });
          total += 1;
        } else {
          truncated = true;
        }
      }
      const files = Array.from(byFile.values()).sort((a, b) => a.path.localeCompare(b.path));
      resolve({ files, totalMatches: total, truncated });
    });
  });
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
const RECENT_WALK_SKIP = new Set([
  '.stashbase', '.git', '.DS_Store', '.Trashes',
  '.Spotlight-V100', '.fseventsd', '.AppleDouble', '.TemporaryItems',
]);
const RECENT_WALK_INDEXABLE = /\.(md|markdown|html|htm)$/i;
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
      if (e.name.startsWith('.') && RECENT_WALK_SKIP.has(e.name)) continue;
      if (e.name.endsWith('_files')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!RECENT_WALK_INDEXABLE.test(e.name)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      const rel = path.relative(kbRoot, abs).split(path.sep).join('/');
      out.push({ path: rel, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}
