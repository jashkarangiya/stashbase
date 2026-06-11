/**
 * fs.watch the current space root and trigger `syncIndex` when files
 * change externally (vim, git checkout, Dropbox …). The in-app save
 * path goes through `PUT /api/files/*` and doesn't need this — the
 * watcher exists for changes that happen behind StashBase's back.
 *
 * Two pieces of debouncing:
 *   - **Event-level**: batch many fs events (a Dropbox sync can fire
 *     hundreds within seconds) into one `syncIndex` call.
 *   - **Self-write suppression**: when the app itself saves a file
 *     it'd be a waste to trigger a sync round-trip. The save path
 *     calls `noteSelfWrite(path)` immediately before writing; we
 *     ignore any event for that path within a short window.
 *
 * `recursive: true` is supported on macOS + Windows. On Linux it
 * silently degrades to root-only — accept that for v1 (most StashBase
 * users are on macOS; Linux fallback is "manual sync button").
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';
import { onClose, onSwitch, getActiveSpaces, getCurrentSpaceName, runWithWindowId } from './space.ts';
import { syncIndex } from './sync.ts';
import { awaitIndexerReady } from './state.ts';
import type { Indexer } from './indexer.ts';

const log = logger('watcher');

const DEBOUNCE_MS = 800;
const SELF_WRITE_TTL_MS = 1500;

const activeWatchers = new Map<string, fs.FSWatcher>();
const watchedRoots = new Map<string, string>();
const debounceHandles = new Map<string, NodeJS.Timeout>();
const selfWrites = new Map<string, number>(); // absolute path → epoch ms
let registered = false;

// Monotonic counter bumped every time the watcher sees an external
// change on disk (after self-write filtering). Exposed through
// `/api/index-status.treeVersion`; the renderer compares against its
// last-seen value and calls `/api/files` on any bump — covering
// non-indexable files (`.json`, empty dirs, …) and fast embeds whose
// `pending` set flips between polls. Resets on space switch.
let fsChangeCounter = 0;

/** Read-only view of the tree-change counter for `/api/index-status`. */
export function getFsChangeCounter(): number {
  return fsChangeCounter;
}

/** Wire one indexer's sync to fs.watch events on the current space.
 *  Re-binds whenever the user switches spaces. Safe to call multiple
 *  times (idempotent registration of the onSwitch listener — only do
 *  it once at server startup). */
export function startWatcher(indexer: Indexer): void {
  for (const active of getActiveSpaces()) {
    bindToSpace(indexer, active.path, active.windowId);
  }
  if (registered) return;
  registered = true;
  onSwitch((newRoot, windowId) => bindToSpace(indexer, newRoot, windowId));
  onClose((_oldRoot, windowId) => closeWindow(windowId));
}

/** Tell the watcher "we're about to write this file ourselves" so the
 *  fs.watch event it triggers doesn't fire a redundant sync. Called
 *  from the save path immediately before `fs.writeFileSync`. */
export function noteSelfWrite(absPath: string): void {
  selfWrites.set(absPath, Date.now());
  // Opportunistic GC to keep the map bounded.
  if (selfWrites.size > 256) {
    const cutoff = Date.now() - SELF_WRITE_TTL_MS;
    for (const [k, t] of selfWrites) if (t < cutoff) selfWrites.delete(k);
  }
}

function bindToSpace(indexer: Indexer, root: string | null, windowId: string): void {
  if (root === watchedRoots.get(windowId)) return;
  closeWindow(windowId);
  if (root) watchedRoots.set(windowId, root);
  if (!root) return;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const fname = filename.toString();
      // Skip our own sidecar dir — Milvus writes to it every embed.
      if (fname.startsWith('.stashbase')) return;
      const full = path.join(root, fname);
      const selfWriteAt = selfWrites.get(full);
      if (selfWriteAt && Date.now() - selfWriteAt < SELF_WRITE_TTL_MS) return;
      // Bump per event (not per debounced sync) so the renderer sees
      // every disk-tree change — including non-indexable files that
      // wouldn't move the indexer's `pending` set.
      fsChangeCounter++;
      scheduleSync(indexer, windowId, root);
    });
    activeWatchers.set(windowId, watcher);
    log.info(`watching ${root} (${windowId})`);
  } catch (err: unknown) {
    log.warn(`fs.watch failed for ${root}: ${errorMessage(err)}`);
  }
}

function scheduleSync(indexer: Indexer, windowId: string, root: string): void {
  const existing = debounceHandles.get(windowId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    debounceHandles.delete(windowId);
    void runSyncAfterReady(indexer, windowId, root);
  }, DEBOUNCE_MS);
  debounceHandles.set(windowId, handle);
}

async function runSyncAfterReady(indexer: Indexer, windowId: string, root: string): Promise<void> {
  // Wait for any in-flight bind + snapshot-import ON THIS SPACE to
  // drain. Without this gate, a clone that fires fs events at the same
  // moment the user opens the cloned space races: scan_diff runs before
  // the bind+import finishes, sees an empty collection, reports every
  // file as `added`, and re-embeds the very chunks the snapshot just
  // imported. Scoped to `root` — the race is per-space, and a wedged
  // chain on an unrelated space must not stall this watcher.
  await awaitIndexerReady(root);
  await runWithWindowId(windowId, async () => {
    const space = getCurrentSpaceName();
    if (!space) return; // space closed mid-debounce or never opened
    log.info(`external change detected → running sync (${windowId})`);
    try {
      await syncIndex(indexer, space);
    } catch (err: unknown) {
      log.warn(`watcher-triggered sync failed: ${errorMessage(err)}`);
    }
  });
}

function closeWindow(windowId: string): void {
  const handle = debounceHandles.get(windowId);
  if (handle) {
    clearTimeout(handle);
    debounceHandles.delete(windowId);
  }
  const watcher = activeWatchers.get(windowId);
  if (watcher) {
    try { watcher.close(); } catch { /* swallow */ }
    activeWatchers.delete(windowId);
  }
  watchedRoots.delete(windowId);
}

/** Tear down the active fs.watch + cancel any pending debounce.
 *  Called from the server's shutdown path so the watcher doesn't
 *  keep the event loop alive past the intended exit. */
export function stopWatcher(): void {
  for (const windowId of [...activeWatchers.keys(), ...debounceHandles.keys()]) {
    closeWindow(windowId);
  }
}
