/**
 * File-level routes: list, CRUD, asset streaming, rename (with link
 * cascade + rollback), reveal-in-OS, and per-folder manual ordering.
 *
 * `/asset/*` lives here too because it's the same address space as
 * `/api/files/*` (both serve from the active space root) and they
 * share the MIME table + HTML scroll-bootstrap behaviour.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml } from '../html.ts';
import { contentSizeError } from '../indexable.ts';
import {
  createTextExclusive,
  deleteFile,
  detectFormat,
  getSpaceName,
  listFiles,
  listFolders,
  readText,
  renameOnDisk,
  resolveAsset,
  resolveExisting,
  sanitizeFilename,
  saveText,
} from '../files.ts';
import { isNoteName } from '../format.ts';
import { readFileOrder, setFolderOrder } from '../file-order.ts';
import { cascadeRenameLinks, planRenameLinks, type RenameEntry } from '../links.ts';
import { getCurrentSpace, toKbRel } from '../space.ts';
import { getApiKey } from '../app-config.ts';
import { errorMessage, logger } from '../log.ts';
import { indexer } from '../state.ts';
import { sendError, revealInOsFileManager } from '../http.ts';
import { bundleRenameEntry, renameWithRollback } from '../rename-helpers.ts';

const log = logger('routes/files');

/** Asset content-type table, used by /asset/*. Anything outside the
 *  table falls back to application/octet-stream — the renderer's
 *  iframe / image tags hint MIME via attribute and rarely care. */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export function mount(app: express.Express): void {
  // ----- list -----
  app.get('/api/files', (_req, res) => {
    try {
      res.json({
        space: getSpaceName(),
        files: listFiles(),
        folders: listFolders(),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- create -----
  // Body: { name?, content?, dir?, format? }.
  //  - `name` omitted → auto-pick first free `untitled-N.<ext>` (race-safe via O_EXCL).
  //  - `dir`  optional → place the file inside that space-relative folder
  //    (must already exist; create with POST /api/folders first).
  //  - `format` optional → `'md'` (default) or `'html'`. Decides the
  //    extension when one isn't supplied via `name`. The renderer's
  //    "+" picker uses this so users can pick the format at create
  //    time rather than getting `.md` whether they want it or not.
  app.post('/api/files', async (req, res) => {
    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
    const format = req.body?.format === 'html' ? 'html' : 'md';
    const ext = format === 'html' ? '.html' : '.md';
    const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
    try {
      let name: string;
      if (requestedName) {
        // Honour an extension the caller already typed; otherwise
        // attach the format-derived one. Both .md and .html count
        // as recognised extensions.
        const hasExt = isNoteName(requestedName);
        const base = hasExt ? requestedName : requestedName + ext;
        // Silently scrub characters that break cross-platform sync —
        // user keeps the original title in the file's first heading.
        name = sanitizeFilename(prefix + base);
        if (!createTextExclusive(name, content)) {
          return res.status(409).json({ error: 'file exists' });
        }
      } else {
        const MAX_TRIES = 10_000;
        let i = 1;
        let claimed = '';
        for (; i <= MAX_TRIES; i++) {
          const candidate = `${prefix}untitled-${i}${ext}`;
          if (createTextExclusive(candidate, content)) {
            claimed = candidate;
            break;
          }
        }
        if (!claimed) throw new Error(`could not find a free untitled-N (tried ${MAX_TRIES})`);
        name = claimed;
      }
      // New notes with empty content are common (sidebar `+` button); skip
      // indexing them to avoid round-tripping a no-op to the sidecar.
      if (content.trim()) {
        await indexer.upsertFile(toKbRel(name), content);
      }
      res.json({ name, content });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- read -----
  app.get('/api/files/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      // Refuse anything that isn't a markdown / HTML note. Bundle assets
      // (the PNG / CSS / WOFF that live alongside an arxiv html in its
      // `_files/` folder) get saved to disk so the iframe can pull them
      // via `/asset/*`, but they're not viewable through this route —
      // a `readText` of binary bytes would otherwise hand the editor
      // garbled UTF-8 to render.
      const format = detectFormat(name);
      if (!format) return res.status(415).json({ error: 'unsupported format' });
      const content = readText(name);
      if (content == null) return res.status(404).json({ error: 'not found' });
      // Raw HTML in `content` (what the editor needs); the preview iframe
      // loads its prepared version via `/asset/*` — keeping injected ids +
      // bootstrap script out of the bytes that round-trip through the
      // editor (otherwise autosave would rewrite the file to include them).
      res.json({ name, format, content });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- write -----
  // Overwrite a file's content and rebuild its index entry. `upsertFile`
  // deletes existing rows for this source before inserting the freshly
  // chunked + embedded set, so a save reflects edits cleanly.
  app.put('/api/files/*', async (req, res) => {
    const content = (req.body ?? {}).content;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) required' });
    }
    const name = (req.params as any)[0] as string;
    try {
      saveText(name, content);
      await indexer.upsertFile(toKbRel(name), content);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- rename -----
  // Disk rename via `fs.rename` (POSIX atomic on same FS), then re-embed
  // the body under the new `source` — MFS has no in-place "update source"
  // yet, so this is full re-embed. Uses the same `renameWithRollback`
  // ladder as folder rename: if the index update fails, undo the disk
  // rename so the next request lands on the same state the caller saw.
  app.patch('/api/files/*', async (req, res) => {
    const oldName = (req.params as any)[0] as string;
    const requested = typeof req.body?.new_name === 'string' ? req.body.new_name.trim() : '';
    if (!requested) return res.status(400).json({ error: 'new_name required' });
    // Preserve the source file's extension — renaming `foo.html` should
    // not silently produce `foo.html.md`. If the user typed their own
    // recognised extension, honor it (cross-format rename is rare but
    // shouldn't be blocked here; conversion has its own dedicated route).
    let newName = requested;
    if (!detectFormat(newName)) {
      const oldExt = oldName.match(/\.[^./]+$/)?.[0] ?? '.md';
      newName += oldExt;
    }
    newName = sanitizeFilename(newName);
    if (newName === oldName) return res.json({ name: oldName, linksUpdated: 0 });
    const content = readText(oldName);
    if (content == null) return res.status(404).json({ error: 'not found' });
    if (readText(newName) != null) return res.status(409).json({ error: 'target exists' });

    // Cascade is opt-out per call — the client confirms via a dialog
    // backed by `/api/rename-preview`. Default to true so callers
    // (MCP, scripts) get the safe behavior without needing to know
    // about the flag.
    const cascadeOn = req.body?.cascade !== false;
    const asyncIndex = req.body?.async_index === true;
    let linksUpdated = 0;

    const updateLinksAndIndex = async (): Promise<string | undefined> => {
        // Cascade BEFORE the renamed file's own re-embed so any link
        // rewrites in its body are picked up by the single upsert below.
        let updated: Array<{ name: string; changes: number }> = [];
        if (cascadeOn) {
          const renames: RenameEntry[] = [{ kind: 'file', old: oldName, new: newName }];
          const bundleEntry = bundleRenameEntry(oldName, newName, 'post');
          if (bundleEntry) renames.push(bundleEntry);
          const cascade = cascadeRenameLinks(renames);
          linksUpdated = cascade.updated.length;
          updated = cascade.updated;
        }
        if (!getApiKey()) {
          log.info(`rename: skipped index update for ${oldName} -> ${newName} because no OpenAI key is configured`);
          return 'Semantic index was not updated because no OpenAI API key is configured.';
        }
        const tooLarge = contentSizeError(content);
        if (tooLarge) {
          await indexer.deleteFile(toKbRel(oldName)).catch((err) => {
            log.warn(`rename: failed to remove old index row for oversized file ${oldName}: ${errorMessage(err)}`);
          });
          log.warn(`rename: skipped index update for ${newName}: ${tooLarge}`);
          return `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        }
        if (updated.length) {
          // Re-embed each external file whose links we rewrote. The
          // renamed file itself gets re-embedded by `renameFile` below
          // (which also cleans up its old-path row), so skip it here to
          // avoid the wasted double-embed.
          for (const u of updated) {
            if (u.name === newName) continue;
            const body = readText(u.name);
            if (body == null) continue;
            await indexer.upsertFile(toKbRel(u.name), body);
          }
        }
        await indexer.renameFile(toKbRel(oldName), toKbRel(newName), content);
        return undefined;
    };

    if (asyncIndex) {
      try {
        renameOnDisk(oldName, newName);
      } catch (err: unknown) {
        sendError(res, err);
        return;
      }
      const warning = contentSizeError(content);
      const noKey = !getApiKey();
      res.json({
        name: newName,
        linksUpdated,
        indexDeferred: !warning && !noKey,
        indexWarning: warning
          ? `${warning}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`
          : undefined,
      });
      updateLinksAndIndex().catch((err: unknown) => {
        log.warn(`rename: background index update failed for ${oldName} -> ${newName}: ${errorMessage(err)}`);
      });
      return;
    }

    let indexWarning: string | undefined;
    await renameWithRollback({
      kind: 'file',
      from: oldName,
      to: newName,
      res,
      doDisk: () => renameOnDisk(oldName, newName),
      undoDisk: () => renameOnDisk(newName, oldName),
      doIndex: async () => {
        indexWarning = await updateLinksAndIndex();
      },
      okResponse: () => ({ name: newName, linksUpdated, indexWarning }),
    });
  });

  // ----- delete -----
  app.delete('/api/files/*', async (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      const removed = deleteFile(name);
      // Respond as soon as the file is off disk. Milvus row cleanup is
      // fired async — if the daemon is busy (e.g. mid-embed of an
      // upload), waiting for the queue here would freeze the UI delete.
      // A stale chunk row pointing at a missing file for a few seconds
      // is harmless: search filters by file_name on read and the next
      // sync sweeps orphans.
      res.json({ alreadyGone: !removed });
      indexer.deleteFile(toKbRel(name)).catch((err) => {
        log.warn(`delete: index cleanup failed for ${name}: ${errorMessage(err)}`);
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- rename preview -----
  // Dry-run cross-reference count for a proposed rename. The client
  // calls this to power the VSCode-style "Update N references in M
  // files?" dialog before committing the actual rename. Read-only.
  app.post('/api/rename-preview', (req, res) => {
    const kind = req.body?.kind === 'folder' ? 'folder' : 'file';
    const oldPath = typeof req.body?.old === 'string' ? req.body.old.trim() : '';
    const newPath = typeof req.body?.new === 'string' ? req.body.new.trim() : '';
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'old and new required' });
    }
    if (oldPath === newPath) {
      return res.json({ files: 0, links: 0 });
    }
    const renames: RenameEntry[] = [{ kind, old: oldPath, new: newPath }];
    if (kind === 'file') {
      const bundle = bundleRenameEntry(oldPath, newPath, 'pre');
      if (bundle) renames.push(bundle);
    }
    try {
      const plan = planRenameLinks(renames);
      res.json({
        files: plan.length,
        links: plan.reduce((acc, p) => acc + p.changes, 0),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- reveal in OS -----
  // The renderer sends the space-relative name and we resolve + shell
  // out here. Fire-and-forget spawn; we just confirm the file exists
  // before launching.
  app.post('/api/reveal/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      const abs = resolveExisting(name);
      if (!abs) return res.status(404).json({ error: 'not found' });
      revealInOsFileManager(abs);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- per-folder manual ordering -----
  // `GET` returns the whole map so the renderer can hand it to
  // `buildTree` once on space load. `PUT` updates one folder atomically
  // (renderer fires this after each successful drag-to-reorder).
  app.get('/api/file-order', (_req, res) => {
    if (!getCurrentSpace()) {
      return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    }
    try {
      res.json(readFileOrder());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/file-order', (req, res) => {
    if (!getCurrentSpace()) {
      return res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    }
    const parentPath = typeof req.body?.parentPath === 'string' ? req.body.parentPath : null;
    const names = req.body?.names;
    if (parentPath == null) {
      return res.status(400).json({ error: 'parentPath required (string, "" for root)' });
    }
    if (!Array.isArray(names) || !names.every((s) => typeof s === 'string')) {
      return res.status(400).json({ error: 'names must be string[]' });
    }
    try {
      setFolderOrder(parentPath, names);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- asset streaming -----
  // Serves files in the space directly (HTML, images, CSS, fonts, …).
  // Used as the `src` of the HTML preview iframe so relative URLs like
  // `<img src="X_files/figure.png">` resolve to other files in the
  // same `_files/` bundle (arxiv "Save Page As Complete" layout). HTML
  // responses go through `analyzeHtml` so the prepared bytes carry the
  // scroll-bootstrap script + heading ids for in-doc anchor scrolling.
  app.get('/asset/*', (req, res) => {
    const rel = (req.params as any)[0] as string;
    const abs = resolveAsset(rel);
    if (!abs) return res.status(404).end();
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        const { preparedHtml } = analyzeHtml(raw);
        res.type('text/html').send(preparedHtml);
      } catch (err: unknown) {
        sendError(res, err);
      }
      return;
    }
    res.type(MIME[ext] ?? 'application/octet-stream');
    fs.createReadStream(abs).pipe(res);
  });
}
