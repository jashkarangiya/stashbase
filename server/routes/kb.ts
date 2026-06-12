/**
 * KB-wide routes — the HTTP backend of the MCP surface. Everything here
 * speaks kbRoot-relative paths and accepts an optional `space` filter,
 * unlike the sidebar-facing space-scoped routes in `indexing.ts` /
 * `files.ts` (which resolve against the window's open space and return
 * space-relative paths). Split out of indexing.ts 2026-06 — these two
 * route families share a daemon but nothing else.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, logger } from '../log.ts';
import { getCurrentSpaceName, getKbRoot, isInsideKbRoot } from '../space.ts';
import { getApiKey } from '../app-config.ts';
import { indexer, getSnapshotWarning } from '../state.ts';
import { displayPathForHit } from '../pdf.ts';
import { extractEmbeddedResources } from '../resources.ts';
import { noteTreeChanged } from '../watcher.ts';
import { HIDDEN_DOT_DIRS } from '../files.ts';
import { isNoteName } from '../format.ts';
import {
  isReservedMetadataFile,
  setFileMetadataEntry,
  type FileMetadata,
} from '../metadata.ts';
import {
  getKbInfo,
  getKbOverview,
  getKbRules,
  getResolvedRules,
  getSpaceInfoFull,
  getSpaceRules,
  setKbOverview,
  setKbRules,
  setSpaceRules,
} from '../kb.ts';
import { sendError } from '../http.ts';

const log = logger('routes/kb');

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
            fs.writeFileSync(assetAbs, a.bytes);
          }
          log.info(`write ${rel}: extracted ${extracted.assets.length} embedded resource(s)`);
        }
      } catch (err: unknown) {
        log.warn(`write ${rel}: resource extraction failed: ${errorMessage(err)}`);
      }
      // Bump treeVersion after the write and fire indexing in the
      // background — the response returns before the index catches up
      // (indexDeferred).
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
