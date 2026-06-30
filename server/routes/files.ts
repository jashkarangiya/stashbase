/**
 * File-level routes: list, CRUD, asset streaming, rename (with link
 * cascade + rollback), reveal-in-OS, and per-folder manual ordering.
 *
 * `/asset/*` lives here too because it's the same address folder as
 * `/api/files/*` (both serve from the active folder root) and they
 * share the MIME table + HTML scroll-bootstrap behaviour.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml } from '../html.ts';
import { contentSizeError, isCloudPlaceholderName, isIndexExcludedDirName } from '../indexable.ts';
import {
  createTextExclusive,
  derivedArtifactsForSource,
  deleteFile,
  detectFormat,
  fileVersion,
  getCurrentFolderBasename,
  listFiles,
  listFolders,
  pathExists,
  readText,
  renameOnDisk,
  resolveAsset,
  resolveExisting,
  sanitizeFilename,
  saveText,
} from '../files.ts';
import { detectViewerFormat, isDerivedNoteName, isImageFile, isNoteName } from '../format.ts';
import { readFileOrder, remapFileOrderPath, removeFileOrderPath, setFolderOrder } from '../file-order.ts';
import { applyRenamePlan, planRenameLinks, type RenameEntry } from '../links.ts';
import { getCurrentFolder, getCurrentFolderLabel, toSourcePath } from '../folder.ts';
import { getApiKey } from '../app-config.ts';
import { errorMessage, logger } from '../log.ts';
import { indexer } from '../state.ts';
import { sendError, revealInOsFileManager } from '../http.ts';
import { bundleRenameEntry, renameWithRollback } from '../rename-helpers.ts';
import { maybeConvertImage } from '../image.ts';
import { maybeConvertPdf } from '../pdf.ts';
import { cancelConversion } from '../conversion.ts';
import { noteTreeChanged } from '../watcher.ts';
import { clearRecord, isInFlight } from '../conversion-status.ts';
import { deleteDerivedForSource } from '../derived-store.ts';

const log = logger('routes/files');

type InFlightFileAction = 'rename' | 'delete';

export interface InFlightRouteError {
  status: 409;
  body: {
    error: string;
    code: 'CONVERSION_IN_FLIGHT';
  };
}

export function inFlightFileOperationError(name: string, action: InFlightFileAction): InFlightRouteError | null {
  if (action === 'delete') return null;
  if (!isInFlight(toSourcePath(name))) return null;
  const verb = action === 'rename' ? 'Rename' : 'Delete';
  return {
    status: 409,
    body: {
      error: `This file is still processing. ${verb} it after processing finishes.`,
      code: 'CONVERSION_IN_FLIGHT',
    },
  };
}

function fileWriteError(message: string, status = 400, code = 'INVALID_FILE_WRITE'): Error {
  const err = new Error(message);
  (err as any).status = status;
  (err as any).code = code;
  return err;
}

export function validateEditableFileWrite(name: string): void {
  const normalized = name.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) throw fileWriteError('path required');
  for (const seg of normalized.split('/')) {
    if (seg === '.' || seg === '..') throw fileWriteError('invalid path segment');
    if (isCloudPlaceholderName(seg)) {
      throw fileWriteError('cannot save an iCloud placeholder; download the file locally first');
    }
    if (seg === '.stashbase' || seg.startsWith('.stashbase-')) {
      throw fileWriteError('cannot write into .stashbase');
    }
    if (isIndexExcludedDirName(seg)) {
      throw fileWriteError(`cannot write into excluded directory "${seg}"`);
    }
  }
  if (isDerivedNoteName(normalized)) {
    throw fileWriteError('cannot edit app-maintained derived notes');
  }
  if (!detectFormat(normalized)) {
    throw fileWriteError('unsupported editable format', 415, 'UNSUPPORTED_FORMAT');
  }
}

export function fileHeadStatus(name: string): number {
  const format = detectViewerFormat(name);
  if (!format) return 415;
  if (!pathExists(name)) return 404;
  return 204;
}

async function upsertSavedFile(name: string, content: string): Promise<string | undefined> {
  if (!getApiKey()) {
    log.info(`save: skipped index update for ${name} because no OpenAI key is configured`);
    return undefined;
  }
  if (!content.trim()) {
    await indexer.deleteFile(toSourcePath(name)).catch((err) => {
      log.warn(`save: failed to remove empty file from index ${name}: ${errorMessage(err)}`);
    });
    return undefined;
  }
  const tooLarge = contentSizeError(content);
  if (tooLarge) {
    await indexer.deleteFile(toSourcePath(name)).catch((err) => {
      log.warn(`save: failed to remove oversized file from index ${name}: ${errorMessage(err)}`);
    });
    log.warn(`save: skipped index update for ${name}: ${tooLarge}`);
    return `${tooLarge}. Semantic search will skip it until you split or reduce it and run sync.`;
  }
  try {
    await indexer.upsertFile(toSourcePath(name), content);
    return undefined;
  } catch (err: unknown) {
    const msg = errorMessage(err);
    log.warn(`save: index update failed for ${name}: ${msg}`);
    return `Saved, but semantic index update failed: ${msg}`;
  }
}

export async function saveFileContent(
  name: string,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ indexWarning?: string; version?: string }> {
  validateEditableFileWrite(name);
  if (opts.baseVersion !== undefined) {
    const currentVersion = fileVersion(name);
    if (currentVersion !== opts.baseVersion) {
      if (readText(name) === content) {
        return { version: currentVersion ?? undefined };
      }
      const err = new Error('file changed on disk; reload before saving');
      (err as any).code = 'FILE_CHANGED';
      (err as any).currentVersion = currentVersion;
      throw err;
    }
  }
  saveText(name, content);
  const indexWarning = await upsertSavedFile(name, content);
  noteTreeChanged();
  return { indexWarning, version: fileVersion(name) ?? undefined };
}

async function handleWriteFile(req: express.Request, res: express.Response): Promise<void> {
  const content = (req.body ?? {}).content;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) required' });
    return;
  }
  const name = (req.params as any)[0] as string;
  const baseVersion = typeof (req.body ?? {}).baseVersion === 'string'
    ? (req.body ?? {}).baseVersion
    : undefined;
  try {
    res.json(await saveFileContent(name, content, { baseVersion }));
  } catch (err: unknown) {
    sendError(res, err);
  }
}

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
        folder: getCurrentFolderLabel() ?? getCurrentFolderBasename(),
        files: listFiles(),
        folders: listFolders(),
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- create -----
  // Body: { name?, content?, dir? }.
  //  - `name` omitted → auto-pick first free `untitled-N.md` (race-safe via O_EXCL).
  //  - `dir`  optional → place the file inside that folder-relative folder
  //    (must already exist; create with POST /api/folders first).
  // New notes are always Markdown — it's the only editable format (HTML
  // files are viewable but no longer authored here).
  app.post('/api/files', async (req, res) => {
    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
    const ext = '.md';
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
      const indexWarning = await upsertSavedFile(name, content);
      noteTreeChanged();
      res.json({ name, content, indexWarning, version: fileVersion(name) ?? undefined });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.head('/api/files/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      res.sendStatus(fileHeadStatus(name));
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
      res.json({ name, format, content, version: fileVersion(name) ?? undefined });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // ----- write -----
  // Overwrite a file's content and rebuild its index entry. `upsertFile`
  // deletes existing rows for this source before inserting the freshly
  // chunked + embedded set, so a save reflects edits cleanly.
  app.put('/api/files/*', async (req, res) => {
    await handleWriteFile(req, res);
  });

  // `navigator.sendBeacon()` always sends POST. The renderer uses it in
  // `beforeunload` for the last unsaved buffer, so accept POST on the
  // file-specific path as an unload-safe alias for PUT. Creation remains
  // `POST /api/files` above; this wildcard route does not match that
  // exact path.
  app.post('/api/files/*', async (req, res) => {
    await handleWriteFile(req, res);
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
    const oldFormat = detectViewerFormat(oldName);
    if (!oldFormat) return res.status(415).json({ error: 'unsupported format' });
    const inFlightError = inFlightFileOperationError(oldName, 'rename');
    if (inFlightError) return res.status(inFlightError.status).json(inFlightError.body);
    const oldStructuredFormat = detectFormat(oldName);
    const viewerOnly = !oldStructuredFormat && (oldFormat === 'pdf' || oldFormat === 'image');
    // Preserve the source file's extension — renaming `foo.html` should
    // not silently produce `foo.html.md`. For binary viewer files, keep
    // the viewer extension too; `detectFormat()` intentionally excludes
    // those, so use the wider viewer detector here.
    let newName = requested;
    const requestedHasCompatibleExt = oldStructuredFormat
      ? detectFormat(newName) !== null
      : detectViewerFormat(newName) === oldFormat;
    if (!requestedHasCompatibleExt) {
      const oldExt = oldName.match(/\.[^./]+$/)?.[0] ?? '.md';
      newName += oldExt;
    }
    newName = sanitizeFilename(newName);
    if (newName === oldName) return res.json({ name: oldName, linksUpdated: 0 });
    const content = viewerOnly ? null : readText(oldName);
    if (!viewerOnly && content == null) return res.status(404).json({ error: 'not found' });
    if (viewerOnly && !pathExists(oldName)) return res.status(404).json({ error: 'not found' });
    if (pathExists(newName)) return res.status(409).json({ error: 'target exists' });
    const oldDerivedArtifacts = derivedArtifactsForSource(oldName);

    // Cascade is opt-out per call — the client confirms via a dialog
    // backed by `/api/rename-preview`. Default to true so callers
    // (MCP, scripts) get the safe behavior without needing to know
    // about the flag.
    const cascadeOn = req.body?.cascade !== false;
    const asyncIndex = req.body?.async_index === true;
    const renames: RenameEntry[] = [{ kind: 'file', old: oldName, new: newName }];
    const bundleEntry = bundleRenameEntry(oldName, newName, 'pre');
    if (bundleEntry) renames.push(bundleEntry);
    const linkPlan = cascadeOn ? planRenameLinks(renames) : [];
    let linksUpdated = 0;

    const updateLinksAndIndex = async (opts: { rollbackLinksOnFailure: boolean }): Promise<string | undefined> => {
      const applied = cascadeOn ? applyRenamePlan(linkPlan) : null;
      linksUpdated = applied?.updated.length ?? 0;
      try {
        if (applied?.failed.length) {
          throw new Error(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`);
        }
        // Cascade BEFORE the renamed file's own re-embed so any link
        // rewrites in its body are picked up by the single upsert below.
        const reindexUpdatedLinks = async () => {
          for (const u of applied?.updated ?? []) {
            if (u.name === newName) continue;
            const body = readText(u.name);
            if (body == null) continue;
            await indexer.upsertFile(toSourcePath(u.name), body);
          }
        };
        if (viewerOnly) {
          const oldSourceAbs = toSourcePath(oldName);
          const newSourceAbs = toSourcePath(newName);
          cancelConversion(oldSourceAbs);
          clearRecord(oldSourceAbs);
          clearRecord(newSourceAbs);
          try { deleteDerivedForSource(oldSourceAbs); } catch (err: unknown) {
            log.warn(`rename: old derived cleanup failed for ${oldName}: ${errorMessage(err)}`);
          }
          try { deleteDerivedForSource(newSourceAbs); } catch (err: unknown) {
            log.warn(`rename: stale target derived cleanup failed for ${newName}: ${errorMessage(err)}`);
          }
          await indexer.deleteFile(oldSourceAbs).catch((err) => {
            log.warn(`rename: failed to remove old source index row ${oldName}: ${errorMessage(err)}`);
          });
          for (const rel of oldDerivedArtifacts.notes) {
            await indexer.deleteFile(toSourcePath(rel)).catch((err) => {
              log.warn(`rename: failed to remove legacy derived index row ${rel}: ${errorMessage(err)}`);
            });
          }
          if (getApiKey()) await reindexUpdatedLinks();
          try {
            if (oldFormat === 'pdf') maybeConvertPdf(newSourceAbs);
            else if (isImageFile(newName)) maybeConvertImage(newSourceAbs);
          } catch (err: unknown) {
            log.warn(`rename: conversion kickoff failed for ${newName}: ${errorMessage(err)}`);
          }
          return 'Searchable text is being regenerated in the background.';
        }
        if (!getApiKey()) {
          log.info(`rename: skipped index update for ${oldName} -> ${newName} because no OpenAI key is configured`);
          return 'Semantic index was not updated because no OpenAI API key is configured.';
        }
        const tooLarge = contentSizeError(content ?? '');
        if (tooLarge) {
          await indexer.deleteFile(toSourcePath(oldName)).catch((err) => {
            log.warn(`rename: failed to remove old index row for oversized file ${oldName}: ${errorMessage(err)}`);
          });
          log.warn(`rename: skipped index update for ${newName}: ${tooLarge}`);
          return `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        }
        if (applied?.updated.length) await reindexUpdatedLinks();
        await indexer.renameFile(toSourcePath(oldName), toSourcePath(newName), content ?? '');
        return undefined;
      } catch (err) {
        if (opts.rollbackLinksOnFailure) applied?.rollback();
        throw err;
      }
    };

    if (asyncIndex) {
      try {
        renameOnDisk(oldName, newName);
      } catch (err: unknown) {
        sendError(res, err);
        return;
      }
      noteTreeChanged();
      try { remapFileOrderPath(oldName, newName, 'file'); }
      catch (err: unknown) { log.warn(`file-order remap failed for ${oldName} -> ${newName}: ${errorMessage(err)}`); }
      const warning = viewerOnly ? null : contentSizeError(content ?? '');
      const noKey = !getApiKey();
      res.json({
        name: newName,
        linksUpdated: linkPlan.length,
        indexDeferred: !warning && !noKey,
        indexWarning: warning
          ? `${warning}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`
          : undefined,
      });
      updateLinksAndIndex({ rollbackLinksOnFailure: false }).catch((err: unknown) => {
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
        indexWarning = await updateLinksAndIndex({ rollbackLinksOnFailure: true });
      },
      okResponse: () => {
        noteTreeChanged();
        try { remapFileOrderPath(oldName, newName, 'file'); }
        catch (err: unknown) { log.warn(`file-order remap failed for ${oldName} -> ${newName}: ${errorMessage(err)}`); }
        return { name: newName, linksUpdated, indexWarning };
      },
    });
  });

  // ----- delete -----
  app.delete('/api/files/*', async (req, res) => {
    const name = (req.params as any)[0] as string;
    try {
      const inFlightError = inFlightFileOperationError(name, 'delete');
      if (inFlightError) return res.status(inFlightError.status).json(inFlightError.body);
      const derivedArtifacts = derivedArtifactsForSource(name);
      const removed = deleteFile(name);
      // Respond as soon as the file is off disk. Milvus row cleanup is
      // fired async — if the daemon is busy (e.g. mid-embed of an
      // upload), waiting for the queue here would freeze the UI delete.
      // A stale chunk row pointing at a missing file for a few seconds
      // is harmless: search filters by file_name on read and the next
      // sync sweeps orphans.
      if (removed) {
        noteTreeChanged();
        cancelConversion(toSourcePath(name));
        try { deleteDerivedForSource(toSourcePath(name)); }
        catch (err: unknown) { log.warn(`delete: derived cleanup failed for ${name}: ${errorMessage(err)}`); }
        try { removeFileOrderPath(name, 'file'); }
        catch (err: unknown) { log.warn(`file-order cleanup failed for ${name}: ${errorMessage(err)}`); }
      }
      try { clearRecord(toSourcePath(name)); }
      catch (err: unknown) { log.warn(`delete: conversion status cleanup failed for ${name}: ${errorMessage(err)}`); }
      res.json({ alreadyGone: !removed });
      for (const rel of [name, ...derivedArtifacts.notes]) {
        indexer.deleteFile(toSourcePath(rel)).catch((err) => {
          log.warn(`delete: index cleanup failed for ${rel}: ${errorMessage(err)}`);
        });
      }
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
  // The renderer sends the folder-relative name and we resolve + shell
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
  // `buildTree` once on folder load. `PUT` updates one folder atomically
  // (renderer fires this after each successful drag-to-reorder).
  app.get('/api/file-order', (_req, res) => {
    if (!getCurrentFolder()) {
      return res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
    }
    try {
      res.json(readFileOrder());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/file-order', (req, res) => {
    if (!getCurrentFolder()) {
      return res.status(412).json({ error: 'no folder open', code: 'NO_FOLDER' });
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
  // Serves files in the folder directly (HTML, images, CSS, fonts, …).
  // Used as the `src` of the HTML preview iframe so relative URLs like
  // `<img src="X_files/figure.png">` resolve to other files in the
  // same `_files/` bundle (arxiv "Save Page As Complete" layout). HTML
  // responses go through `analyzeHtml` so the prepared bytes carry the
  // scroll-bootstrap script + heading ids for in-doc anchor scrolling.
  app.get('/asset/*', (req, res) => {
    const rel = stripAssetWindowPrefix((req.params as any)[0] as string);
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
    if (ext === '.webm' || ext === '.mp4' || ext === '.mov' || ext === '.m4v') {
      // Video needs Range support for seeking — sendFile handles
      // Accept-Ranges / 206 responses; a piped stream can't seek.
      return res.sendFile(abs);
    }
    res.type(MIME[ext] ?? 'application/octet-stream');
    fs.createReadStream(abs).pipe(res);
  });
}

function stripAssetWindowPrefix(rel: string): string {
  if (!rel.startsWith('__window/')) return rel;
  const slash = rel.indexOf('/', '__window/'.length);
  return slash >= 0 ? rel.slice(slash + 1) : '';
}
