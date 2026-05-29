/**
 * PDF conversion status, persisted to `<KB>/.stashbase/pdf-status.json`.
 *
 * This is the JSON-backed stand-in for what will eventually live in
 * `state.db` (a colleague is introducing SQLite separately; see
 * 02-storage待做 01). Until then, this module gives us:
 *
 *   - Persistent failure list across app restart (so the UI can show
 *     "this PDF failed last time" + a Retry button on next boot)
 *   - Idempotent reconcile: skip any PDF that already has a record
 *     (success / failed / cancelled), only auto-convert when the
 *     record is absent
 *   - In-flight tracking that survives reloads (without this, the
 *     status poll loses a converting PDF on every page reload)
 *
 * Schema: a flat map keyed by KB-relative POSIX path. We pick KB-relative
 * paths (not space-relative) because the file is library-wide — failures
 * from any space all live here, queryable in one read.
 *
 * Concurrency: in-process only. We don't expect concurrent writers since
 * a single Node process owns the file. Atomic write via `.tmp + rename`
 * matches the file-order convention.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger, errorMessage, errorCode } from './log.ts';
import { getKbRoot } from './space.ts';

const log = logger('pdf-status');

const FILE = '.stashbase/pdf-status.json';

export type PdfStatus = 'in-flight' | 'done' | 'failed' | 'cancelled';

export interface PdfStatusEntry {
  status: PdfStatus;
  attempts: number;
  /** Most recent error message (only present for `failed`). */
  lastError?: string;
  /** ISO string, set on every transition. */
  lastAttemptAt: string;
  /** ISO string, set when status becomes `done`. */
  doneAt?: string;
}

export type PdfStatusMap = Record<string, PdfStatusEntry>;

function statusPath(): string {
  return path.join(getKbRoot(), FILE);
}

/** Read the full map. Returns `{}` on missing / corrupt file — never
 *  throws, because the convert path must keep working even if the
 *  sidecar dir was wiped. */
export function readAll(): PdfStatusMap {
  const target = statusPath();
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PdfStatusMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string') continue;
      const entry = sanitize(v);
      if (entry) out[k] = entry;
    }
    return out;
  } catch (err: unknown) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn(`failed to read pdf-status.json: ${errorMessage(err)}`);
    }
    return {};
  }
}

function sanitize(v: unknown): PdfStatusEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const status = o.status;
  if (status !== 'in-flight' && status !== 'done' && status !== 'failed' && status !== 'cancelled') {
    return null;
  }
  const attempts = typeof o.attempts === 'number' && Number.isFinite(o.attempts) ? o.attempts : 0;
  const lastAttemptAt = typeof o.lastAttemptAt === 'string' ? o.lastAttemptAt : new Date(0).toISOString();
  const entry: PdfStatusEntry = { status, attempts, lastAttemptAt };
  if (typeof o.lastError === 'string') entry.lastError = o.lastError;
  if (typeof o.doneAt === 'string') entry.doneAt = o.doneAt;
  return entry;
}

function writeAll(map: PdfStatusMap): void {
  const target = statusPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    log.warn(`failed to write pdf-status.json: ${errorMessage(err)}`);
  }
}

export function getEntry(kbRel: string): PdfStatusEntry | undefined {
  return readAll()[kbRel];
}

/** Look up by KB-relative path. Returns null if no record exists. */
export function hasRecord(kbRel: string): boolean {
  return readAll()[kbRel] != null;
}

/** Mark `in-flight` (or start a new attempt). Increments `attempts`
 *  unless this is the first record. Clears `lastError`. */
export function markInFlight(kbRel: string): void {
  const map = readAll();
  const prev = map[kbRel];
  map[kbRel] = {
    status: 'in-flight',
    attempts: (prev?.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
  };
  writeAll(map);
}

export function markDone(kbRel: string): void {
  const map = readAll();
  const prev = map[kbRel];
  map[kbRel] = {
    status: 'done',
    attempts: prev?.attempts ?? 1,
    lastAttemptAt: new Date().toISOString(),
    doneAt: new Date().toISOString(),
  };
  writeAll(map);
}

export function markFailed(kbRel: string, errorMsg: string): void {
  const map = readAll();
  const prev = map[kbRel];
  map[kbRel] = {
    status: 'failed',
    attempts: prev?.attempts ?? 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: errorMsg,
  };
  writeAll(map);
}

/** Clear a record so reconcile / explicit Retry treats the PDF as if it
 *  were never seen. Used by the Retry endpoint right before re-running
 *  the converter. */
export function clearRecord(kbRel: string): void {
  const map = readAll();
  if (!(kbRel in map)) return;
  delete map[kbRel];
  writeAll(map);
}

/** All entries with a given status. Used for the failures-list UI and
 *  for surfacing "currently converting" on /api/index-status. */
export function listByStatus(status: PdfStatus): Array<{ path: string; entry: PdfStatusEntry }> {
  const map = readAll();
  const out: Array<{ path: string; entry: PdfStatusEntry }> = [];
  for (const [p, e] of Object.entries(map)) {
    if (e.status === status) out.push({ path: p, entry: e });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
