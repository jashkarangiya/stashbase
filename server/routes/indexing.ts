/**
 * Indexing-related routes: hybrid search, manual full sync, the
 * lightweight status poll the UI uses to grey out pending files, and
 * the skills-sync route that mirrors `skills/<name>/SKILL.md` into the
 * active CLI's per-project prompt dir.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, logger } from '../log.ts';
import { fromKbRel, getCurrentSpace, getCurrentSpaceName, getKbRoot, isUnderRoot, toKbRel } from '../space.ts';
import { syncIndex } from '../sync.ts';
import { syncSkillsToCli } from '../skills.ts';
import { getInFlightPdfs, maybeConvertPdf } from '../pdf.ts';
import { clearRecord, listByStatus, readAll as readPdfStatus } from '../pdf-status.ts';
import { getFsChangeCounter } from '../watcher.ts';
import { getDaemon } from '../mfs-daemon.ts';
import { indexer } from '../state.ts';
import { getLibraryInfo, getLibraryOverview, setLibraryOverview } from '../library.ts';
import { sendError } from '../http.ts';

const log = logger('routes/indexing');

export function mount(app: express.Express): void {
  // Trigger a space sync manually — useful after external edits / file
  // moves. Returns the diff (added / removed / failed). Scoped to the
  // current space; cross-space syncs would happen automatically as
  // other spaces are opened.
  app.post('/api/sync', async (_req, res) => {
    try {
      const space = getCurrentSpaceName();
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
      // Daemon hits arrive kbRoot-relative; translate fileName back to
      // space-relative for the sidebar (which only knows the current
      // space). Hits outside the current space (shouldn't happen with
      // the space filter, defensive) get dropped.
      const out = space
        ? hits
            .map((h) => {
              const rel = fromKbRel(h.fileName);
              return rel == null ? null : { ...h, fileName: rel };
            })
            .filter((h): h is NonNullable<typeof h> => h !== null)
        : hits;
      res.json({ hits: out });
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
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
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
  // writes back to pdf-status.json with the new outcome; the client
  // polls /api/index-status or /api/pdf/status to observe the
  // result.
  app.post('/api/pdf/retry', (req, res) => {
    try {
      const rel = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!rel) return res.status(400).json({ error: 'path required' });
      const space = getCurrentSpace();
      if (!space) return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
      const abs = path.resolve(space, rel);
      if (!isUnderRoot(abs)) return res.status(400).json({ error: 'path escapes kbRoot' });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
      // Clear by KB-relative form (matches what maybeConvertPdf writes
      // when it spins back up).
      try {
        const kbRel = toKbRel(rel);
        clearRecord(kbRel);
      } catch { /* no current space — guarded above, defensive */ }
      // Also remove any stale converted note so maybeConvertPdf's
      // "skip if note exists" guard doesn't immediately bail. We
      // leave the .pdf in place (it's the source); the user's Retry
      // intent is to re-derive the .html / .md.
      const fmt = process.env.STASHBASE_PDF_FORMAT === 'md' ? 'md' : 'html';
      const stem = path.basename(abs, path.extname(abs));
      const dir = path.dirname(abs);
      const stale = path.join(dir, `${stem}.${fmt}`);
      try { fs.rmSync(stale, { force: true }); } catch { /* no stale to remove */ }
      const bundle = path.join(dir, `${stem}_files`);
      try { fs.rmSync(bundle, { recursive: true, force: true }); } catch { /* no bundle */ }
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
      if (!query) return res.status(400).json({ error: 'query required' });
      res.json({ hits: await indexer.search(query, topK, space) });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/index-status', async (req, res) => {
    try {
      const space = typeof req.query.space === 'string' && req.query.space.trim()
        ? req.query.space.trim() : undefined;
      res.json(await indexer.status(space));
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
      const args: Record<string, unknown> = {};
      if (space) args.space = space;
      const r = await getDaemon().call<{ files: Record<string, string> }>('list', args);
      res.json({ files: Object.keys(r.files).sort() });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Library overview (AGENT.md at kbRoot). The chrome-strip button in
  // the renderer GETs this as a regular markdown blob; MCP forwards
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

  // Read any file under kbRoot by kbRoot-relative path. Powers MCP's
  // `get_file` so an AI client can fetch a file outside the currently
  // open space. Refuses anything escaping the root.
  app.get('/api/library/file/*', (req, res) => {
    try {
      const rel = (req.params as any)[0] as string;
      if (!rel) return res.status(400).json({ error: 'path required' });
      const abs = path.resolve(getKbRoot(), rel);
      if (!isUnderRoot(abs)) return res.status(400).json({ error: 'path escapes kbRoot' });
      const content = fs.readFileSync(abs, 'utf8');
      res.json({ path: rel, content });
    } catch (err: unknown) {
      if ((err as any)?.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
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
      res.json(syncSkillsToCli(cur, cli));
    } catch (err: unknown) {
      sendError(res, err);
    }
    // Mark log as used (currently silent on the happy path).
    void log;
  });
}
