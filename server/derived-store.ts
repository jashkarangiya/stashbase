/**
 * App-data home for PDF/image **derived notes** (the extracted markdown,
 * its image bundle, and the PDF resume-batch scratch). These never live in
 * the user's opened folder; all generated artifacts are per-machine derived
 * state under app data (see `local-data.ts`). The PDF/image *source* is the user-facing file
 * and is what gets indexed (under its own path, with the derived markdown as
 * the content) so folder-scoped search still finds it.
 *
 * Keyed by a hash of the **source's absolute path** (not its content): a
 * path is locatable even after the source file is deleted, so cleanup /
 * orphan-GC can still find the derived note to remove it. The trade-off is a
 * rename re-converts (rare); content-addressing would need a separate
 * path→hash index just to support deletion.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { appDataRoot } from './local-data.ts';
import { toPosixAbs } from './folder.ts';
import { isConvertibleSource } from './format.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName } from './indexable.ts';

/** The single global derived-notes directory: `<appData>/derived.nosync/`.
 *  `.nosync` keeps iCloud off it (same rationale as the vector store). */
export function derivedDir(): string {
  return path.join(appDataRoot(), 'derived.nosync');
}

function derivedKey(sourceAbs: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(toPosixAbs(sourceAbs)))).slice(0, 32);
}

/** Absolute path of the derived markdown note for a source file. */
export function derivedNoteFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}.md`);
}

/** Absolute path of the derived image bundle (`_files/`) for a source. */
export function derivedBundleFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}_files`);
}

/** Absolute path of the PDF resume-batch scratch dir for a source. */
export function derivedBatchesFor(sourceAbs: string): string {
  return path.join(derivedDir(), `${derivedKey(sourceAbs)}.batches`);
}

export interface DerivedCleanupStats {
  sources: number;
  artifacts: number;
}

function rmDerivedArtifact(absPath: string): number {
  try {
    const existed = fs.existsSync(absPath);
    fs.rmSync(absPath, { recursive: true, force: true });
    return existed ? 1 : 0;
  } catch {
    return 0;
  }
}

/** Delete all AppData-derived artifacts for one PDF/image source path. */
export function deleteDerivedForSource(sourceAbs: string): DerivedCleanupStats {
  if (!isConvertibleSource(sourceAbs)) return { sources: 0, artifacts: 0 };
  return {
    sources: 1,
    artifacts:
      rmDerivedArtifact(derivedNoteFor(sourceAbs))
      + rmDerivedArtifact(derivedBundleFor(sourceAbs))
      + rmDerivedArtifact(derivedBatchesFor(sourceAbs)),
  };
}

/** Best-effort cleanup for every convertible source currently visible under
 *  a folder. This is used when a folder leaves the library; user files stay
 *  in place, but AppData-derived text/assets for those sources should go. */
export function deleteDerivedUnderFolder(folderAbs: string): DerivedCleanupStats {
  const root = toPosixAbs(folderAbs);
  const seen = new Set<string>();
  const totals: DerivedCleanupStats = { sources: 0, artifacts: 0 };

  function add(stats: DerivedCleanupStats): void {
    totals.sources += stats.sources;
    totals.artifacts += stats.artifacts;
  }

  function visit(absDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (isCloudPlaceholderName(ent.name)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (isIndexExcludedDirName(ent.name)) continue;
        visit(abs);
        continue;
      }
      if (!ent.isFile() || !isConvertibleSource(ent.name)) continue;
      const sourceAbs = toPosixAbs(abs);
      if (seen.has(sourceAbs)) continue;
      seen.add(sourceAbs);
      add(deleteDerivedForSource(sourceAbs));
    }
  }

  if (fs.existsSync(root)) visit(root);
  return totals;
}
