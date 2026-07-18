import fs from 'node:fs';
import path from 'node:path';
import { requireCurrentFolder } from './folder.ts';
import { filesystemPath, type PathAccess } from './filesystem-path.ts';
import { normalizeFolderRelativePath, type FolderRelativePathOptions } from './folder-relative-path.ts';

/** Resolve the current folder root every time we touch the FS — the user
 *  can switch folders at runtime from the welcome screen, so caching the
 *  path at module load would silently keep writing to the old folder. */
export function folderRoot(): string {
  return requireCurrentFolder();
}

/** Basename of the currently-open folder. The web UI shows this as
 *  the folder label at the top of the sidebar. */
export function getCurrentFolderBasename(): string {
  return path.basename(folderRoot());
}

/** Quietly transform a user-supplied filename so it survives writing
 *  to disk on any sane filesystem. Used at create / rename time only —
 *  reads still pass through `safePath` verbatim, so folders imported
 *  from other tools that already have `:` in filenames keep working. */
export function sanitizeFilename(name: string): string {
  return name
    .split('/')
    .map((seg) => seg.replace(/[:?*<>|\\]/g, '-'))
    .join('/')
    .normalize('NFC');
}

/** Resolve relative-to-folder path to an absolute filesystem path AND
 *  defend against any edge case where the result escapes the folder root. */
export function resolveSafe(
  rel: string,
  access: PathAccess = 'lexical',
  label = 'path',
  options: FolderRelativePathOptions = {},
): string {
  const safe = normalizeFolderRelativePath(rel, { allowQuotes: true, ...options });
  return filesystemPath.resolveUnder(folderRoot(), safe, { access, label });
}

function caseOnlySameEntryRename(from: string, to: string): boolean {
  return from !== to
    && filesystemPath.sameExistingPath(from, to);
}

function uniqueRenameHop(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  for (let i = 0; i < 100; i += 1) {
    const candidate = path.join(dir, `.${base}.stashbase-rename-${process.pid}-${Date.now()}-${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('could not reserve temporary rename path');
}

export function renameAbsPreservingCase(from: string, to: string): void {
  if (!caseOnlySameEntryRename(from, to)) {
    fs.renameSync(from, to);
    return;
  }
  const hop = uniqueRenameHop(to);
  fs.renameSync(from, hop);
  try {
    fs.renameSync(hop, to);
  } catch (err) {
    try { fs.renameSync(hop, from); } catch { /* preserve original error */ }
    throw err;
  }
}

export function isSameExistingPath(oldRel: string, newRel: string): boolean {
  let oldAbs: string;
  let newAbs: string;
  try { oldAbs = resolveSafe(oldRel); newAbs = resolveSafe(newRel); }
  catch { return false; }
  return filesystemPath.sameExistingPath(oldAbs, newAbs);
}
