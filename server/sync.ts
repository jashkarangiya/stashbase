/**
 * Space sync: reconcile the index with whatever note files are
 * currently on disk in the space.
 *
 * ONE flavour (2026-06 simplification): `syncIndex` — full content-hash
 * diff via the daemon's `scan_diff` op. Hashing a personal-KB-sized tree
 * is milliseconds; embedding only happens for changed hashes, so a
 * cheaper name-only tier bought nothing but a second semantics. Called
 * on space open/switch, window focus, agent turn end, the manual
 * `POST /api/sync` button, and MCP `update_index`.
 *
 * Scoped to ONE space at a time and fully context-free: the target
 * space arrives as an explicit argument and every path (including the
 * PDF/image conversion discovery below) is resolved against kbRoot —
 * never against the ambient window context. Sync runs in contexts that
 * have no space open at all (headless server, `POST /api/sync?space=X`
 * from a window that has a different space open).
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverNewImages } from './image.ts';
import { discoverNewPdfs } from './pdf.ts';
import { getKbRoot } from './space.ts';
import { getApiKey } from './app-config.ts';
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
  // No OpenAI key → semantic indexing is disabled by design (§5.3): the
  // daemon has no embedder/store, so every upsert would throw "no bound
  // space … set an OpenAI API key" and a whole-folder import would flood
  // the log with one failure per file. There's nothing in the index to
  // maintain without a store, so skip the entire reconcile (including
  // PDF/image conversion, whose derived-note upsert would fail the same
  // way). Keyword search (ripgrep, no index) is unaffected, and the UI
  // prompts the user to add a key on space open. Re-running sync after a
  // key is set picks everything up.
  if (!getApiKey()) {
    log.info(`no OpenAI key — skipping semantic index for "${space}" (keyword search unaffected)`);
    return { added: [], modified: [], removed: [], renamed: [], failed: [] };
  }
  // Surface untracked PDFs / images before running the index diff. We
  // don't await individual conversions — each converter indexes its
  // derived note directly on completion; here we just start the queueing
  // so the user sees pendingConversions populate. Discovery is decided
  // from disk + memory truth alone (note exists / failure recorded /
  // running now), so it is safe and idempotent on every sync.
  const spaceAbs = path.join(getKbRoot(), space);
  discoverNewPdfs(spaceAbs);
  discoverNewImages(spaceAbs);

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
      const tooLarge = indexableFileSizeError(path.join(getKbRoot(), r.new));
      if (tooLarge) {
        failed.push({ name: r.new, error: tooLarge });
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
  const tooLarge = indexableFileSizeError(path.join(getKbRoot(), kbRel));
  if (tooLarge) {
    try { await indexer.deleteFile(kbRel); } catch { /* best-effort stale cleanup */ }
    failed.push({ name: kbRel, error: tooLarge });
    log.warn(`skipped ${kbRel}: ${tooLarge}`);
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
