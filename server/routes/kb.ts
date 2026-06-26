/**
 * KB-wide routes. MCP talks in kbRoot-relative paths (`Space/note.md`)
 * because external agents may run in sandboxes that cannot see the
 * user's local filesystem. These routes are the host-side bridge for
 * semantic search, index status, orientation, KB rules, and file CRUD.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, logger } from '../log.ts';
import { getKbRoot, requireSpaceExistsByName, runWithSpaceName } from '../space.ts';
import { indexer, getSnapshotWarning } from '../state.ts';
import { remapSearchHitsForDisplay } from '../search-display.ts';
import { getKbInfo, getKbRules, kbRulesVersion, setKbRules } from '../kb.ts';
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

const log = logger('routes/kb');

export interface KbSearchScope {
  space?: string;
  pathPrefix?: string;
}

export function normalizeKbSearchScope(spaceRaw: unknown, pathPrefixRaw: unknown): KbSearchScope {
  const space = typeof spaceRaw === 'string' && spaceRaw.trim() ? spaceRaw.trim() : undefined;
  const pathPrefix = typeof pathPrefixRaw === 'string' && pathPrefixRaw.trim()
    ? normalizeKbPathPrefix(pathPrefixRaw.trim())
    : undefined;
  if (space) requireSpaceExistsByName(space);
  if (pathPrefix) {
    const first = pathPrefix.split('/')[0];
    requireSpaceExistsByName(first);
  }
  return { space, pathPrefix };
}

export function requireKbStatusSpace(spaceRaw: unknown): string | undefined {
  const space = typeof spaceRaw === 'string' && spaceRaw.trim() ? spaceRaw.trim() : undefined;
  if (space) requireSpaceExistsByName(space);
  return space;
}

export function mount(app: express.Express): void {
  // Hybrid search over the whole KB (optional `space` / `path_prefix`
  // filter). Powers MCP's `search_kb`. Hidden `.md` files are remapped or
  // dropped (same rule as /api/search) so an external client never sees
  // an internal path.
  app.post('/api/kb/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      const topK = Number.isFinite(req.body?.top_k) ? Number(req.body.top_k) : 8;
      const { space, pathPrefix } = normalizeKbSearchScope(req.body?.space, req.body?.path_prefix);
      if (!query) return res.status(400).json({ error: 'query required' });
      if (!getApiKey()) {
        return res.status(412).json({
          error: 'semantic search is disabled until you add an OpenAI API key',
          code: 'EMBEDDER_KEY_REQUIRED',
        });
      }
      const hits = remapSearchHitsForDisplay(
        await indexer.search(query, topK, space, pathPrefix),
        getKbRoot(),
      );
      res.json({ hits });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Index status for the whole KB (or one `space`). Powers the totals
  // MCP's `reindex` reports after a sweep.
  app.get('/api/kb/index-status', async (req, res) => {
    try {
      const space = requireKbStatusSpace(req.query.space);
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

  // Resolve the best file path to hand to a built-in agent for a visible
  // source file. Binary sources keep their visible path for context, but
  // prefer the hidden extracted Markdown note when it already exists.
  app.get('/api/kb/agent-context-file', async (req, res) => {
    try {
      res.json(await agentContextFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // KB-level STASHBASE.md content. Powers the renderer's "STASHBASE.md"
  // row in the Knowledge base section.
  app.get('/api/kb/rules', (_req, res) => {
    try {
      res.json({ content: getKbRules(), version: kbRulesVersion() ?? undefined });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/kb/rules', (req, res) => {
    if (typeof req.body?.content !== 'string') {
      return res.status(400).json({ error: 'content (string) required' });
    }
    const content = req.body.content;
    const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
    try {
      res.json({ ok: true, version: setKbRules(content, { baseVersion }) ?? undefined });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/kb/directory', async (req, res) => {
    try {
      res.json(await listKbDirectory(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/kb/file', async (req, res) => {
    try {
      res.json(await readKbFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.put('/api/kb/file', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const content = req.body?.content;
      if (typeof content !== 'string') throw routeError('content (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await writeKbFile(filePath, content, { baseVersion }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.post('/api/kb/file/edit', async (req, res) => {
    try {
      const filePath = req.body?.path;
      const oldText = req.body?.old_text;
      const newText = req.body?.new_text;
      if (typeof oldText !== 'string') throw routeError('old_text (string) required', 400);
      if (typeof newText !== 'string') throw routeError('new_text (string) required', 400);
      const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
      res.json(await editKbFile(filePath, oldText, newText, {
        replaceAll: req.body?.replace_all === true,
        baseVersion,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.patch('/api/kb/file/move', async (req, res) => {
    try {
      res.json(await moveKbFile(req.body?.path, req.body?.new_path, {
        cascade: req.body?.cascade !== false,
      }));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/kb/file', async (req, res) => {
    try {
      res.json(await deleteKbFile(req.query.path));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

function normalizeKbPathPrefix(value: string): string {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    throw new Error('path_prefix must be kbRoot-relative POSIX path');
  }
  const norm = value.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!norm) throw new Error('path_prefix required');
  if (/[\x00-\x1f'"]/.test(norm)) throw new Error('path_prefix contains invalid characters');
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error('path_prefix contains an invalid segment');
  }
  const abs = path.join(getKbRoot(), norm);
  const rel = path.relative(getKbRoot(), abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path_prefix escapes kb_root');
  }
  return norm;
}

interface KbPath {
  kbRel: string;
  space: string;
  spaceRel: string;
}

interface KbDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  format?: string;
  size?: number;
  version?: string;
}

export interface AgentContextFile {
  /** KB-relative source path (`Space/paper.pdf`) for HTTP/MCP callers. */
  path: string;
  /** Space name containing the visible source file. */
  space: string;
  /** Space-relative visible source path (`paper.pdf`). */
  sourcePath: string;
  /** Space-relative path the agent should read first. */
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

export function normalizeKbFilePath(raw: unknown): KbPath {
  const kbRel = normalizeKbRelativePath(raw, { allowEmpty: false });
  const slash = kbRel.indexOf('/');
  if (slash <= 0 || slash === kbRel.length - 1) {
    throw routeError('path must include a space and file path, e.g. "Space/note.md"', 400);
  }
  const space = kbRel.slice(0, slash);
  const spaceRel = kbRel.slice(slash + 1);
  requireSpaceExistsByName(space);
  if (isDerivedNoteName(spaceRel)) {
    throw routeError('app-maintained derived notes are hidden; use the visible source file path', 403);
  }
  return { kbRel, space, spaceRel };
}

function normalizeKbDirectoryPath(raw: unknown): { kbRel: string; space?: string; spaceRel?: string } {
  const kbRel = normalizeKbRelativePath(raw, { allowEmpty: true });
  if (!kbRel) return { kbRel: '' };
  const slash = kbRel.indexOf('/');
  const space = slash >= 0 ? kbRel.slice(0, slash) : kbRel;
  requireSpaceExistsByName(space);
  const spaceRel = slash >= 0 ? kbRel.slice(slash + 1) : '';
  return { kbRel, space, spaceRel };
}

function normalizeKbRelativePath(raw: unknown, opts: { allowEmpty: boolean }): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (opts.allowEmpty) return '';
    throw routeError('path required', 400);
  }
  let pathValue = value;
  if (path.isAbsolute(value)) {
    const abs = path.resolve(value);
    const rel = path.relative(getKbRoot(), abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw routeError('absolute path must live under kb_root', 400);
    }
    pathValue = rel.split(path.sep).join('/');
  } else if (/^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    throw routeError('path must be kbRoot-relative POSIX path', 400);
  }
  const norm = pathValue.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!norm) {
    if (opts.allowEmpty) return '';
    throw routeError('path required', 400);
  }
  if (/[\x00-\x1f'"]/.test(norm)) throw routeError('path contains invalid characters', 400);
  for (const seg of norm.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw routeError('path contains an invalid segment', 400);
  }
  const abs = path.join(getKbRoot(), norm);
  const rel = path.relative(getKbRoot(), abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw routeError('path escapes kb_root', 400);
  }
  return norm;
}

function validateKbWritableSpaceRel(spaceRel: string): void {
  for (const seg of spaceRel.split('/')) {
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
  const target = normalizeKbFilePath(rawPath);
  return runWithSpaceName(target.space, async () => {
    const sourceFormat = detectViewerFormat(target.spaceRel);
    if (!sourceFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    if (!pathExists(target.spaceRel)) throw routeError('not found', 404);

    if (sourceFormat !== 'pdf' && sourceFormat !== 'image') {
      return {
        path: target.kbRel,
        space: target.space,
        sourcePath: target.spaceRel,
        readPath: target.spaceRel,
        kind: 'direct',
        sourceFormat,
        available: true,
        reason: 'Structured text files are the readable source.',
      };
    }

    const derivedNote = derivedArtifactsForSource(target.spaceRel).notes.find((rel) => readText(rel) != null);
    if (!derivedNote) {
      return {
        path: target.kbRel,
        space: target.space,
        sourcePath: target.spaceRel,
        readPath: target.spaceRel,
        kind: 'direct',
        sourceFormat,
        available: false,
        reason: `No extracted Markdown exists yet for this ${sourceFormat}; retry after conversion if you need text context.`,
      };
    }

    return {
      path: target.kbRel,
      space: target.space,
      sourcePath: target.spaceRel,
      readPath: derivedNote,
      kind: 'derived',
      sourceFormat,
      available: true,
      reason: `Read the extracted Markdown/OCR note first for this ${sourceFormat}; use the original only when raw visual or binary detail is needed.`,
    };
  });
}

export async function listKbDirectory(rawPath: unknown): Promise<{ path: string; entries: KbDirectoryEntry[] }> {
  const target = normalizeKbDirectoryPath(rawPath);
  if (!target.space) {
    return {
      path: '',
      entries: fs.readdirSync(getKbRoot(), { withFileTypes: true })
        .filter((e) => {
          if (!e.isDirectory() || e.name.startsWith('.')) return false;
          try { requireSpaceExistsByName(e.name); return true; }
          catch { return false; }
        })
        .map((e) => ({ name: e.name, path: e.name, type: 'directory' as const }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  return runWithSpaceName(target.space, async () => {
    const prefix = target.spaceRel ? target.spaceRel.replace(/\/+$/, '') : '';
    if (prefix && !folderExists(prefix)) throw routeError('directory not found', 404);
    const children = new Map<string, KbDirectoryEntry>();
    for (const folder of listFolders()) {
      const child = immediateChild(prefix, folder.path);
      if (!child) continue;
      const kbPath = `${target.space}/${child.path}`;
      children.set(`d:${child.path}`, {
        name: child.name,
        path: kbPath,
        type: 'directory',
      });
    }
    for (const file of listFiles()) {
      const child = immediateFileChild(prefix, file.name);
      if (!child) continue;
      const kbPath = `${target.space}/${child.path}`;
      children.set(`f:${child.path}`, {
        name: child.name,
        path: kbPath,
        type: 'file',
        format: file.format,
        size: file.size,
        version: fileVersion(file.name) ?? undefined,
      });
    }
    return {
      path: target.kbRel,
      entries: [...children.values()].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
      ),
    };
  });
}

function folderExists(spaceRel: string): boolean {
  try {
    return listFolders().some((f) => f.path === spaceRel);
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

export async function readKbFile(rawPath: unknown): Promise<{
  path: string;
  format: string;
  content: string;
  version?: string;
}> {
  const target = normalizeKbFilePath(rawPath);
  return runWithSpaceName(target.space, async () => {
    const format = detectFormat(target.spaceRel);
    if (!format) {
      if (detectViewerFormat(target.spaceRel)) {
        throw routeError('read_file supports Markdown and HTML text files; binary files are view-only', 415, 'UNSUPPORTED_FORMAT');
      }
      throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    }
    const content = readText(target.spaceRel);
    if (content == null) throw routeError('not found', 404);
    return {
      path: target.kbRel,
      format,
      content,
      version: fileVersion(target.spaceRel) ?? undefined,
    };
  });
}

export async function writeKbFile(
  rawPath: unknown,
  content: string,
  opts: { baseVersion?: string } = {},
): Promise<{ path: string; version?: string; indexWarning?: string }> {
  const target = normalizeKbFilePath(rawPath);
  validateKbWritableSpaceRel(target.spaceRel);
  return runWithSpaceName(target.space, async () => {
    const result = await saveFileContent(target.spaceRel, content, opts);
    return { path: target.kbRel, ...result };
  });
}

export async function editKbFile(
  rawPath: unknown,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean; baseVersion?: string } = {},
): Promise<{ path: string; replacements: number; version?: string; indexWarning?: string }> {
  if (!oldText) throw routeError('old_text must not be empty', 400);
  const current = await readKbFile(rawPath);
  const count = countOccurrences(current.content, oldText);
  if (count === 0) throw routeError('old_text not found', 409, 'EDIT_MISMATCH');
  if (!opts.replaceAll && count > 1) {
    throw routeError('old_text matched multiple times; set replace_all=true or provide a more specific old_text', 409, 'EDIT_AMBIGUOUS');
  }
  const next = opts.replaceAll
    ? current.content.split(oldText).join(newText)
    : current.content.replace(oldText, newText);
  const written = await writeKbFile(rawPath, next, { baseVersion: opts.baseVersion ?? current.version });
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

export async function moveKbFile(
  rawPath: unknown,
  rawNewPath: unknown,
  opts: { cascade?: boolean } = {},
): Promise<{ path: string; oldPath: string; linksUpdated: number; indexWarning?: string }> {
  const oldTarget = normalizeKbFilePath(rawPath);
  const newTarget = normalizeKbFilePath(rawNewPath);
  if (oldTarget.space !== newTarget.space) {
    throw routeError('move_file currently supports moves within the same space only', 400);
  }
  validateKbWritableSpaceRel(newTarget.spaceRel);
  return runWithSpaceName(oldTarget.space, async () => {
    const oldFormat = detectViewerFormat(oldTarget.spaceRel);
    if (!oldFormat) throw routeError('unsupported format', 415, 'UNSUPPORTED_FORMAT');
    const oldStructuredFormat = detectFormat(oldTarget.spaceRel);
    const newFormat = oldStructuredFormat ? detectFormat(newTarget.spaceRel) : detectViewerFormat(newTarget.spaceRel);
    if (newFormat !== oldFormat) {
      throw routeError(`new_path must keep a ${oldFormat} extension`, 400);
    }
    const inFlightError = inFlightFileOperationError(oldTarget.spaceRel, 'rename');
    if (inFlightError) throw routeError(inFlightError.body.error, inFlightError.status, inFlightError.body.code);
    const viewerOnly = !oldStructuredFormat && (oldFormat === 'pdf' || oldFormat === 'image');
    const content = viewerOnly ? null : readText(oldTarget.spaceRel);
    if (!viewerOnly && content == null) throw routeError('not found', 404);
    if (viewerOnly && !pathExists(oldTarget.spaceRel)) throw routeError('not found', 404);
    if (pathExists(newTarget.spaceRel)) throw routeError('target exists', 409);

    const oldDerivedArtifacts = derivedArtifactsForSource(oldTarget.spaceRel);
    const newDerivedArtifacts = derivedArtifactsForSource(newTarget.spaceRel);
    const renames: RenameEntry[] = [{ kind: 'file', old: oldTarget.spaceRel, new: newTarget.spaceRel }];
    const linkPlan = opts.cascade === false ? [] : planRenameLinks(renames);
    renameOnDisk(oldTarget.spaceRel, newTarget.spaceRel);
    const applied = opts.cascade === false ? null : applyRenamePlan(linkPlan);
    if (applied?.failed.length) {
      applied.rollback();
      renameOnDisk(newTarget.spaceRel, oldTarget.spaceRel);
      throw routeError(`failed to update links in ${applied.failed.map((f) => f.name).join(', ')}`, 500);
    }

    let indexWarning: string | undefined;
    try {
      if (!getApiKey()) {
        indexWarning = 'Semantic index was not updated because no OpenAI API key is configured.';
      } else if (viewerOnly) {
        const currentDerivedNote = newDerivedArtifacts.notes[0];
        const derivedBody = currentDerivedNote ? readText(currentDerivedNote) : null;
        if (!derivedBody) {
          const sourceAbs = path.join(requireSpaceExistsByName(oldTarget.space), newTarget.spaceRel);
          try {
            if (oldFormat === 'pdf') maybeConvertPdf(sourceAbs);
            else if (isImageFile(newTarget.spaceRel)) maybeConvertImage(sourceAbs);
          } catch (err: unknown) {
            log.warn(`kb move: conversion kickoff failed for ${newTarget.kbRel}: ${errorMessage(err)}`);
          }
          indexWarning = 'Searchable text is being regenerated in the background.';
        } else if (currentDerivedNote) {
          await indexer.upsertFile(`${newTarget.space}/${currentDerivedNote}`, derivedBody);
        }
        for (const rel of oldDerivedArtifacts.notes) {
          if (rel === currentDerivedNote) continue;
          await indexer.deleteFile(`${oldTarget.space}/${rel}`).catch((err) => {
            log.warn(`kb move: failed to remove old derived index row ${oldTarget.space}/${rel}: ${errorMessage(err)}`);
          });
        }
      } else {
        const movedContent = readText(newTarget.spaceRel) ?? content ?? '';
        const tooLarge = contentSizeError(movedContent);
        if (tooLarge) {
          await indexer.deleteFile(oldTarget.kbRel).catch((err) => {
            log.warn(`kb move: failed to remove old index row ${oldTarget.kbRel}: ${errorMessage(err)}`);
          });
          indexWarning = `${tooLarge}. The file moved, but semantic search will skip it until you split or reduce it and run sync.`;
        } else {
          await indexer.renameFile(oldTarget.kbRel, newTarget.kbRel, movedContent);
        }
      }
      for (const u of applied?.updated ?? []) {
        if (!getApiKey()) break;
        if (u.name === newTarget.spaceRel) continue;
        const body = readText(u.name);
        if (body != null) await indexer.upsertFile(`${oldTarget.space}/${u.name}`, body);
      }
    } catch (err) {
      // The disk move has already happened; keep the user's file move
      // and report the semantic-index lag instead of trying to roll
      // back a valid filesystem operation after link rewrites.
      indexWarning = `Moved, but semantic index update failed: ${errorMessage(err)}`;
    }
    return {
      oldPath: oldTarget.kbRel,
      path: newTarget.kbRel,
      linksUpdated: linkPlan.reduce((acc, p) => acc + p.changes, 0),
      indexWarning,
    };
  });
}

export async function deleteKbFile(rawPath: unknown): Promise<{ path: string; alreadyGone: boolean }> {
  const target = normalizeKbFilePath(rawPath);
  return runWithSpaceName(target.space, async () => {
    const inFlightError = inFlightFileOperationError(target.spaceRel, 'delete');
    if (inFlightError) throw routeError(inFlightError.body.error, inFlightError.status, inFlightError.body.code);
    const derivedArtifacts = derivedArtifactsForSource(target.spaceRel);
    const removed = deleteFile(target.spaceRel);
    if (removed) cancelConversion(target.kbRel);
    try { clearRecord(target.kbRel); }
    catch (err: unknown) { log.warn(`kb delete: conversion status cleanup failed for ${target.kbRel}: ${errorMessage(err)}`); }
    if (removed && getApiKey()) {
      for (const rel of [target.spaceRel, ...derivedArtifacts.notes]) {
        indexer.deleteFile(`${target.space}/${rel}`).catch((err) => {
          log.warn(`kb delete: index cleanup failed for ${target.space}/${rel}: ${errorMessage(err)}`);
        });
      }
    }
    return { path: target.kbRel, alreadyGone: !removed };
  });
}
