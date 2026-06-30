/**
 * Library-wide routes. External agents talk in absolute source paths because
 * they may run in sandboxes that cannot read the user's local filesystem.
 * These routes are the host-side bridge for semantic search, index status,
 * orientation, library rules, and file CRUD.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { deleteDerivedForSource, derivedNoteFor } from '../derived-store.ts';
import { errorMessage, logger } from '../log.ts';
import { getFolderHome, memberFolderRoots, memberRootForAbs, resolveFolderRoot, runWithFolderRoot, toPosixAbs } from '../folder.ts';
import { indexer, syncFolderNow } from '../state.ts';
import { remapSearchHitsForDisplay } from '../search-display.ts';
import { getLibraryInfo } from '../library-info.ts';
import { sendError } from '../http.ts';
import { getApiKey } from '../app-config.ts';
import { contentSizeError, isCloudPlaceholderName, isIndexExcludedDirName } from '../indexable.ts';
import { detectFormat, detectViewerFormat, isDerivedNoteName, isImageFile } from '../format.ts';
import {
  deleteFile,
  derivedArtifactsForSource,
  fileVersion,
  listFiles,
  listFolders,
  pathExists,
  readText,
  renameOnDisk,
} from '../files.ts';
import { inFlightFileOperationError, saveFileContent } from './files.ts';
import { cancelConversion } from '../conversion.ts';
import { applyRenamePlan, planRenameLinks, type RenameEntry } from '../links.ts';
import { maybeConvertPdf } from '../pdf.ts';
import { maybeConvertImage } from '../image.ts';
import { clearRecord } from '../conversion-status.ts';

const log = logger('routes/library-files');

export interface LibrarySearchScope {
  /** Absolute root of the folder to scope to, or undefined for whole-library. */
  folderRoot?: string;
  /** Absolute path prefix to narrow to, or undefined. */
  pathPrefix?: string;
}

function requireMemberFolderRoot(ref: string): string {
  const root = resolveFolderRoot(ref);
  if (!memberFolderRoots().includes(root)) {
    throw routeError('folder is not in your folders', 404, 'FOLDER_NOT_FOUND');
  }
  return root;
}

export function normalizeLibrarySearchScope(folderRaw: unknown, pathPrefixRaw: unknown): LibrarySearchScope {
  const folderRef = typeof folderRaw === 'string' && folderRaw.trim() ? folderRaw.trim() : undefined;
  const folderRoot = folderRef ? requireMemberFolderRoot(folderRef) : undefined;
  const pathPrefix = typeof pathPrefixRaw === 'string' && pathPrefixRaw.trim()
    ? normalizeLibraryPathPrefix(pathPrefixRaw.trim())
    : undefined;
  return { folderRoot, pathPrefix };
}

export function requireLibraryStatusFolder(folderRaw: unknown): string | undefined {
  const folderRef = typeof folderRaw === 'string' && folderRaw.trim() ? folderRaw.trim() : undefined;
  return folderRef ? requireMemberFolderRoot(folderRef) : undefined;
}

export function mount(app: express.Express): void {
  // Hybrid search over the whole library (optional `folder` / `path_prefix`
  // filter). Powers MCP's `search_library`. Hidden `.md` files are remapped or
  // dropped (same rule as /api/search) so an external client never sees
  // an internal path.
  app.post('/api/library/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const { folderRoot, pathPrefix } = normalizeLibrarySearchScope(req.body?.folder, req.body?.path_prefix);
      if (!query) return res.status(400).json({ error: 'query required' });
      if (!getApiKey()) {
        return res.status(412).json({
          error: 'semantic search is disabled until you add an OpenAI API key',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
      // Members live anywhere, so hits carry their ABSOLUTE source path —
      // the unambiguous MCP identity the file tools accept. The base only
      // drives PDF page-marker resolution; absolute hits resolve regardless.
      const rawHits = await indexer.search(query, topK, folderRoot, pathPrefix);
      const hits = remapSearchHitsForDisplay(rawHits, toPosixAbs(getFolderHome()));
      res.json({ hits });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Index status for the whole library (or one `folder`). Powers the totals
  // MCP's `reindex` reports after a sweep.
  app.get('/api/library/index-status', async (req, res) => {
    try {
      const folderRoot = requireLibraryStatusFolder(req.query.folder);
      const status = await indexer.status(folderRoot);
      // Recently-indexed slice: intersect the indexed file set with
      // their on-disk mtime, return top N. Helps an agent answer "what
      // did I just embed?" without a state.db timestamp column. Paths are
      // absolute (members live anywhere).
      let recentlyIndexed: Array<{ path: string; mtimeMs: number }> = [];
      try {
        const indexed = await indexer.listFiles(folderRoot);
        const enriched: Array<{ path: string; mtimeMs: number }> = [];
        for (const abs of Object.keys(indexed)) {
          try {
            const st = fs.statSync(abs);
            enriched.push({ path: abs, mtimeMs: st.mtimeMs });
          } catch { /* file vanished — drop from list */ }
        }
        enriched.sort((a, b) => b.mtimeMs - a.mtimeMs);
        recentlyIndexed = enriched.slice(0, 10);
      } catch (err) {
        log.warn(`recently_indexed enrichment failed: ${errorMessage(err)}`);
      }
      res.json({
        ...status,
        recentlyIndexed,
      });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Reconcile one folder or the whole library. Powers MCP `reindex` while
  // keeping membership resolution inside the app server instead of the stdio
  // MCP host.
  app.post('/api/library/reindex', async (req, res) => {
    try {
      const folderRoot = requireLibraryStatusFolder(req.body?.folder ?? req.query.folder);
      const targets = folderRoot ? [folderRoot] : memberFolderRoots();
      const folders: Array<{ folder: string; added?: unknown; modified?: unknown; removed?: unknown; renamed?: unknown; failed?: unknown; error?: string }> = [];
      for (const target of targets) {
        try {
          const result = await syncFolderNow(target, { reason: 'mcp reindex' });
          folders.push({ folder: target, ...result });
        } catch (err: unknown) {
          folders.push({ folder: target, error: errorMessage(err) });
        }
      }
      let status: object = {};
      try {
        status = await indexer.status(folderRoot);
      } catch (err: unknown) {
        log.warn(`reindex status failed: ${errorMessage(err)}`);
      }
      res.json({ folders, ...status });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Library info = folder_home + folders. Powers MCP's `library_info` tool — the agent's
  // orientation card at the start of a session.
  app.get('/api/library/info', (_req, res) => {
    try {
      res.json(getLibraryInfo());
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Resolve the best file path to hand to a built-in agent for a visible
  // source file. PDFs use extracted Markdown for text context. HTML/images
  // keep the original source as the read path; their extracted text layers
  // are indexing inputs, not source replacements.
  app.get('/api/library/agent-context-file', async (req, res) => {
    try {
      res.json(await agentContextFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/directory', async (req, res) => {
    try {
      res.json(await listLibraryDirectory(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/library/file', async (req, res) => {
    try {
      res.json(await readLibraryFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/library/file', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const content = req.body?.content;
      if (typeof content !== 'string') throw routeError('content (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await writeLibraryFile(filePath, content, { baseVersion }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/library/file/edit', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const oldText = req.body?.old_text;
      const newText = req.body?.new_text;
      if (typeof oldText !== 'string') throw routeError('old_text (string) required', 400);
      if (typeof newText !== 'string') throw routeError('new_text (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await editLibraryFile(filePath, oldText, newText, {
        replaceAll: req.body?.replace_all === true,
        baseVersion,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.patch('/api/library/file/move', async (req, res) => {
    try {
      res.json(await moveLibraryFile(req.body?.path, req.body?.new_path, {
        cascade: req.body?.cascade !== false,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/library/file', async (req, res) => {
    try {
      res.json(await deleteLibraryFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

function normalizeLibraryPathPrefix(value: string): string {
  // Resolve to an absolute prefix and require it to live under a member folder.
  // Absolute paths are the normal API; non-absolute values are compatibility
  // refs under the default folder home.
  const abs = resolveLibraryAbs(value, { allowEmpty: false });
  if (!memberRootForAbs(abs)) {
    throw routeError('path_prefix must live under one of your folders', 400);
  }
  return abs;
}

interface LibraryPath {
  /** Absolute POSIX path — the MCP-facing identity + indexer/conversion key. */
  abs: string;
  /** Absolute root of the member folder that contains it. */
  folderRoot: string;
  /** Path within that folder (`docs/note.md`). */
  folderRel: string;
}

interface LibraryDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  format?: string;
  size?: number;
  version?: string;
}

export interface AgentContextFile {
  /** Absolute source path — the MCP/file-tool identity. */
  path: string;
  /** Display label of the member folder containing the source. */
  folder: string;
  /** Folder-relative visible source path (`paper.pdf`). */
  sourcePath: string;
  /** Path the agent should read first (folder-relative for text; an
   *  absolute app-data path for an extracted PDF/image note). */
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

/** Resolve a raw path to an absolute POSIX path, rejecting traversal / Windows /
 *  control chars. Absolute paths are the normal API; non-absolute values are
 *  compatibility refs under the default folder home. Does NOT check membership;
 *  callers do via `memberRootForAbs`. */
function resolveLibraryAbs(raw: unknown, opts: { allowEmpty: boolean }): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (opts.allowEmpty) return '';
    throw routeError('path required', 400);
  }
  if (value.includes('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw routeError('path must be a POSIX path', 400);
  }
  if (/[\x00-\x1f'"]/.test(value)) throw routeError('path contains invalid characters', 400);
  for (const seg of value.split('/')) {
    if (seg === '.' || seg === '..') throw routeError('path contains an invalid segment', 400);
  }
  const abs = path.isAbsolute(value) ? value : path.join(getFolderHome(), value);
  return toPosixAbs(abs);
}

export function normalizeLibraryFilePath(raw: unknown): LibraryPath {
  const abs = resolveLibraryAbs(raw, { allowEmpty: false });
  const folderRoot = memberRootForAbs(abs);
  if (!folderRoot) {
    throw routeError('path must live under one of your folders (call library_info to list them)', 400);
  }
  if (abs === folderRoot) {
    throw routeError('path must include a file path, not just the folder root', 400);
  }
  const folderRel = abs.slice(folderRoot.length + 1);
  if (isDerivedNoteName(folderRel)) {
    throw routeError('app-maintained derived notes are hidden; use the visible source file path', 403);
  }
  return { abs, folderRoot, folderRel };
}

function normalizeLibraryDirectoryPath(raw: unknown): { abs?: string; folderRoot?: string; folderRel?: string } {
  const abs = resolveLibraryAbs(raw, { allowEmpty: true });
  if (!abs) return {};
  const folderRoot = memberRootForAbs(abs);
  if (!folderRoot) {
    throw routeError('path must live under one of your folders (call library_info to list them)', 400);
  }
  return { abs, folderRoot, folderRel: abs === folderRoot ? '' : abs.slice(folderRoot.length + 1) };
}

function validateLibraryWritableFolderRel(folderRel: string): void {
  for (const seg of folderRel.split('/')) {
    if (isCloudPlaceholderName(seg)) {
      throw routeError('cannot write an iCloud placeholder; download the file locally first', 400, 'INVALID_FILE_WRITE');
    }
    if (seg === '.stashbase' || seg.startsWith('.stashbase-')) {
      throw routeError('cannot write into .stashbase', 400, 'INVALID_FILE_WRITE');
    }
    if (isIndexExcludedDirName(seg)) {
      throw routeError(`cannot write into excluded directory "${seg}"`, 400, 'INVALID_FILE_WRITE');
    }
  }
}

function routeError(message: string, status = 400, code?: string): Error {
  const err = new Error(message);
  (err as any).status = status;
  if (code) (err as any).code = code;
  return err;
}

export async function agentContextFile(rawPath: unknown): Promise<AgentContextFile> {
  const target = normalizeLibraryFilePath(rawPath);
  const folderName = path.basename(target.folderRoot);
  return runWithFolderRoot(target.folderRoot, async () => {
    const sourceFormat = detectViewerFormat(target.folderRel);
    if (!sourceFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    if (!pathExists(target.folderRel)) throw routeError('not found', 404);

    if (sourceFormat !== 'pdf') {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: true,
        reason: sourceFormat === 'image'
          ? 'Images are read as the source image; OCR text is used for search indexing.'
          : 'Structured text files are the readable source.',
      };
    }

    // The extracted Markdown note lives in per-machine app data (never
    // in the user's folder), so `readPath` here is an ABSOLUTE path the
    // built-in agent reads via its shell — not a folder-relative one.
    const derivedAbs = derivedNoteFor(target.abs);
    if (!fs.existsSync(derivedAbs)) {
      return {
        path: target.abs,
        folder: folderName,
        sourcePath: target.folderRel,
        readPath: target.folderRel,
        kind: 'direct',
        sourceFormat,
        available: false,
        reason: 'No extracted Markdown exists yet for this PDF; retry after conversion if you need text context.',
      };
    }

    return {
      path: target.abs,
      folder: folderName,
      sourcePath: target.folderRel,
      readPath: derivedAbs,
      kind: 'derived',
      sourceFormat,
      available: true,
      reason: 'Read the extracted Markdown note (an absolute app-data path) first for this PDF; use the original only when raw visual or binary detail is needed.',
    };
  });
}

export async function listLibraryDirectory(rawPath: unknown): Promise<{ path: string; entries: LibraryDirectoryEntry[] }> {
  const target = normalizeLibraryDirectoryPath(rawPath);
  if (!target.folderRoot) {
    // No path → list the member folders ("Your Folders"), each by its
    // absolute root, so the agent can drill into any of them.
    return {
      path: '',
      entries: memberFolderRoots()
        .map((root) => ({ name: path.basename(root), path: root, type: 'directory' as const }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  const folderRoot = target.folderRoot;
  return runWithFolderRoot(folderRoot, async () => {
    const prefix = target.folderRel ? target.folderRel.replace(/\/+$/, '') : '';
    if (prefix && !folderExists(prefix)) throw routeError('directory not found', 404);
    const children = new Map<string, LibraryDirectoryEntry>();
    for (const folder of listFolders()) {
      const child = immediateChild(prefix, folder.path);
      if (!child) continue;
      const entryPath = `${folderRoot}/${child.path}`;
      children.set(`d:${child.path}`, {
        name: child.name,
        path: entryPath,
        type: 'directory',
      });
    }
    for (const file of listFiles()) {
      const child = immediateFileChild(prefix, file.name);
      if (!child) continue;
      const entryPath = `${folderRoot}/${child.path}`;
      children.set(`f:${child.path}`, {
        name: child.name,
        path: entryPath,
        type: 'file',
        format: file.format,
        size: file.size,
        version: fileVersion(file.name) ?? undefined,
      });
    }
    return {
      path: target.abs ?? folderRoot,
      entries: [...children.values()].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
      ),
    };
  });
}

function folderExists(folderRel: string): boolean {
  try {
    return listFolders().some((f) => f.path === folderRel);
  } catch {
    return false;
  }
}

function immediateChild(prefix: string, relPath: string): { name: string; path: string } | null {
  if (prefix) {
    if (relPath === prefix || !relPath.startsWith(prefix + '/')) return null;
    relPath = relPath.slice(prefix.length + 1);
  }
  const first = relPath.split('/')[0];
  if (!first) return null;
  return {
    name: first,
    path: prefix ? `${prefix}/${first}` : first,
  };
}

function immediateFileChild(prefix: string, relPath: string): { name: string; path: string } | null {
  const child = immediateChild(prefix, relPath);
  if (!child) return null;
  return child.path === relPath ? child : null;
}

export async function readLibraryFile(rawPath: unknown): Promise<{
  path: string;
  format: string;
  content: string;
  version?: string;
  sourceFormat?: string;
  readPath?: string;
  derived?: boolean;
}> {
  const target = normalizeLibraryFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    const format = detectFormat(target.folderRel);
    if (!format) {
      const viewerFormat = detectViewerFormat(target.folderRel);
      if (viewerFormat === 'pdf') {
        const derivedAbs = derivedNoteFor(target.abs);
        let content: string;
        try {
          content = fs.readFileSync(derivedAbs, 'utf8');
        } catch {
          throw routeError('extracted Markdown is not available for this PDF yet; retry conversion or run reindex first', 409, 'CONVERSION_NOT_READY');
        }
        return {
          path: target.abs,
          format: 'pdf-derived-md',
          sourceFormat: 'pdf',
          readPath: derivedAbs,
          derived: true,
          content,
          version: fileVersion(target.folderRel) ?? undefined,
        };
      }
      if (viewerFormat === 'image') {
        throw routeError('read_file cannot return image bytes; image OCR text is used for search evidence, while the image remains the source file', 415, 'UNSUPPORTED_FORMAT');
      }
      throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    }
    const content = readText(target.folderRel);
    if (content == null) throw routeError('not found', 404);
    return {
      path: target.abs,
      format,
      content,
      version: fileVersion(target.folderRel) ?? undefined,
    };
  });
}

export async function writeLibraryFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string }> {
  const target = normalizeLibraryFilePath(rawPath);
  validateLibraryWritableFolderRel(target.folderRel);
  return runWithFolderRoot(target.folderRoot, async () => {
    const result = await saveFileContent(target.folderRel, content, opts);
    return { path: target.abs, ...result };
  });
}

export async function editLibraryFile(
  rawPath: unknown,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean; baseVersion?: string } = {},
): Promise<{ path: string; replacements: number; version?: string; indexWarning?: string }> {
  if (!oldText) throw routeError('old_text must not be empty', 400);
  const current = await readLibraryFile(rawPath);
  if (current.derived) {
    throw routeError('edit_file cannot edit derived PDF text; create or edit a Markdown/HTML source file instead', 415, 'UNSUPPORTED_FORMAT');
  }
  const count = countOccurrences(current.content, oldText);
  if (count === 0) throw routeError('old_text not found', 409, 'EDIT_MISMATCH');
  if (!opts.replaceAll && count > 1) {
    throw routeError('old_text matched multiple times; set replace_all=true or provide a more specific old_text', 409, 'EDIT_AMBIGUOUS');
  }
  const next = opts.replaceAll
    ? current.content.split(oldText).join(newText)
    : current.content.replace(oldText, newText);
  const written = await writeLibraryFile(rawPath, next, { baseVersion: opts.baseVersion ?? current.version });
  return { ...written, replacements: opts.replaceAll ? count : 1 };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = content.indexOf(needle, offset);
    if (idx < 0) return count;
    count++;
    offset = idx + needle.length;
  }
}

export async function moveLibraryFile(
  rawPath: unknown,
  rawNewPath: unknown,
  opts: { cascade?: boolean } = {},
): Promise<{ path: string; oldPath: string; linksUpdated: number; indexWarning?: string }> {
  const oldTarget = normalizeLibraryFilePath(rawPath);
  const newTarget = normalizeLibraryFilePath(rawNewPath);
  if (oldTarget.folderRoot !== newTarget.folderRoot) {
    throw routeError('move_file currently supports moves within the same folder only', 400);
  }
  validateLibraryWritableFolderRel(newTarget.folderRel);
  return runWithFolderRoot(oldTarget.folderRoot, async () => {
    const oldFormat = detectViewerFormat(oldTarget.folderRel);
    if (!oldFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    const oldStructuredFormat = detectFormat(oldTarget.folderRel);
    const newFormat = oldStructuredFormat ? detectFormat(newTarget.folderRel) : detectViewerFormat(newTarget.folderRel);
    if (newFormat !== oldFormat) {
      throw routeError(`new_path must keep a ${oldFormat} extension`, 400);
    }
    const inFlightError = inFlightFileOperationError(oldTarget.folderRel, 'rename');
    if (inFlightError) throw routeError(inFlightError.body.error, inFlightError.status, inFlightError.body.code);
    const viewerOnly = !oldStructuredFormat && (oldFormat === 'pdf' || oldFormat === 'image');
    const content = viewerOnly ? null : readText(oldTarget.folderRel);
    if (!viewerOnly && content == null) throw routeError('not found', 404);
    if (viewerOnly && !pathExists(oldTarget.folderRel)) throw routeError('not found', 404);
    if (pathExists(newTarget.folderRel)) throw routeError('target exists', 409);

    const oldDerivedArtifacts = derivedArtifactsForSource(oldTarget.folderRel);
    const renames: RenameEntry[] = [{ kind: 'file', old: oldTarget.folderRel, new: newTarget.folderRel }];
    const linkPlan = opts.cascade === false ? [] : planRenameLinks(renames);
    renameOnDisk(oldTarget.folderRel, newTarget.folderRel);
    const applied = opts.cascade === false ? null : applyRenamePlan(linkPlan);
    if (applied?.failed.length) {
      applied.rollback();
      renameOnDisk(newTarget.folderRel, oldTarget.folderRel);
      throw routeError(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`, 500);
    }

    let indexWarning: string | undefined;
    try {
      if (viewerOnly) {
        cancelConversion(oldTarget.abs);
        clearRecord(oldTarget.abs);
        clearRecord(newTarget.abs);
        try { deleteDerivedForSource(oldTarget.abs); } catch (err: unknown) {
          log.warn(`library move: old derived cleanup failed for ${oldTarget.abs}: ${errorMessage(err)}`);
        }
        try { deleteDerivedForSource(newTarget.abs); } catch (err: unknown) {
          log.warn(`library move: stale target derived cleanup failed for ${newTarget.abs}: ${errorMessage(err)}`);
        }
        await indexer.deleteFile(oldTarget.abs).catch((err) => {
          log.warn(`library move: failed to remove old source index row ${oldTarget.abs}: ${errorMessage(err)}`);
        });
        for (const rel of oldDerivedArtifacts.notes) {
          await indexer.deleteFile(`${oldTarget.folderRoot}/${rel}`).catch((err) => {
            log.warn(`library move: failed to remove legacy derived index row ${oldTarget.folderRoot}/${rel}: ${errorMessage(err)}`);
          });
        }
        try {
          if (oldFormat === 'pdf') maybeConvertPdf(newTarget.abs);
          else if (isImageFile(newTarget.folderRel)) maybeConvertImage(newTarget.abs);
        } catch (err: unknown) {
          log.warn(`library move: conversion kickoff failed for ${newTarget.abs}: ${errorMessage(err)}`);
        }
        indexWarning = 'Searchable text is being regenerated in the background.';
      } else if (!getApiKey()) {
        indexWarning = 'Semantic index was not updated because no OpenAI API key is configured.';
      } else {
        const movedContent = readText(newTarget.folderRel) ?? content ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.abs).catch((err) => {
            log.warn(`library move: failed to remove old index row ${oldTarget.abs}: ${errorMessage(err)}`);
          });
          indexWarning = `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        } else {
          await indexer.renameFile(oldTarget.abs, newTarget.abs, movedContent);
        }
      }
      for (const u of applied?.updated ?? []) {
        if (!getApiKey()) break;
        if (u.name === newTarget.folderRel) continue;
        const body = readText(u.name);
        if (body != null) await indexer.upsertFile(`${oldTarget.folderRoot}/${u.name}`, body);
      }
    } catch (err) {
      // The disk move has already happened; keep the user's file move
      // and report the semantic-index lag instead of trying to roll
      // back a valid filesystem operation after link rewrites.
      indexWarning = `Moved, but semantic index update failed: ${errorMessage(err)}`;
    }
    return {
      oldPath: oldTarget.abs,
      path: newTarget.abs,
      linksUpdated: linkPlan.reduce((acc, p) => acc + p.changes, 0),
      indexWarning,
    };
  });
}

export async function deleteLibraryFile(rawPath: unknown): Promise<{ path: string; alreadyGone: boolean }> {
  const target = normalizeLibraryFilePath(rawPath);
  return runWithFolderRoot(target.folderRoot, async () => {
    const inFlightError = inFlightFileOperationError(target.folderRel, 'delete');
    if (inFlightError) throw routeError(inFlightError.body.error, inFlightError.status, inFlightError.body.code);
    const derivedArtifacts = derivedArtifactsForSource(target.folderRel);
    const removed = deleteFile(target.folderRel);
    if (removed) cancelConversion(target.abs);
    if (removed) {
      try { deleteDerivedForSource(target.abs); }
      catch (err: unknown) { log.warn(`library delete: derived cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    }
    try { clearRecord(target.abs); }
    catch (err: unknown) { log.warn(`library delete: conversion status cleanup failed for ${target.abs}: ${errorMessage(err)}`); }
    if (removed && getApiKey()) {
      for (const rel of [target.folderRel, ...derivedArtifacts.notes]) {
        indexer.deleteFile(`${target.folderRoot}/${rel}`).catch((err) => {
          log.warn(`library delete: index cleanup failed for ${target.folderRoot}/${rel}: ${errorMessage(err)}`);
        });
      }
    }
    return { path: target.abs, alreadyGone: !removed };
  });
}
