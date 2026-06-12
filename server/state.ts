/**
 * Process-wide indexer state + space-switch orchestration.
 *
 * One `MfsIndexer` instance lives for the lifetime of the server
 * process. The daemon underneath owns one Milvus DB at kbRoot with a
 * single collection (V1 fixes the embedder to OpenAI — no switching).
 * Every space is `bind_space`-ed into that one collection. Boot binds
 * every known space under kbRoot so MCP cross-space search has them all
 * available; opening a space re-binds (idempotent) and runs a name-only
 * sync to pick up any new files.
 *
 * Extracted from `server/index.ts` so route modules can import the
 * indexer without picking up the whole route registration kitchen sink.
 */
import { MfsIndexer } from './indexer.mfs.ts';
import type { Indexer, EmbedderRuntimeConfig } from './indexer.ts';
import { getCurrentSpace, getCurrentSpaceName, getKbRoot, listKnownSpaces, onClose, onSwitch, runWithWindowId } from './space.ts';
import { getApiKey } from './app-config.ts';
import { syncIndex } from './sync.ts';
import { getDaemon } from './mfs-daemon.ts';
import { clearStaleMilvusLock } from './stale-lock.ts';
import { logger, errorMessage } from './log.ts';
import fs from 'node:fs';
import path from 'node:path';

const log = logger('state');

/** Single indexer instance shared across every route. */
export const indexer: Indexer = new MfsIndexer();

/** Most recent snapshot-import result per space, keyed by kbRoot-
 *  relative space name. Populated by `maybeImportSnapshot`, consumed by
 *  `/api/index-status` so the UI can show a banner the first time the
 *  user opens a space whose snapshot's embedder doesn't match the
 *  library's current provider. Cleared on successful re-import or
 *  manual dismissal. */
export interface SnapshotImportWarning {
  /** Total chunks the daemon skipped because their provider key
   *  didn't match anything bound for this space. */
  skipped: number;
  /** Per-provider chunk counts as reported by the daemon. */
  details: { provider: string; chunks: number }[];
  /** ISO timestamp so the UI can tell whether the warning is fresh. */
  at: string;
}
const snapshotWarnings = new Map<string, SnapshotImportWarning>();
export function getSnapshotWarning(space: string): SnapshotImportWarning | null {
  return snapshotWarnings.get(space) ?? null;
}
export function clearSnapshotWarning(space: string): void {
  snapshotWarnings.delete(space);
}
function recordSnapshotWarning(space: string, warning: SnapshotImportWarning): void {
  snapshotWarnings.set(space, warning);
}

/** Spaces whose snapshot vector-cache is currently loaded in the daemon
 *  (keyed by kbRoot-relative name). Loaded just before an import-time
 *  reindex and cleared once that reindex drains, so the daemon doesn't
 *  hold every snapshot's vectors in memory forever. */
const loadedSnapshotCaches = new Set<string>();

/** Drop the daemon-side snapshot vector cache for `spaceAbs`'s space if
 *  one was loaded. Called after the import-time sync finishes (or is
 *  abandoned). Best-effort: a failed clear only costs daemon memory. */
async function clearSnapshotCacheIfLoaded(spaceAbs: string): Promise<void> {
  const rel = path.relative(getKbRoot(), spaceAbs).split(path.sep).join('/');
  if (!loadedSnapshotCaches.has(rel)) return;
  loadedSnapshotCaches.delete(rel);
  try {
    await getDaemon().call('clear_vector_cache', { space: rel });
  } catch (err) {
    log.warn(`snapshot cache clear ${rel} failed: ${errorMessage(err)}`);
  }
}

/** Resolve the runtime embedder config (V1 = OpenAI only). Returns null
 *  when no API key is set — the caller still binds the space (so it's
 *  registered) but indexing stays disabled until the user adds a key
 *  (graceful no-key degrade). */
function resolveEmbedder(): EmbedderRuntimeConfig | null {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  return { provider: 'openai', apiKey };
}

/** Configure + spawn the daemon, then bind every known space under
 *  kbRoot. Idempotent on the bind side; safe to call once at server
 *  startup. With no API key, spaces are still bound (registered) but the
 *  collection isn't created until a key is supplied — search just
 *  returns nothing until then. */
export async function bootBindAllSpaces(): Promise<void> {
  const daemon = getDaemon();
  daemon.configure({ kbRoot: getKbRoot() });
  const known = listKnownSpaces();
  if (known.length === 0) {
    log.info('boot bind: no spaces found under kbRoot');
    return;
  }
  log.info(`boot bind: ${known.length} space(s): ${known.join(', ')}`);
  const cfg = resolveEmbedder() ?? { provider: 'openai' as const };
  for (const space of known) {
    try {
      await indexer.bindSpace(space, cfg);
    } catch (err: unknown) {
      log.warn(`boot bind ${space} failed: ${errorMessage(err)}`);
    }
  }
}

/** One-shot latch for the stale-flock sweep below. */
let staleLockSwept = false;

/** Bind the indexer to a space using the OpenAI embedder. Called on
 *  every space switch (idempotent). Doesn't trigger sync — caller's
 *  responsibility via `scheduleIndexerSync`. With no key the space is
 *  still bound but indexing is disabled. */
export async function bindIndexerForSpace(spaceAbs: string): Promise<void> {
  // Before the first bind of this process, sweep any stashbase daemon
  // still holding the Milvus flock: a dirty previous exit (kill -9, OS
  // shutdown) or another session's leftover embedded daemon would
  // otherwise wedge our bind, and the loser of a lock fight keeps
  // "succeeding" while its writes go nowhere (data-layer §8.1). This
  // call site is deliberately the WEB SERVER's bind path only — the MCP
  // host must never run the sweep, since the GUI's daemon is the
  // rightful lock owner it would be killing.
  if (!staleLockSwept) {
    staleLockSwept = true;
    try { clearStaleMilvusLock(getKbRoot()); } catch (err: unknown) {
      log.warn(`stale-lock sweep failed: ${errorMessage(err)}`);
    }
  }
  const cfg = resolveEmbedder();
  const runtime = cfg ?? { provider: 'openai' as const };
  if (!cfg) {
    log.warn(`embedder: no OpenAI key set — ${spaceAbs} bound but indexing/search disabled until a key is added`);
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

/** If the space ships a `.stashbase/snapshot.parquet` (v3 = a pure
 *  embedding cache) and the collection has no rows for it yet, load the
 *  cache into the daemon so the import-time reindex reuses vectors
 *  instead of re-embedding — lets a freshly-cloned starter (e.g. cs183b)
 *  come pre-indexed cheaply. The actual chunk rows are produced by the
 *  normal reindex (`syncIndex`) that follows; this only primes the
 *  cache. The cache is cleared by `clearSnapshotCacheIfLoaded` once that
 *  reindex drains.
 *
 *  Skips silently when the snapshot is absent or the space already has
 *  data. Requires the sibling `snapshot.meta.json` descriptor and a
 *  matching embedder; a mismatch records a UI warning and falls back to
 *  a full re-embed. */
async function maybeImportSnapshot(spaceAbs: string, spaceName: string): Promise<void> {
  const snapshot = path.join(spaceAbs, '.stashbase', 'snapshot.parquet');
  const metaPath = path.join(spaceAbs, '.stashbase', 'snapshot.meta.json');
  try {
    if (!fs.statSync(snapshot).isFile()) return;
  } catch {
    return;
  }
  try {
    const status = await indexer.status(spaceName);
    if (status.indexed > 0) return;
  } catch (err) {
    log.warn(`snapshot: status check failed for ${spaceName}: ${errorMessage(err)}`);
    return;
  }
  // v3 carries its descriptor (embedder identity + counts) in a JSON
  // sidecar, not in the Parquet. No JSON ⇒ legacy / unknown snapshot:
  // skip the cache and let the reindex embed from scratch.
  let meta: {
    embedder?: { provider?: string; model?: string; dim?: number };
    vectors?: number;
    chunks?: number;
  };
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    log.warn(`snapshot ${spaceName}: missing/invalid snapshot.meta.json (re-export with this build) — embedding from scratch`);
    return;
  }
  try {
    const res = await getDaemon().call<{
      loaded: number;
      mismatch: boolean;
      expected?: { provider: string; model: string | null; dim: number };
      got?: { provider?: string; model?: string; dim?: number };
    }>('load_vector_cache', { space: spaceName, in_path: snapshot, embedder: meta.embedder ?? {} });
    if (res.mismatch) {
      log.warn(
        `snapshot ${spaceName}: embedder mismatch (snapshot ${JSON.stringify(res.got)} ` +
          `vs current ${JSON.stringify(res.expected)}) — re-embedding. ` +
          `Switch the knowledge base's embedder to match, or re-export.`,
      );
      const got = res.got ?? meta.embedder ?? {};
      recordSnapshotWarning(spaceName, {
        skipped: meta.vectors ?? meta.chunks ?? 0,
        details: [{ provider: `${got.provider ?? '?'}_${got.dim ?? '?'}`, chunks: meta.vectors ?? meta.chunks ?? 0 }],
        at: new Date().toISOString(),
      });
      return;
    }
    if (res.loaded > 0) {
      loadedSnapshotCaches.add(spaceName);
      clearSnapshotWarning(spaceName);
      log.info(`snapshot ${spaceName}: vector cache primed (${res.loaded} vectors) — reindex will reuse`);
    }
  } catch (err) {
    log.warn(`snapshot cache load ${spaceName} failed: ${errorMessage(err)}`);
  }
}


// Serialise indexer bind + sync so rapid space switches don't race. The
// seq guard short-circuits a stale tail when the user has already moved
// on; the queue chains each switch after the previous one finishes.
const indexerSwitchSeq = new Map<string, number>();
const indexerSwitchQueues = new Map<string, Promise<void>>();

/** Live bookkeeping behind the gate + watchdog: one record per scheduled
 *  bind+sync segment, self-removing when the segment settles. Lets the
 *  gate filter by space and the watchdog name what's stuck. */
interface PendingSwitch {
  promise: Promise<void>;
  spaceRoot: string;
  reason: string;
  windowId: string;
  scheduledAt: number;
  warned: boolean;
}
const pendingSwitches = new Set<PendingSwitch>();

// Watchdog for invariant I4 (data-layer §8.6): every queue entry must
// settle in bounded time. A hard timeout can't work here — first-index
// of a large space legitimately runs bind+sync for tens of minutes — so
// we supervise instead of intervene: any entry older than 15min gets one
// loud warning with enough context to find the wedge. Lazily started,
// unref'd so it never keeps the process alive.
const SWITCH_WATCHDOG_AFTER_MS = 15 * 60_000;
let switchWatchdog: NodeJS.Timeout | null = null;
function ensureSwitchWatchdog(): void {
  if (switchWatchdog) return;
  switchWatchdog = setInterval(() => {
    const now = Date.now();
    for (const p of pendingSwitches) {
      if (p.warned || now - p.scheduledAt < SWITCH_WATCHDOG_AFTER_MS) continue;
      p.warned = true;
      log.warn(
        `space-open queue entry unsettled after ${Math.round((now - p.scheduledAt) / 60_000)}min ` +
          `(${p.reason}, space=${p.spaceRoot}, window=${p.windowId}) — bind/import/sync may be wedged ` +
          '(data-layer §8.6 I4)',
      );
    }
  }, 60_000);
  switchWatchdog.unref();
}

function scheduleIndexerSync(spaceRoot: string, reason: string, windowId = 'default'): void {
  const seq = (indexerSwitchSeq.get(windowId) ?? 0) + 1;
  indexerSwitchSeq.set(windowId, seq);
  const prev = indexerSwitchQueues.get(windowId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await runWithWindowId(windowId, async () => {
        if (getCurrentSpace() !== spaceRoot) return;
        try {
          await bindIndexerForSpace(spaceRoot);
          if (getCurrentSpace() !== spaceRoot || seq !== indexerSwitchSeq.get(windowId)) return;
          // Full content-hash diff — the only reconcile tier. Hashing
          // is milliseconds for a personal KB; embedding still only
          // happens for changed hashes, so reopening a fully-indexed
          // space costs zero tokens, AND external edits made while the
          // app was closed are caught right here instead of waiting for
          // a manual sync.
          const spaceName = getCurrentSpaceName();
          if (spaceName) await syncIndex(indexer, spaceName);
        } catch (err: unknown) {
          log.warn(`${reason}: index sync failed for ${spaceRoot}: ${errorMessage(err)}`);
        } finally {
          // The import-time reindex (if any) has drained — free the
          // daemon-side snapshot vector cache. No-op when none was loaded.
          await clearSnapshotCacheIfLoaded(spaceRoot);
        }
      });
    });
  indexerSwitchQueues.set(windowId, next);
  const entry: PendingSwitch = {
    promise: next, spaceRoot, reason, windowId, scheduledAt: Date.now(), warned: false,
  };
  pendingSwitches.add(entry);
  ensureSwitchWatchdog();
  void next.catch(() => undefined).finally(() => pendingSwitches.delete(entry));
}

// Fire a queued bind + sync on every space switch. Registered at module
// load time so any importer (index.ts, tests) gets the wiring for free.
onSwitch((newRoot, windowId) => {
  scheduleIndexerSync(newRoot, 'space switch', windowId);
});

onClose((_oldRoot, windowId) => {
  indexerSwitchSeq.set(windowId, (indexerSwitchSeq.get(windowId) ?? 0) + 1);
  indexerSwitchQueues.delete(windowId);
});
