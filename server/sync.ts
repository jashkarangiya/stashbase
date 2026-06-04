/**
 * Space sync: reconcile the index with whatever note files are
 * currently on disk in the space.
 *
 * Two flavours:
 *
 *   - `syncIndex`     — full content-hash diff via the daemon's
 *                       `scan_diff` op. Catches external edits done
 *                       behind StashBase's back (vim / git checkout /
 *                       Dropbox). Called by the fs.watch debounce and
 *                       by the manual `POST /api/sync` button.
 *
 *   - `syncNewFiles`  — name-only diff via `indexer.status()`. Embeds
 *                       files not yet in the index, drops orphans, but
 *                       does NOT re-embed existing rows. Used on
 *                       startup / space-switch so re-opening a fully-
 *                       indexed space costs zero embed tokens.
 *
 * Both scoped to ONE space at a time. The indexer talks in kbRoot-
 * relative paths (e.g. `cs183b/lecture-01.md`); sync.ts strips the
 * space prefix before handing names to `files.ts:readText` (which
 * still operates space-relative).
 */
import { readText } from './files.ts';
import { discoverNewImages } from './image.ts';
import { discoverNewPdfs } from './pdf.ts';
import { fromKbRel, getCurrentSpace } from './space.ts';
import type { Indexer } from './indexer.ts';
import { logger, errorMessage } from './log.ts';

const log = logger('sync');

export interface SyncResult {
  added: string[];
  modified: string[];
  removed: string[];
  /** Files the daemon's scan_diff matched by content hash to a
   *  previously-indexed (now-deleted) path. Each entry is the NEW
   *  space-relative path. Routed through `indexer.renameFile`, which the
   *  daemon fast-paths to reuse cached embeddings — no embedding tokens
   *  spent for these. */
  renamed: string[];
  failed: { name: string; error: string }[];
}

/** Full content-hash diff. `space` is the kbRoot-relative space name
 *  (e.g. `cs183b`) — the current open space. Returns space-relative
 *  paths so the manual sync UI can show them straight. */
export async function syncIndex(indexer: Indexer, space: string): Promise<SyncResult> {
  // Surface untracked PDFs / images before running the index diff. We
  // don't await individual conversions — the converter (pdf_extract /
  // ocr_extract) writes the derived .md to disk and the fs.watch
  // debounce will catch it on its next tick. We just want the queueing
  // to start so the user sees pendingConversions populate.
  const cur = getCurrentSpace();
  if (cur) { discoverNewPdfs(cur); discoverNewImages(cur); }

  const diff = await indexer.syncDiff(space);
  const failed: { name: string; error: string }[] = [];

  if (
    diff.added.length === 0 && diff.modified.length === 0 &&
    diff.deleted.length === 0 && diff.renamed.length === 0
  ) {
    log.info('index up to date');
    return { added: [], modified: [], removed: [], renamed: [], failed: [] };
  }

  // Renames first — they consume rows the deletes would otherwise wipe
  // (we already filtered the paired deletes out of `diff.deleted` in
  // scan_diff, but doing renames before deletes keeps the daemon's
  // collection state monotonic).
  const renamedDone: string[] = [];
  if (diff.renamed.length) {
    log.info(`renaming ${diff.renamed.length} file(s) (hash match, no re-embed)`);
    for (const r of diff.renamed) {
      const spaceRel = fromKbRel(r.new);
      if (spaceRel == null) {
        failed.push({ name: r.new, error: 'rename target not under current space' });
        continue;
      }
      const content = readText(spaceRel);
      if (content == null) {
        failed.push({ name: r.new, error: 'read returned null on rename target' });
        continue;
      }
      try {
        await indexer.renameFile(r.old, r.new, content);
        renamedDone.push(r.new);
      } catch (err: any) {
        failed.push({ name: r.new, error: errorMessage(err) });
      }
    }
  }

  if (diff.deleted.length) {
    log.info(`removing ${diff.deleted.length} stale file(s) from index`);
    for (const kbRel of diff.deleted) {
      try { await indexer.deleteFile(kbRel); }
      catch (err: any) { failed.push({ name: kbRel, error: errorMessage(err) }); }
    }
  }

  const toIndex = [...diff.added, ...diff.modified];
  if (toIndex.length) {
    log.info(
      `indexing ${toIndex.length} file(s) ` +
        `(${diff.added.length} new, ${diff.modified.length} drift-detected)`,
    );
  }
  const addedDone: string[] = [];
  const modifiedDone: string[] = [];
  for (const kbRel of diff.added) {
    if (await indexOne(indexer, kbRel, failed)) addedDone.push(kbRel);
  }
  for (const kbRel of diff.modified) {
    if (await indexOne(indexer, kbRel, failed)) modifiedDone.push(kbRel);
  }

  log.info(
    `done. added=${addedDone.length}/${diff.added.length} ` +
      `modified=${modifiedDone.length}/${diff.modified.length} ` +
      `renamed=${renamedDone.length}/${diff.renamed.length} ` +
      `removed=${diff.deleted.length} failed=${failed.length}`,
  );
  return {
    added: addedDone.map((p) => fromKbRel(p) ?? p),
    modified: modifiedDone.map((p) => fromKbRel(p) ?? p),
    removed: diff.deleted.map((p) => fromKbRel(p) ?? p),
    renamed: renamedDone.map((p) => fromKbRel(p) ?? p),
    failed,
  };
}

/** Name-only diff for the current space. Skips content hashing for
 *  speed; the manual sync button (POST /api/sync) handles drift. */
export async function syncNewFiles(indexer: Indexer, space: string): Promise<SyncResult> {
  // Same rationale as syncIndex: queue untracked PDFs / images first so
  // the sidebar's "Converting…" indicator shows up on space open.
  const cur = getCurrentSpace();
  if (cur) { discoverNewPdfs(cur); discoverNewImages(cur); }

  const status = await indexer.status(space);
  if (status.pending.length === 0 && status.orphaned.length === 0) {
    log.info('index up to date (name-only check)');
    return { added: [], modified: [], removed: [], renamed: [], failed: [] };
  }

  const failed: { name: string; error: string }[] = [];

  if (status.orphaned.length) {
    log.info(`removing ${status.orphaned.length} orphan(s) from index`);
    for (const kbRel of status.orphaned) {
      try { await indexer.deleteFile(kbRel); }
      catch (err: any) { failed.push({ name: kbRel, error: errorMessage(err) }); }
    }
  }

  if (status.pending.length) {
    log.info(`indexing ${status.pending.length} new file(s) [hash check skipped — call POST /api/sync for full re-check]`);
  }
  const addedDone: string[] = [];
  for (const kbRel of status.pending) {
    if (await indexOne(indexer, kbRel, failed)) addedDone.push(kbRel);
  }

  log.info(
    `done. added=${addedDone.length}/${status.pending.length} ` +
      `removed=${status.orphaned.length} failed=${failed.length}`,
  );
  return {
    added: addedDone.map((p) => fromKbRel(p) ?? p),
    modified: [],
    removed: status.orphaned.map((p) => fromKbRel(p) ?? p),
    renamed: [],
    failed,
  };
}

/** Read the file at `kbRel` and upsert it under its kbRoot-relative
 *  path. Returns true on success, pushes a failure record otherwise. */
async function indexOne(
  indexer: Indexer,
  kbRel: string,
  failed: { name: string; error: string }[],
): Promise<boolean> {
  const spaceRel = fromKbRel(kbRel);
  if (spaceRel == null) {
    // Daemon reported a path outside the current space — shouldn't
    // happen when sync is scoped to one space, but guard so we don't
    // wedge on a cross-space surprise.
    failed.push({ name: kbRel, error: 'path not under current space' });
    return false;
  }
  const content = readText(spaceRel);
  if (content == null) {
    failed.push({ name: kbRel, error: 'read returned null' });
    return false;
  }
  try {
    await indexer.upsertFile(kbRel, content);
    return true;
  } catch (err: any) {
    const msg = errorMessage(err);
    failed.push({ name: kbRel, error: msg });
    log.warn(`failed ${kbRel}: ${msg}`);
    return false;
  }
}
