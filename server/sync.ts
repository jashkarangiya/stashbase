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
 * Both scoped to ONE space at a time, and BOTH context-free: the target
 * space arrives as an explicit argument and every path is resolved
 * against it (or against kbRoot directly) — never against the ambient
 * window context. Sync runs in contexts that have no space open at all
 * (MCP host embedded path, `POST /api/sync?space=X` from a window that
 * has a different space open), where the ambient `fromKbRel`/`readText`
 * answer would be null and every file would spuriously fail.
 *
 * The only ambient-context consumers left are the PDF/image
 * conversion discovery calls — the conversion layer still thinks in
 * window context, so those degrade gracefully (skipped) when none is
 * open. Indexing itself never skips.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reclaimInterruptedConversions } from './conversion.ts';
import { discoverNewImages } from './image.ts';
import { discoverNewPdfs } from './pdf.ts';
import { getCurrentSpace, getKbRoot } from './space.ts';
import type { Indexer } from './indexer.ts';
import { logger, errorMessage } from './log.ts';
import { hasNoExtractableText, indexableFileSizeError, shouldIndexFilePath } from './indexable.ts';

const log = logger('sync');

/** Strip the explicit space prefix from a kbRoot-relative path, or null
 *  when the path lives outside that space (a daemon cross-space
 *  surprise). Deliberately NOT `fromKbRel()` — that resolves the space
 *  from the ambient window context, which the sync caller may not have. */
function spaceRelOf(space: string, kbRel: string): string | null {
  return kbRel.startsWith(`${space}/`) ? kbRel.slice(space.length + 1) : null;
}

/** Runtime assertion for invariant I2 "sync 不说谎" (data-layer §8.6):
 *  a file this sync just claimed to have indexed must not still be in
 *  the daemon's name-only pending set. A violation is the
 *  write-black-hole fingerprint — upsert returned ok but the store has
 *  no rows for the file (observed when a second daemon fights over the
 *  Milvus Lite flock) — and is otherwise invisible until a user
 *  notices search misses days later. Best-effort: one extra status
 *  round-trip per non-empty sync; any error here is swallowed (the
 *  sync itself already succeeded from the caller's perspective). */
async function assertSyncConverged(
  indexer: Indexer,
  space: string,
  claimed: string[],
): Promise<void> {
  if (claimed.length === 0) return;
  let pending: Set<string>;
  try {
    pending = new Set((await indexer.status(space)).pending);
  } catch {
    return;
  }
  for (const kbRel of claimed) {
    if (!pending.has(kbRel)) continue;
    // Files that can never produce chunks (over-size, no extractable
    // text) are legitimately skipped by upsert yet keep showing in the
    // daemon's raw pending — not a lie, not a black hole.
    const abs = path.join(getKbRoot(), kbRel);
    if (indexableFileSizeError(abs) !== null || hasNoExtractableText(abs)) continue;
    log.error(
      `sync claimed "${kbRel}" indexed but the daemon still reports it pending — ` +
        'write-black-hole fingerprint (data-layer §8.6 I2). Check for a second ' +
        'stashbase daemon fighting over the Milvus lock (ps aux | grep stashbase-daemon).',
    );
  }
}

/** Read a file by its kbRoot-relative path, independent of any window
 *  context. Null on traversal escape or read failure — same contract as
 *  `files.ts:readText`, minus the current-space resolution. */
function readTextAtKbRel(kbRel: string): string | null {
  const root = getKbRoot();
  const full = path.join(root, kbRel);
  const back = path.relative(root, full);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

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
 *  (e.g. `cs183b`) — any known space, not necessarily one open in a
 *  window. Returns space-relative paths so the manual sync UI can show
 *  them straight. */
export async function syncIndex(indexer: Indexer, space: string): Promise<SyncResult> {
  // Surface untracked PDFs / images before running the index diff. We
  // don't await individual conversions — the converter (pdf_extract /
  // ocr_extract) writes the derived .md to disk and the fs.watch
  // debounce will catch it on its next tick. We just want the queueing
  // to start so the user sees pendingConversions populate.
  // Reclaim any in-flight conversions orphaned by a prior crash/restart
  // first, so the discovery walk below can re-decide them (finish, re-
  // queue, or drop) instead of seeing a stuck record and skipping.
  reclaimInterruptedConversions();
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
      const spaceRel = spaceRelOf(space, r.new);
      if (spaceRel == null) {
        failed.push({ name: r.new, error: `path not under synced space "${space}"` });
        continue;
      }
      const content = readTextAtKbRel(r.new);
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
    if (await indexOne(indexer, space, kbRel, failed)) addedDone.push(kbRel);
  }
  for (const kbRel of diff.modified) {
    if (await indexOne(indexer, space, kbRel, failed)) modifiedDone.push(kbRel);
  }

  log.info(
    `done. added=${addedDone.length}/${diff.added.length} ` +
      `modified=${modifiedDone.length}/${diff.modified.length} ` +
      `renamed=${renamedDone.length}/${diff.renamed.length} ` +
      `removed=${diff.deleted.length} failed=${failed.length}`,
  );
  await assertSyncConverged(indexer, space, [...addedDone, ...modifiedDone, ...renamedDone]);
  return {
    added: addedDone.map((p) => spaceRelOf(space, p) ?? p),
    modified: modifiedDone.map((p) => spaceRelOf(space, p) ?? p),
    removed: diff.deleted.map((p) => spaceRelOf(space, p) ?? p),
    renamed: renamedDone.map((p) => spaceRelOf(space, p) ?? p),
    failed,
  };
}

/** Name-only diff for one space. Skips content hashing for speed;
 *  the manual sync button (POST /api/sync) handles drift. */
export async function syncNewFiles(indexer: Indexer, space: string): Promise<SyncResult> {
  // Same rationale as syncIndex: queue untracked PDFs / images first so
  // the sidebar's "Converting…" indicator shows up on space open.
  // Same reclaim-then-discover order as syncIndex (see there): clear
  // crash-orphaned in-flight rows before the discovery walk re-decides.
  reclaimInterruptedConversions();
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
    if (await indexOne(indexer, space, kbRel, failed)) addedDone.push(kbRel);
  }

  log.info(
    `done. added=${addedDone.length}/${status.pending.length} ` +
      `removed=${status.orphaned.length} failed=${failed.length}`,
  );
  await assertSyncConverged(indexer, space, addedDone);
  return {
    added: addedDone.map((p) => spaceRelOf(space, p) ?? p),
    modified: [],
    removed: status.orphaned.map((p) => spaceRelOf(space, p) ?? p),
    renamed: [],
    failed,
  };
}

/** Read the file at `kbRel` and upsert it under its kbRoot-relative
 *  path. Returns true on success, pushes a failure record otherwise. */
async function indexOne(
  indexer: Indexer,
  space: string,
  kbRel: string,
  failed: { name: string; error: string }[],
): Promise<boolean> {
  const spaceRel = spaceRelOf(space, kbRel);
  if (spaceRel == null) {
    // Daemon reported a path outside the space this sync is scoped to —
    // shouldn't happen, but guard so a cross-space surprise can't wedge
    // the loop.
    failed.push({ name: kbRel, error: `path not under synced space "${space}"` });
    return false;
  }
  if (!shouldIndexFilePath(spaceRel)) {
    try { await indexer.deleteFile(kbRel); } catch { /* best-effort stale cleanup */ }
    return false;
  }
  const content = readTextAtKbRel(kbRel);
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
