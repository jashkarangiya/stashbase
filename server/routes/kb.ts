/**
 * KB-wide routes. The MCP surface needs only two things the filesystem
 * can't give an agent — semantic search and index status — plus the
 * `kb_info` orientation card; those are `/api/kb/search`,
 * `/api/kb/index-status`, and `/api/kb/info`. `/api/kb/rules` is the
 * renderer's KB-level STASHBASE.md editor. Everything else (file CRUD,
 * per-space rules) is plain file I/O the agent / GUI does directly.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, logger } from '../log.ts';
import { getKbRoot } from '../space.ts';
import { indexer, getSnapshotWarning } from '../state.ts';
import { displayPathForHit } from '../pdf.ts';
import { getKbInfo, getKbRules, setKbRules } from '../kb.ts';
import { sendError } from '../http.ts';
import { getApiKey } from '../app-config.ts';

const log = logger('routes/kb');

export function mount(app: express.Express): void {
  // Hybrid search over the whole KB (optional `space` / `path_prefix`
  // filter). Powers MCP's `search_kb`. Hidden `.md` files are remapped or
  // dropped (same rule as /api/search) so an external client never sees
  // an internal path.
  app.post('/api/kb/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const space = typeof req.body?.space === 'string' && req.body.space.trim()
        ? req.body.space.trim() : undefined;
      const pathPrefix = typeof req.body?.path_prefix === 'string' && req.body.path_prefix.trim()
        ? req.body.path_prefix.trim() : undefined;
      if (!query) return res.status(400).json({ error: 'query required' });
      if (!getApiKey()) {
        return res.status(412).json({
          error: 'semantic search is disabled until you add an OpenAI API key',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
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

  // Index status for the whole KB (or one `space`). Powers the totals
  // MCP's `reindex` reports after a sweep.
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
      res.json({
        ...status,
        snapshotWarning: space ? getSnapshotWarning(space) : null,
        recentlyIndexed,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // KB info = kb_root + spaces + rules. Powers MCP's `kb_info` tool —
  // the agent's orientation card at the start of a session.
  app.get('/api/kb/info', (_req, res) => {
    try {
      res.json(getKbInfo());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // KB-level STASHBASE.md content. Powers the renderer's "STASHBASE.md"
  // row in the Knowledge base section.
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
}
