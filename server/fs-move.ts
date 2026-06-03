/**
 * Filesystem copy/move primitives shared by the folder-import path and
 * the KB-root migration path. Kept dependency-free (no app modules) so
 * both `import-folder.ts` and `space.ts` can use it without an import
 * cycle.
 *
 * Everything here dereferences symlinks (copies their targets), refuses
 * to follow directory cycles, and never overwrites — the destination
 * must not exist. Moves are copy-then-delete so they're safe across
 * filesystems, unlike `fs.rename` (which throws EXDEV across volumes).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Recursively copy `source` into a fresh `destination`. Throws if the
 *  destination already exists, on a cyclic symlink, or on an
 *  unsupported entry type. Leaves a partial destination behind on
 *  failure — callers that need atomicity roll it back. */
export function copyDirectoryDereferenced(source: string, destination: string): void {
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: false });
  const seen = new Set([fs.realpathSync(source)]);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    copyEntryDereferenced(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      seen,
    );
  }
}

function copyEntryDereferenced(
  source: string,
  destination: string,
  seenDirectories: Set<string>,
): void {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    const real = fs.realpathSync(source);
    if (seenDirectories.has(real)) throw new Error(`cyclic symlink detected: ${source}`);
    seenDirectories.add(real);
    fs.mkdirSync(destination, { mode: stat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyEntryDereferenced(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        seenDirectories,
      );
    }
    seenDirectories.delete(real);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode);
    return;
  }
  throw new Error(`unsupported filesystem entry: ${source}`);
}

/** Move a directory by safe copy + delete (cross-filesystem safe). The
 *  destination must not exist — overwrite/rename policies are the
 *  caller's job. Two phases mirror the folder-import logic:
 *
 *  1. Copy. If anything throws, roll back the partial destination and
 *     rethrow — the source is untouched, so nothing is lost.
 *  2. Delete the source. This is *outside* the rollback: the copy is
 *     already committed, so a delete failure must keep the destination.
 *     We surface a warning instead so the caller can tell the user the
 *     original still needs manual cleanup. */
export function moveDirectory(source: string, destination: string): { warning?: string } {
  try {
    copyDirectoryDereferenced(source, destination);
  } catch (err) {
    try { fs.rmSync(destination, { recursive: true, force: true }); } catch { /* best-effort rollback */ }
    throw err;
  }
  try {
    fs.rmSync(source, { recursive: true, force: false });
  } catch {
    return {
      warning: `Moved into ${destination}, but the original at ${source} could not be fully removed. Please delete it manually.`,
    };
  }
  return {};
}
