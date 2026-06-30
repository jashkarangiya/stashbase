/**
 * Tree-version signal — the surviving piece of the old fs.watch layer.
 *
 * 2026-06 simplification: StashBase no longer watches the filesystem.
 * Reconcile runs at deterministic event points instead — folder
 * open/switch, window focus, agent turn end, the manual Sync button, and
 * MCP `reindex`. That deleted the debounce window, the self-write
 * suppression TTL, the watcher-vs-import race gate, and the whole class
 * of "fs event arrived at the wrong moment" bugs. External edits made
 * while the app is focused surface on the next event point; everything
 * the app (or an agent via API) writes is indexed on its own write path.
 *
 * What remains is a monotonic counter the renderer polls through
 * `/api/index-status.treeVersion`: any bump means "the visible file tree
 * may have changed — refetch /api/files". Routes that create/delete/move
 * files call `noteTreeChanged()` after the disk operation; sync bumps it
 * when a reconcile actually changed something.
 */

let fsChangeCounter = 0;

/** Read-only view of the tree-change counter for `/api/index-status`. */
export function getFsChangeCounter(): number {
  return fsChangeCounter;
}

/** Notify renderers that a write changed the visible file tree. */
export function noteTreeChanged(): void {
  fsChangeCounter++;
}
