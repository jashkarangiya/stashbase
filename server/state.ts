/**
 * Process-wide indexer state + space-switch orchestration.
 *
 * One `MfsIndexer` instance lives for the lifetime of the server
 * process. The daemon underneath owns one Milvus DB at kbRoot with
 * one collection per (provider, dim); each space is `bind_space`-ed to
 * the collection matching its embedder provider. Boot binds every
 * known space under kbRoot so MCP cross-space search has them all
 * available; opening a space re-binds (idempotent) and runs a name-
 * only sync to pick up any new files.
 *
 * Extracted from `server/index.ts` so route modules can import the
 * indexer without picking up the whole route registration kitchen sink.
 */
import { MfsIndexer } from './indexer.mfs.ts';
import type { Indexer, EmbedderRuntimeConfig } from './indexer.ts';
import {
  getApiKey,
  getCurrentSpace,
  getCurrentSpaceName,
  getKbRoot,
  getSpaceEmbedderProvider,
  listKnownSpaces,
  lockInSpaceProvider,
  onSwitch,
} from './space.ts';
import { syncNewFiles } from './sync.ts';
import { getDaemon } from './mfs-daemon.ts';
import { logger, errorMessage } from './log.ts';
import fs from 'node:fs';
import path from 'node:path';

const log = logger('state');

/** Single indexer instance shared across every route. */
export const indexer: Indexer = new MfsIndexer();

/** Resolve a space's runtime embedder config from disk. Returns null
 *  when the resolved provider can't be used right now (openai without
 *  a global key) so the caller can fall back to local. `spaceAbs` is
 *  the absolute on-disk path of the space (used by per-space config
 *  read/write). */
export function resolveSpaceEmbedder(spaceAbs: string): EmbedderRuntimeConfig | null {
  const provider = getSpaceEmbedderProvider(spaceAbs);
  if (provider === 'onnx') return { provider: 'onnx' };
  const apiKey = getApiKey();
  if (!apiKey) return null;
  return { provider: 'openai', apiKey };
}

/** Configure + spawn the daemon, then bind every known space under
 *  kbRoot. Idempotent on the bind side; safe to call once at server
 *  startup. Spaces with no openai key fall back to onnx so they stay
 *  searchable (the choice isn't persisted — user intent is preserved). */
export async function bootBindAllSpaces(): Promise<void> {
  const daemon = getDaemon();
  daemon.configure({ kbRoot: getKbRoot() });
  const known = listKnownSpaces();
  if (known.length === 0) {
    log.info('boot bind: no spaces found under kbRoot');
    return;
  }
  log.info(`boot bind: ${known.length} space(s): ${known.join(', ')}`);
  for (const space of known) {
    const spaceAbs = path.join(getKbRoot(), space);
    try {
      const cfg = resolveSpaceEmbedder(spaceAbs) ?? { provider: 'onnx' as const };
      await indexer.bindSpace(space, cfg);
    } catch (err: unknown) {
      log.warn(`boot bind ${space} failed: ${errorMessage(err)}`);
    }
  }
}

/** Bind the indexer to a space: persist its embedder choice, resolve
 *  the runtime config, hand it to the indexer. Called on every space
 *  switch (idempotent). Doesn't trigger sync — caller's responsibility
 *  via `scheduleIndexerSync`. */
export async function bindIndexerForSpace(spaceAbs: string): Promise<void> {
  // Persist the resolved provider on first bind so a later key change
  // doesn't silently flip an already-indexed space.
  lockInSpaceProvider(spaceAbs);
  const cfg = resolveSpaceEmbedder(spaceAbs);
  const runtime = cfg ?? { provider: 'onnx' as const };
  if (!cfg) {
    log.warn(`embedder: space ${spaceAbs} wants openai but no global key; falling back to local`);
  }
  // The kbRoot-relative name is the space identifier on the indexer side.
  // We can't use getCurrentSpaceName() here — the switch listener fires
  // BEFORE the renderer sees the new currentSpace, and bootBindAllSpaces
  // calls this without changing currentSpace at all.
  const rel = path.relative(getKbRoot(), spaceAbs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..')) {
    throw new Error(`bindIndexerForSpace: ${spaceAbs} is not under kbRoot`);
  }
  await indexer.bindSpace(rel, runtime);
  await maybeImportSnapshot(spaceAbs, rel);
}

/** If the space ships a `.stashbase/snapshot.parquet` and the
 *  collection has no rows for it yet, import the snapshot — lets a
 *  freshly-cloned starter (e.g. cs183b) come pre-indexed without
 *  re-embedding. Skips silently when the file is absent, or when the
 *  space already has data (idempotent: re-runs after the first import
 *  are no-ops). */
async function maybeImportSnapshot(spaceAbs: string, spaceName: string): Promise<void> {
  const snapshot = path.join(spaceAbs, '.stashbase', 'snapshot.parquet');
  try {
    if (!fs.statSync(snapshot).isFile()) return;
  } catch {
    return;
  }
  try {
    const status = await indexer.status(spaceName);
    if (status.indexed > 0) return;
  } catch (err) {
    log.warn(`snapshot import: status check failed for ${spaceName}: ${errorMessage(err)}`);
    return;
  }
  try {
    const res = await getDaemon().call<{
      imported: number;
      skipped: number;
      skipped_providers: { provider_key: string; chunks: number }[];
    }>('import_space', { space: spaceName, in_path: snapshot });
    if (res.imported > 0) {
      log.info(`snapshot import ${spaceName}: ${res.imported} chunk(s)`);
    }
    if (res.skipped > 0) {
      const summary = res.skipped_providers
        .map((p) => `${p.chunks} from ${p.provider_key}`)
        .join(', ');
      log.warn(
        `snapshot import ${spaceName}: skipped ${res.skipped} chunk(s) — ${summary}. ` +
          `Switch the space's embedder to match (or re-export with the current provider).`,
      );
    }
  } catch (err) {
    log.warn(`snapshot import ${spaceName} failed: ${errorMessage(err)}`);
  }
}


// Serialise indexer bind + sync so rapid space switches don't race. The
// seq guard short-circuits a stale tail when the user has already moved
// on; the queue chains each switch after the previous one finishes.
let indexerSwitchSeq = 0;
let indexerSwitchQueue: Promise<void> = Promise.resolve();

/** Resolves when the in-flight bind + snapshot-import work has settled.
 *  External callers (notably the fs watcher) await this before kicking
 *  off their own scans so they don't run `scan_diff` against an
 *  unbound — or worse, mid-import — collection, which would wrongly
 *  report every file as `added` and re-embed everything the snapshot
 *  just imported. */
export function awaitIndexerReady(): Promise<void> {
  return indexerSwitchQueue.catch(() => undefined);
}

export function scheduleIndexerSync(spaceRoot: string, reason: string): void {
  const seq = ++indexerSwitchSeq;
  indexerSwitchQueue = indexerSwitchQueue
    .catch(() => undefined)
    .then(async () => {
      if (getCurrentSpace() !== spaceRoot) return;
      try {
        await bindIndexerForSpace(spaceRoot);
        if (getCurrentSpace() !== spaceRoot || seq !== indexerSwitchSeq) return;
        // Name-only diff: trust existing rows, only embed new files
        // and drop orphans. Reopening a fully-indexed space costs zero
        // tokens. The full content-hash diff lives behind the manual
        // /api/sync button for the rare case where the user edited
        // files externally with the app closed.
        const spaceName = getCurrentSpaceName();
        if (spaceName) await syncNewFiles(indexer, spaceName);
      } catch (err: unknown) {
        log.warn(`${reason}: index sync failed for ${spaceRoot}: ${errorMessage(err)}`);
      }
    });
}

// Fire a queued bind + sync on every space switch. Registered at module
// load time so any importer (index.ts, tests) gets the wiring for free.
onSwitch((newRoot) => {
  scheduleIndexerSync(newRoot, 'space switch');
});
