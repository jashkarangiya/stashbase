/**
 * PDF conversion status backed by `<KB>/.stashbase/state.db`.
 *
 * Kept as a small compatibility wrapper because the conversion/UI
 * pipeline already speaks this module's functions.
 */
import {
  clearPdfStatus,
  getPdfStatus,
  hasPdfStatus,
  listPdfStatus,
  readPdfStatusMap,
  setPdfStatus,
  type PdfStatus,
  type PdfStatusEntry,
} from './state-db.ts';

export type { PdfStatus, PdfStatusEntry };
export type PdfStatusMap = Record<string, PdfStatusEntry>;

export function readAll(): PdfStatusMap {
  return readPdfStatusMap();
}

export function getEntry(kbRel: string): PdfStatusEntry | undefined {
  return getPdfStatus(kbRel);
}

export function hasRecord(kbRel: string): boolean {
  return hasPdfStatus(kbRel);
}

export function markInFlight(kbRel: string): void {
  setPdfStatus(kbRel, 'in-flight', { incrementAttempts: true });
}

export function markDone(kbRel: string): void {
  setPdfStatus(kbRel, 'done');
}

export function markFailed(kbRel: string, errorMsg: string): void {
  setPdfStatus(kbRel, 'failed', { error: errorMsg });
}

export function clearRecord(kbRel: string): void {
  clearPdfStatus(kbRel);
}

export function listByStatus(status: PdfStatus): Array<{ path: string; entry: PdfStatusEntry }> {
  return listPdfStatus(status);
}
