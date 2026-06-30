/**
 * Filesystem copy/move primitives used by the folder-home migration path.
 * Kept dependency-free (no app modules) so `folder.ts` can use it without
 * an import cycle.
 *
 * Everything here dereferences symlinks (copies their targets), refuses
 * to follow directory cycles, and never overwrites — the destination
 * must not exist.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Recursively copy `source` into a fresh `destination`. Throws if the
 *  destination already exists, on a cyclic symlink, or on an
 *  unsupported entry type. Leaves a partial destination behind on
 *  failure — callers that need atomicity roll it back. */
export interface CopyDirectoryOptions {
  exclude?: (relPath: string, entry: fs.Dirent) => boolean;
  validateEntry?: (
    relPath: string,
    sourcePath: string,
    entry: fs.Dirent,
    stat: fs.Stats,
    realPath: string,
  ) => void;
}

export function copyDirectoryDereferenced(
  source: string,
  destination: string,
  opts: CopyDirectoryOptions = {},
): void {
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  const sourceReal = fs.realpathSync(source);
  const sourceStat = fs.statSync(source);
  fs.mkdirSync(destination, { recursive: false, mode: sourceStat.mode });

  const stack: Array<{ source: string; destination: string; rel: string; ancestors: Set<string> }> = [
    { source, destination, rel: '', ancestors: new Set([sourceReal]) },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const entry of fs.readdirSync(frame.source, { withFileTypes: true })) {
      const childRel = frame.rel ? `${frame.rel}/${entry.name}` : entry.name;
      if (opts.exclude?.(childRel, entry)) continue;
      const childSource = path.join(frame.source, entry.name);
      const childDestination = path.join(frame.destination, entry.name);
      const stat = fs.statSync(childSource);
      let real: string | null = null;
      if (opts.validateEntry || stat.isDirectory()) {
        real = fs.realpathSync(childSource);
        opts.validateEntry?.(childRel, childSource, entry, stat, real);
      }
      if (stat.isDirectory()) {
        real ??= fs.realpathSync(childSource);
        if (frame.ancestors.has(real)) throw new Error(`cyclic symlink detected: ${childSource}`);
        fs.mkdirSync(childDestination, { mode: stat.mode });
        stack.push({
          source: childSource,
          destination: childDestination,
          rel: childRel,
          ancestors: new Set([...frame.ancestors, real]),
        });
        continue;
      }
      if (stat.isFile()) {
        fs.copyFileSync(childSource, childDestination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(childDestination, stat.mode);
        continue;
      }
      throw new Error(`unsupported filesystem entry: ${childSource}`);
    }
  }
}
