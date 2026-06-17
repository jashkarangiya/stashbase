/**
 * Conversion status (PDF + image + recording) — split by durability:
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
  getConversionStatus,
  listConversionStatus,
  readConversionStatusMap,
  setConversionStatus,
  type ConversionStatus,
  type ConversionStatusEntry,
} from './state-db.ts';

export type { ConversionStatus, ConversionStatusEntry };
export type ConversionStatusMap = Record<string, ConversionStatusEntry>;

const inFlight = new Set<string>();

/** Persisted failures only (the Retry surface). */
export function readAll(): ConversionStatusMap {
  return readConversionStatusMap();
}


/** True when this source needs no (re)queue decision: either a
 *  conversion is running right now, or a persisted failure says a human
 *  must press Retry first. */
export function isPendingOrFailed(kbRel: string): boolean {
  return inFlight.has(kbRel) || getConversionStatus(kbRel) !== undefined;
}

export function markInFlight(kbRel: string): void {
  inFlight.add(kbRel);
}

/** Success: drop the in-flight marker and clear any stale failure row
 *  from a previous attempt. */
export function markDone(kbRel: string): void {
  inFlight.delete(kbRel);
  clearConversionStatus(kbRel);
}

export function markFailed(kbRel: string, errorMsg: string): void {
  inFlight.delete(kbRel);
  setConversionStatus(kbRel, 'failed', { error: errorMsg, incrementAttempts: true });
}

export function clearRecord(kbRel: string): void {
  inFlight.delete(kbRel);
  clearConversionStatus(kbRel);
}

export function listFailed(): Array<{ path: string; entry: ConversionStatusEntry }> {
  return listConversionStatus('failed');
}

/** kbRels with a conversion running in this process right now. */
export function listInFlight(): string[] {
  return [...inFlight];
}
