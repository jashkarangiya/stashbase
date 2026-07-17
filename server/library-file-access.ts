import { errorMessage } from './log.ts';
import {
  exactMemberFolderRoot,
  getFolderHome,
  memberRootForAbs,
  resolveFolderRoot,
} from './folder.ts';
import { filesystemPath } from './filesystem-path.ts';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';
import { isDerivedNoteName } from './format.ts';

export interface LibrarySearchScope {
  /** Absolute root of the folder to scope to, or undefined for whole-library. */
  folderRoot?: string;
  /** Absolute path prefix to narrow to, or undefined. */
  pathPrefix?: string;
}

function requireMemberFolderRoot(ref: string): string {
  const root = resolveFolderRoot(ref);
  const memberRoot = exactMemberFolderRoot(root);
  if (!memberRoot) {
    throw routeError('folder is not in your folders', 404, 'FOLDER_NOT_FOUND');
  }
  return memberRoot;
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

function normalizeLibraryPathPrefix(value: string): string {
  // Resolve to an absolute prefix and require it to live under a member folder.
  // Absolute paths are the normal API; non-absolute values are compatibility
  // refs under the default folder home.
  const requestedAbs = resolveLibraryAbs(value, { allowEmpty: false });
  const folderRoot = memberRootForAbs(requestedAbs);
  if (!folderRoot) {
    throw routeError('path_prefix must live under one of your folders', 400);
  }
  const requestedRel = filesystemPath.relative(folderRoot, requestedAbs);
  if (requestedRel == null) throw routeError('path_prefix must live under one of your folders', 400);
  return filesystemPath.join(folderRoot, filesystemPath.canonicalRelative(folderRoot, requestedRel));
}

export interface LibraryPath {
  /** Absolute POSIX source spelling exposed through MCP and passed to workers. */
  abs: string;
  /** Absolute root of the member folder that contains it. */
  folderRoot: string;
  /** Path within that folder (`docs/note.md`). */
  folderRel: string;
}

export interface LibraryDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  format?: string;
  size?: number;
  version?: string;
}

export interface AgentContextFile {
  /** Absolute source spelling exposed to MCP/file tools. */
  path: string;
  /** Display label of the member folder containing the source. */
  folder: string;
  /** Folder-relative visible source path (`paper.pdf`). */
  sourcePath: string;
  /** Path the agent should read first (folder-relative for direct text; an
   *  absolute app-data path for extracted PDF/DOCX text). */
  readPath: string;
  kind: 'direct' | 'derived';
  sourceFormat: string;
  available: boolean;
  reason: string;
}

/** Resolve a raw native or POSIX-spelled path to an absolute POSIX path,
 *  rejecting traversal and control chars. Absolute paths are the normal API;
 *  non-absolute values are compatibility refs under the default folder home.
 *  Does NOT check membership; callers do via `memberRootForAbs`. */
export function resolveLibraryAbs(raw: unknown, opts: { allowEmpty: boolean }): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (opts.allowEmpty) return '';
    throw routeError('path required', 400);
  }
  if (/[\x00-\x1f]/.test(value)) throw routeError('path contains invalid characters', 400);
  for (const seg of value.replace(/\\/g, '/').split('/')) {
    if (seg === '.' || seg === '..') throw routeError('path contains an invalid segment', 400);
  }
  return filesystemPath.absolute(value, getFolderHome());
}

export function normalizeLibraryFilePath(raw: unknown): LibraryPath {
  const requestedAbs = resolveLibraryAbs(raw, { allowEmpty: false });
  const folderRoot = memberRootForAbs(requestedAbs);
  if (!folderRoot) {
    throw routeError('path must live under one of your folders (call library_info to list them)', 400);
  }
  const requestedRel = filesystemPath.relative(folderRoot, requestedAbs);
  const folderRel = requestedRel == null
    ? null
    : filesystemPath.canonicalRelative(folderRoot, requestedRel);
  if (folderRel == null || folderRel === '') {
    throw routeError('path must include a file path, not just the folder root', 400);
  }
  if (isDerivedNoteName(folderRel)) {
    throw routeError('app-maintained derived notes are hidden; use the visible source file path', 403);
  }
  return { abs: filesystemPath.join(folderRoot, folderRel), folderRoot, folderRel };
}

export function normalizeLibraryDirectoryPath(raw: unknown): { abs?: string; folderRoot?: string; folderRel?: string } {
  const requestedAbs = resolveLibraryAbs(raw, { allowEmpty: true });
  if (!requestedAbs) return {};
  const folderRoot = memberRootForAbs(requestedAbs);
  if (!folderRoot) {
    throw routeError('path must live under one of your folders (call library_info to list them)', 400);
  }
  const requestedRel = filesystemPath.relative(folderRoot, requestedAbs);
  const folderRel = requestedRel == null
    ? null
    : filesystemPath.canonicalRelative(folderRoot, requestedRel);
  if (folderRel == null) throw routeError('path must live under one of your folders', 400);
  return { abs: filesystemPath.join(folderRoot, folderRel), folderRoot, folderRel };
}

export function validateLibraryWritableFolderRel(folderRel: string): void {
  try {
    normalizeFolderRelativePath(folderRel, { writable: true, allowQuotes: true });
  } catch (err: unknown) {
    throw routeError(errorMessage(err), 400, 'INVALID_FILE_WRITE');
  }
}

export function routeError(message: string, status = 400, code?: string): Error {
  const err = new Error(message);
  (err as any).status = status;
  if (code) (err as any).code = code;
  return err;
}

