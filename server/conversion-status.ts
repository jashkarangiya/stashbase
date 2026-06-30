/**
 * Conversion status (PDF + image) — split by durability:
 *
 *   - **in-flight: process memory only.** A conversion's subprocess is
 *     our child; if this process dies, the conversion dies with it, so
 *     persisting "in-flight" only ever produced corpses that needed a
 *     reclaim pass on every reconcile. Memory state can't outlive the
 *     truth it describes. After a crash, an unconverted source is simply
 *     rediscovered ("source exists, derived note doesn't, no failure
 *     record → queue") — conversions are idempotent.
 *
 *   - **failures: persisted** (per-machine app-data `state.db`,
 *     `conversions` table) — the Retry banner needs the reason and
 *     attempt count to survive restarts, and a persistent failure must
 *     NOT be silently re-queued by the next discovery walk.
 *
 * "Done" is not a state we record: the derived note on disk IS the
 * record (discovery skips sources whose note exists).
 */
import {
  clearConversionStatus,
  clearConversionStatusUnder,
  getConversionStatus,
  listConversionStatus,
  readConversionStatusMap,
  setConversionStatus,
  type ConversionStatus,
  type ConversionStatusEntry,
} from './state-db.ts';

export type { ConversionStatus, ConversionStatusEntry };
export type ConversionStatusMap = Record<string, ConversionStatusEntry>;
export type ConversionProgress =
  | { phase: 'extracting'; currentPage?: number }
  | { phase: 'indexing' };

const inFlight = new Set<string>();
const progress = new Map<string, ConversionProgress>();

/** Persisted failures only (the Retry surface). */
export function readAll(): ConversionStatusMap {
  return readConversionStatusMap();
}


/** True when this source needs no (re)queue decision: either a
 *  conversion is running right now, or a persisted failure says a human
 *  must press Retry first. */
export function isPendingOrFailed(sourcePath: string): boolean {
  return inFlight.has(sourcePath) || getConversionStatus(sourcePath) !== undefined;
}

export function markInFlight(sourcePath: string): void {
  inFlight.add(sourcePath);
  progress.set(sourcePath, { phase: 'extracting' });
}

export function isInFlight(sourcePath: string): boolean {
  return inFlight.has(sourcePath);
}

export function hasInFlightUnder(sourcePathPrefix: string): boolean {
  const name = sourcePathPrefix.replace(/\/+$/, '');
  if (!name) return false;
  const prefix = `${name}/`;
  for (const path of inFlight) {
    if (path === name || path.startsWith(prefix)) return true;
  }
  return false;
}

/** Success: drop the in-flight marker and clear any stale failure row
 *  from a previous attempt. */
export function markDone(sourcePath: string): void {
  inFlight.delete(sourcePath);
  progress.delete(sourcePath);
  clearConversionStatus(sourcePath);
}

export function markFailed(sourcePath: string, errorMsg: string): void {
  inFlight.delete(sourcePath);
  progress.delete(sourcePath);
  setConversionStatus(sourcePath, 'failed', { error: errorMsg, incrementAttempts: true });
}

export function clearRecord(sourcePath: string): void {
  inFlight.delete(sourcePath);
  progress.delete(sourcePath);
  clearConversionStatus(sourcePath);
}

export function clearRecordsUnder(sourcePathPrefix: string): void {
  const name = sourcePathPrefix.replace(/\/+$/, '');
  if (!name) return;
  const prefix = `${name}/`;
  for (const path of [...inFlight]) {
    if (path === name || path.startsWith(prefix)) {
      inFlight.delete(path);
      progress.delete(path);
    }
  }
  clearConversionStatusUnder(name);
}

export function listFailed(): Array<{ path: string; entry: ConversionStatusEntry }> {
  return listConversionStatus('failed');
}

/** sourcePaths with a conversion running in this process right now. */
export function listInFlight(): string[] {
  return [...inFlight];
}

export function setProgress(sourcePath: string, next: ConversionProgress): void {
  if (!inFlight.has(sourcePath)) return;
  progress.set(sourcePath, next);
}

export function readProgress(sourcePath: string): ConversionProgress | undefined {
  return progress.get(sourcePath);
}
