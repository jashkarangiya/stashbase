/**
 * Folder CRUD: create / delete (recursive) / rename. Rename uses the
 * shared `renameWithRollback` ladder + a cross-reference link cascade
 * so anchors elsewhere in the folder still resolve after the move.
 */
import express from 'express';
import {
  createFolder,
  deleteFolder,
  listIndexableTextFilesUnder,
  listFiles,
  readText,
  renameFolder,
  sanitizeFilename,
} from '../files.ts';
import { applyRenamePlan, planRenameLinks } from '../links.ts';
import { toSourcePath } from '../folder.ts';
import { getApiKey } from '../app-config.ts';
import { errorMessage, logger } from '../log.ts';
import { indexer } from '../state.ts';
import { sendError } from '../http.ts';
import { renameWithRollback } from '../rename-helpers.ts';
import { noteTreeChanged } from '../watcher.ts';
import { remapFileOrderPath, removeFileOrderPath } from '../file-order.ts';
import { clearRecordsUnder, hasInFlightUnder } from '../conversion-status.ts';
import { deleteDerivedUnderFolder } from '../derived-store.ts';

const log = logger('routes/folders');

type InFlightFolderAction = 'rename' | 'delete';

export interface InFlightFolderRouteError {
  status: 409;
  body: {
    error: string;
    code: 'CONVERSION_IN_FLIGHT';
  };
}

export function inFlightFolderOperationError(p: string, action: InFlightFolderAction): InFlightFolderRouteError | null {
  if (!hasInFlightUnder(toSourcePath(p))) return null;
  const actionText = action === 'rename' ? 'Rename it' : 'Delete it';
  return {
    status: 409,
    body: {
      error: `This folder contains files that are still processing. ${actionText} after processing finishes.`,
      code: 'CONVERSION_IN_FLIGHT',
    },
  };
}

export function mount(app: express.Express): void {
  app.post('/api/folders', (req, res) => {
    const requested = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!requested) return res.status(400).json({ error: 'path required' });
    try {
      if (!createFolder(requested)) return res.status(409).json({ error: 'folder exists' });
      noteTreeChanged();
      res.json({ path: requested });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/folders/*', (req, res) => {
    const p = (req.params as any)[0] as string;
    try {
      const inFlightError = inFlightFolderOperationError(p, 'delete');
      if (inFlightError) return res.status(inFlightError.status).json(inFlightError.body);
      // Recursive delete on disk — the route layer trusts the UI's
      // confirm prompt to be the guardrail against "oops, I just
      // wiped a populated folder". Index cleanup fires async so we
      // can respond fast (same fire-and-forget pattern as file delete).
      try { deleteDerivedUnderFolder(toSourcePath(p)); }
      catch (err: unknown) { log.warn(`delete_prefix: derived cleanup failed for ${p}: ${errorMessage(err)}`); }
      const removed = deleteFolder(p);
      if (removed) {
        noteTreeChanged();
        try { removeFileOrderPath(p, 'folder'); }
        catch (err: unknown) { log.warn(`file-order cleanup failed for ${p}: ${errorMessage(err)}`); }
      }
      try { clearRecordsUnder(toSourcePath(p)); }
      catch (err: unknown) { log.warn(`delete_prefix: conversion status cleanup failed for ${p}: ${errorMessage(err)}`); }
      res.json({ alreadyGone: !removed });
      indexer.deletePathPrefix(toSourcePath(p)).catch((err) => {
        log.warn(`delete_prefix: index cleanup failed for ${p}: ${errorMessage(err)}`);
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Rename a folder. Body: { new_name }. `new_name` is the new basename
  // (kept in the same parent); cross-parent moves are out of scope. Disk
  // rename first, then bring the index along by re-embedding every file
  // under the old prefix at its new path (slow — see mfs.md §B3).
  // If the index step fails, roll back the disk rename.
  app.patch('/api/folders/*', async (req, res) => {
    const oldPath = (req.params as any)[0] as string;
    const requested = typeof req.body?.new_name === 'string' ? req.body.new_name.trim() : '';
    if (!requested) return res.status(400).json({ error: 'new_name required' });
    if (requested.includes('/')) {
      return res.status(400).json({ error: 'new_name must not contain "/"' });
    }
    const lastSlash = oldPath.lastIndexOf('/');
    const parent = lastSlash >= 0 ? oldPath.slice(0, lastSlash + 1) : '';
    const newPath = sanitizeFilename(parent + requested);
    if (newPath === oldPath) return res.json({ path: oldPath });
    const inFlightError = inFlightFolderOperationError(oldPath, 'rename');
    if (inFlightError) return res.status(inFlightError.status).json(inFlightError.body);
    const cascadeOn = req.body?.cascade !== false;
    const linkPlan = cascadeOn ? planRenameLinks([{ kind: 'folder', old: oldPath, new: newPath }]) : [];

    await renameWithRollback({
      kind: 'folder',
      from: oldPath,
      to: newPath,
      res,
      doDisk: () => renameFolder(oldPath, newPath),
      undoDisk: () => renameFolder(newPath, oldPath),
      doIndex: async () => {
        const applied = cascadeOn ? applyRenamePlan(linkPlan) : null;
        try {
          if (applied?.failed.length) {
            throw new Error(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`);
          }

          if (!getApiKey()) {
            log.info(`rename_folder: skipped index update for ${oldPath} -> ${newPath} because no OpenAI key is configured`);
            return;
          }
          // Cascade BEFORE the index call so files whose links we rewrite
          // are embedded with their fresh content — saves a second round of
          // embed for everything inside the renamed folder.
          // Re-collect bodies from the new locations (cascade may have
          // rewritten some). renamePathPrefix's contract takes OLD-keyed
          // entries, so we map new → old names.
          const filesUnder = listIndexableTextFilesUnder(newPath)
            .map((f) => ({
              // Indexer's renamePathPrefix takes OLD-keyed absolute paths.
              path: toSourcePath(oldPath + f.name.slice(newPath.length)),
              content: f.content,
            }));
          await indexer.renamePathPrefix(toSourcePath(oldPath), toSourcePath(newPath), filesUnder);

          // Files OUTSIDE the renamed folder that had links rewritten
          // need a separate upsert — the prefix rename only touches rows
          // under oldPath.
          for (const u of applied?.updated ?? []) {
            if (u.name === newPath || u.name.startsWith(newPath + '/')) continue;
            const body = readText(u.name);
            if (body == null) continue;
            await indexer.upsertFile(toSourcePath(u.name), body);
          }
        } catch (err) {
          applied?.rollback();
          throw err;
        }
      },
      okResponse: () => {
        noteTreeChanged();
        try { remapFileOrderPath(oldPath, newPath, 'folder'); }
        catch (err: unknown) { log.warn(`file-order remap failed for ${oldPath} -> ${newPath}: ${errorMessage(err)}`); }
        return { path: newPath };
      },
    });
  });
}
