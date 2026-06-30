/**
 * Process-wide indexer state + folder-switch orchestration.
 *
 * One `MfsIndexer` instance lives for the lifetime of the server
 * process. The daemon underneath owns one Milvus DB in app data with a
 * single collection (V1 fixes the embedder to OpenAI — no switching).
 * Every folder is bound into that one collection. Boot binds
 * every known folder so MCP cross-folder search has them all
 * available; opening a folder re-binds (idempotent) and runs reconcile
 * to pick up disk changes.
 *
 * Extracted from `server/index.ts` so route modules can import the
 * indexer without picking up the whole route registration kitchen sink.
 */
import { MfsIndexer } from './indexer.mfs.ts';
import type { Indexer, EmbedderRuntimeConfig } from './indexer.ts';
import { getCurrentFolder, getRecentFolders, onClose, onSwitch, runWithWindowId, toPosixAbs } from './folder.ts';
import { getApiKey } from './app-config.ts';
import { syncIndex, type SyncResult } from './sync.ts';
import { getDaemon } from './mfs-daemon.ts';
import { clearStaleMilvusLock } from './stale-lock.ts';
import { noteTreeChanged } from './watcher.ts';
import { logger, errorMessage } from './log.ts';
import { globalVectorStoreDir } from './local-data.ts';
import path from 'node:path';

const log = logger('state');

/** Single indexer instance shared across every route. */
export const indexer: Indexer = new MfsIndexer();

export interface IndexSyncWarning {
  message: string;
  at: string;
}
const indexWarnings = new Map<string, IndexSyncWarning>();
export function getIndexWarning(folder: string): IndexSyncWarning | null {
  return indexWarnings.get(folder) ?? null;
}
export function clearIndexWarning(folder: string): void {
  indexWarnings.delete(folder);
}
function recordIndexWarning(folder: string, message: string): void {
  indexWarnings.set(folder, { message, at: new Date().toISOString() });
}

const folderSyncGeneration = new Map<string, number>();

export function invalidateFolderSync(folderRoot: string): void {
  const root = toPosixAbs(folderRoot);
  if (!root) return;
  folderSyncGeneration.set(root, (folderSyncGeneration.get(root) ?? 0) + 1);
}

function currentFolderSyncGeneration(folderRoot: string): number {
  return folderSyncGeneration.get(folderRoot) ?? 0;
}

function shouldContinueFolderSync(
  folderRoot: string,
  startedAt: number,
  callerShouldContinue?: () => boolean,
): boolean {
  return currentFolderSyncGeneration(folderRoot) === startedAt && (!callerShouldContinue || callerShouldContinue());
}

export async function deleteFolderRuntimeState(folderRoot: string): Promise<void> {
  const root = toPosixAbs(folderRoot);
  indexWarnings.delete(root);
  folderSyncGeneration.delete(root);
}

/** Resolve the runtime embedder config (V1 = OpenAI only). Returns null
 *  when no API key is set — the caller still binds the folder (so it's
 *  registered) but indexing stays disabled until the user adds a key
 *  (graceful no-key degrade). */
function resolveEmbedder(): EmbedderRuntimeConfig | null {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  return { provider: 'openai', apiKey };
}

/** Configure + spawn the daemon, then bind every folder in Your Folders.
 *  Idempotent on the bind side; safe to call once at server
 *  startup. With no API key, folders are still bound (registered) but the
 *  collection isn't created until a key is supplied — search just
 *  returns nothing until then. */
export async function bootBindAllFolders(): Promise<void> {
  // Membership = "Your Folders" (the recents list), which can live anywhere
  // on disk. Bind every member's absolute root so MCP/Claude can search the
  // whole library without the user first opening each folder.
  const members = getRecentFolders().map((r) => toPosixAbs(r.path));
  const roots = Array.from(new Set(members));
  if (roots.length === 0) {
    log.info('boot bind: no member folders');
    return;
  }
  log.info(`boot bind: ${roots.length} folder(s)`);
  const cfg = resolveEmbedder() ?? { provider: 'openai' as const };
  for (const root of roots) {
    try {
      await indexer.bindFolder(root, cfg);
    } catch (err: unknown) {
      log.warn(`boot bind ${root} failed: ${errorMessage(err)}`);
    }
  }
}

/** Tear down the Python daemon after global runtime config changes.
 *  `forgetBindings` is important for OpenAI key changes: bindings replay
 *  during daemon startup carry credentials, so stale entries could
 *  recreate the embedder with the old key before the fresh bind lands. */
export async function resetIndexerRuntime(opts: { forgetBindings?: boolean } = {}): Promise<void> {
  await indexer.close();
  if (opts.forgetBindings) getDaemon().forgetBindings();
}

/** Per-vector-store latch for the stale-flock sweep below. */
const staleLockSweptStores = new Set<string>();

function claimStaleLockSweep(storeRoot: string): boolean {
  const key = path.resolve(storeRoot);
  if (staleLockSweptStores.has(key)) return false;
  staleLockSweptStores.add(key);
  return true;
}

/** Bind the indexer to a folder using the OpenAI embedder. Called on
 *  every folder switch (idempotent). Doesn't trigger sync — caller's
 *  responsibility via `scheduleIndexerSync`. With no key the folder is
 *  still bound but indexing is disabled. */
export async function bindIndexerForFolder(folderAbs: string): Promise<void> {
  // Before the first bind of this process, sweep any stashbase daemon
  // still holding the global Milvus flock: a dirty previous exit (kill -9,
  // OS shutdown) or another session's leftover daemon would otherwise
  // wedge our bind, and the loser of a lock fight keeps "succeeding" while
  // its writes go nowhere (data-layer §8.1). This call site is
  // deliberately the WEB SERVER's bind path only — the MCP host must never
  // run the sweep, since the GUI's daemon is the rightful lock owner it
  // would be killing.
  if (claimStaleLockSweep(globalVectorStoreDir())) {
    try { clearStaleMilvusLock(); } catch (err: unknown) {
      log.warn(`stale-lock sweep failed: ${errorMessage(err)}`);
    }
  }
  const cfg = resolveEmbedder();
  const runtime = cfg ?? { provider: 'openai' as const };
  if (!cfg) {
    log.warn(`embedder: no OpenAI key set — ${folderAbs} bound but indexing/search disabled until a key is added`);
  }
  await indexer.bindFolder(toPosixAbs(folderAbs), runtime);
}


// Serialise indexer bind + sync so rapid folder switches don't race. The
// seq guard short-circuits a stale tail when the user has already moved
// on; the queue chains each switch after the previous one finishes.
const indexerSwitchSeq = new Map<string, number>();
const indexerSwitchQueues = new Map<string, Promise<void>>();

/** Live bookkeeping behind the gate + watchdog: one record per scheduled
 *  bind+sync segment, self-removing when the segment settles. Lets the
 *  gate filter by folder and the watchdog name what's stuck. */
interface PendingSwitch {
  promise: Promise<void>;
  folderRoot: string;
  reason: string;
  windowId: string;
  scheduledAt: number;
  warned: boolean;
}
const pendingSwitches = new Set<PendingSwitch>();

// Watchdog for invariant I4 (data-layer §8.6): every queue entry must
// settle in bounded time. A hard timeout can't work here — first-index
// of a large folder legitimately runs bind+sync for tens of minutes — so
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
        `folder-open queue entry unsettled after ${Math.round((now - p.scheduledAt) / 60_000)}min ` +
          `(${p.reason}, folder=${p.folderRoot}, window=${p.windowId}) — bind/import/sync may be wedged ` +
          '(data-layer §8.6 I4)',
      );
    }
  }, 60_000);
  switchWatchdog.unref();
}

function syncFailureMessage(result: SyncResult): string {
  const sample = result.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join('; ');
  const suffix = result.failed.length > 3 ? `; plus ${result.failed.length - 3} more` : '';
  return `${result.failed.length} file(s) could not be indexed${sample ? ` (${sample}${suffix})` : ''}`;
}

function syncTouchedVisibleTree(result: SyncResult): boolean {
  return result.added.length > 0
    || result.modified.length > 0
    || result.removed.length > 0
    || result.renamed.length > 0
    || result.failed.length > 0;
}

const folderSyncQueues = new Map<string, Promise<unknown>>();

export async function syncFolderNow(
  folderRoot: string,
  opts: { reason?: string; shouldContinue?: () => boolean } = {},
): Promise<SyncResult> {
  const syncFolderRoot = toPosixAbs(folderRoot);
  const prev = folderSyncQueues.get(syncFolderRoot) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => syncFolderNowInner(syncFolderRoot, opts));
  const settled = next.finally(() => {
    if (folderSyncQueues.get(syncFolderRoot) === settled) {
      folderSyncQueues.delete(syncFolderRoot);
    }
  });
  folderSyncQueues.set(syncFolderRoot, settled);
  return next;
}

async function syncFolderNowInner(
  folderRoot: string,
  opts: { reason?: string; shouldContinue?: () => boolean },
): Promise<SyncResult> {
  const syncGeneration = currentFolderSyncGeneration(folderRoot);
  const shouldContinue = () => shouldContinueFolderSync(folderRoot, syncGeneration, opts.shouldContinue);
  try {
    await bindIndexerForFolder(folderRoot);
    if (!shouldContinue()) {
      return { added: [], modified: [], removed: [], renamed: [], failed: [], cancelled: true };
    }
    const result = await syncIndex(indexer, folderRoot, { shouldContinue });
    if (result.cancelled) {
      return result;
    }
    if (syncTouchedVisibleTree(result)) noteTreeChanged();
    if (result.failed.length) {
      recordIndexWarning(folderRoot, syncFailureMessage(result));
    } else {
      clearIndexWarning(folderRoot);
    }
    return result;
  } catch (err: unknown) {
    recordIndexWarning(folderRoot, errorMessage(err));
    throw err;
  }
}

export function scheduleIndexerSync(folderRoot: string, reason: string, windowId = 'default'): void {
  const seq = (indexerSwitchSeq.get(windowId) ?? 0) + 1;
  indexerSwitchSeq.set(windowId, seq);
  const prev = indexerSwitchQueues.get(windowId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await runWithWindowId(windowId, async () => {
        if (getCurrentFolder() !== folderRoot) return;
        try {
          // Full content-hash diff — the only reconcile tier. Hashing
          // is milliseconds for a personal library; embedding still only
          // happens for changed hashes, so reopening a fully-indexed
          // folder costs zero tokens, AND external edits made while the
          // app was closed are caught right here instead of waiting for
          // a manual sync.
          await syncFolderNow(folderRoot, {
            reason,
            shouldContinue: () => getCurrentFolder() === folderRoot && seq === indexerSwitchSeq.get(windowId),
          });
        } catch (err: unknown) {
          log.warn(`${reason}: index sync failed for ${folderRoot}: ${errorMessage(err)}`);
        }
      });
    });
  indexerSwitchQueues.set(windowId, next);
  const entry: PendingSwitch = {
    promise: next, folderRoot, reason, windowId, scheduledAt: Date.now(), warned: false,
  };
  pendingSwitches.add(entry);
  ensureSwitchWatchdog();
  void next.catch(() => undefined).finally(() => pendingSwitches.delete(entry));
}

// Fire a queued bind + sync on every folder switch. Registered at module
// load time so any importer (index.ts, tests) gets the wiring for free.
onSwitch((newRoot, windowId) => {
  scheduleIndexerSync(newRoot, 'folder switch', windowId);
});

onClose((_oldRoot, windowId) => {
  indexerSwitchSeq.set(windowId, (indexerSwitchSeq.get(windowId) ?? 0) + 1);
  indexerSwitchQueues.delete(windowId);
});
