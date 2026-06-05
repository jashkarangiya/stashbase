/**
 * KB-level transactional state in `<kbRoot>/.stashbase/state.db`.
 *
 * This is StashBase-owned state, separate from MFS/Milvus' `store/`
 * schema. It holds exactly one thing: PDF / image conversion status
 * (in-flight + failed-with-reason), which is non-derivable — a failed
 * conversion looks identical on disk to one that hasn't run — and drives
 * the sidebar "Converting…" indicator and the per-file Retry banner.
 *
 * Everything else lives at its authoritative source: the daemon/store
 * owns the per-file hash + index state (via `scan_diff`), the filesystem
 * answers "does this file exist", and `~/.stashbase/config.json` holds
 * recents / kbRoot / embedder config. (Earlier `files` and `index_queue`
 * tables duplicated daemon/reconcile state write-only and were removed.)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';
import { getKbRoot } from './space.ts';

const log = logger('state-db');

export type PdfStatus = 'in-flight' | 'done' | 'failed' | 'cancelled';

export interface PdfStatusEntry {
  status: PdfStatus;
  attempts: number;
  lastError?: string;
  lastAttemptAt: string;
  doneAt?: string;
}

let db: Database.Database | null = null;
let dbPath: string | null = null;

function stateDbPath(): string {
  return path.join(getKbRoot(), '.stashbase', 'state.db');
}

export function getStateDb(): Database.Database {
  const target = stateDbPath();
  if (db && dbPath === target) return db;
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new Database(target);
  dbPath = target;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  migratePdfStatusJson(db);
  return db;
}

export function closeStateDb(): void {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
  dbPath = null;
}

function migrate(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS pdf_conversions (
      path TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('in-flight', 'done', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT NOT NULL,
      done_at TEXT
    );

    CREATE INDEX IF NOT EXISTS pdf_conversions_status_idx ON pdf_conversions(status, last_attempt_at);

    -- Removed: 'files' (a per-file index/hash table) and 'index_queue'
    -- (a durable op queue). Both were write-only — the daemon/store owns
    -- the authoritative per-file hash (via scan_diff) and reconcile
    -- recovers idempotently, so nothing consumed them. Drop on open so
    -- existing installs shed the dead tables. The conversion table below
    -- (PDF + image, despite the legacy name) is the only state.db data
    -- that is non-derivable and actually read.
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS index_queue;
  `);
}

function migratePdfStatusJson(conn: Database.Database): void {
  const legacy = path.join(getKbRoot(), '.stashbase', 'pdf-status.json');
  const migrated = legacy + '.migrated';
  if (!fs.existsSync(legacy) || fs.existsSync(migrated)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const upsert = conn.prepare(`
        INSERT INTO pdf_conversions (path, status, attempts, last_error, last_attempt_at, done_at)
        VALUES (@path, @status, @attempts, @lastError, @lastAttemptAt, @doneAt)
        ON CONFLICT(path) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          last_error = excluded.last_error,
          last_attempt_at = excluded.last_attempt_at,
          done_at = excluded.done_at
      `);
      const tx = conn.transaction((entries: Array<Record<string, unknown>>) => {
        for (const entry of entries) upsert.run(entry);
      });
      const rows: Array<Record<string, unknown>> = [];
      for (const [pathKey, raw] of Object.entries(parsed)) {
        const entry = sanitizePdfEntry(raw);
        if (!entry) continue;
        rows.push({
          path: pathKey,
          status: entry.status,
          attempts: entry.attempts,
          lastError: entry.lastError ?? null,
          lastAttemptAt: entry.lastAttemptAt,
          doneAt: entry.doneAt ?? null,
        });
      }
      tx(rows);
    }
    fs.renameSync(legacy, migrated);
    log.info('migrated pdf-status.json → state.db');
  } catch (err: unknown) {
    log.warn(`failed to migrate pdf-status.json: ${errorMessage(err)}`);
  }
}

function sanitizePdfEntry(v: unknown): PdfStatusEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const status = o.status;
  if (status !== 'in-flight' && status !== 'done' && status !== 'failed' && status !== 'cancelled') return null;
  return {
    status,
    attempts: typeof o.attempts === 'number' && Number.isFinite(o.attempts) ? o.attempts : 0,
    ...(typeof o.lastError === 'string' ? { lastError: o.lastError } : {}),
    lastAttemptAt: typeof o.lastAttemptAt === 'string' ? o.lastAttemptAt : new Date(0).toISOString(),
    ...(typeof o.doneAt === 'string' ? { doneAt: o.doneAt } : {}),
  };
}

export function readPdfStatusMap(): Record<string, PdfStatusEntry> {
  const rows = getStateDb().prepare(`
    SELECT path, status, attempts, last_error AS lastError,
           last_attempt_at AS lastAttemptAt, done_at AS doneAt
    FROM pdf_conversions
    ORDER BY path
  `).all() as Array<{ path: string } & PdfStatusEntry>;
  const out: Record<string, PdfStatusEntry> = {};
  for (const row of rows) {
    const { path: rowPath, ...entry } = row;
    out[rowPath] = {
      status: entry.status,
      attempts: entry.attempts,
      lastAttemptAt: entry.lastAttemptAt,
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(entry.doneAt ? { doneAt: entry.doneAt } : {}),
    };
  }
  return out;
}

export function getPdfStatus(pathKey: string): PdfStatusEntry | undefined {
  return readPdfStatusMap()[pathKey];
}

export function hasPdfStatus(pathKey: string): boolean {
  const row = getStateDb().prepare('SELECT 1 FROM pdf_conversions WHERE path = ?').get(pathKey);
  return row != null;
}

export function setPdfStatus(pathKey: string, status: PdfStatus, opts: { error?: string; incrementAttempts?: boolean } = {}): void {
  const prev = getPdfStatus(pathKey);
  const now = new Date().toISOString();
  getStateDb().prepare(`
    INSERT INTO pdf_conversions (path, status, attempts, last_error, last_attempt_at, done_at)
    VALUES (@path, @status, @attempts, @lastError, @lastAttemptAt, @doneAt)
    ON CONFLICT(path) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at,
      done_at = excluded.done_at
  `).run({
    path: pathKey,
    status,
    attempts: opts.incrementAttempts ? (prev?.attempts ?? 0) + 1 : (prev?.attempts ?? 1),
    lastError: opts.error ?? null,
    lastAttemptAt: now,
    doneAt: status === 'done' ? now : null,
  });
}

export function clearPdfStatus(pathKey: string): void {
  getStateDb().prepare('DELETE FROM pdf_conversions WHERE path = ?').run(pathKey);
}

export function listPdfStatus(status: PdfStatus): Array<{ path: string; entry: PdfStatusEntry }> {
  const rows = getStateDb().prepare(`
    SELECT path, status, attempts, last_error AS lastError,
           last_attempt_at AS lastAttemptAt, done_at AS doneAt
    FROM pdf_conversions
    WHERE status = ?
    ORDER BY path
  `).all(status) as Array<{ path: string } & PdfStatusEntry>;
  return rows.map((row) => ({
    path: row.path,
    entry: {
      status: row.status,
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.doneAt ? { doneAt: row.doneAt } : {}),
    },
  }));
}

/** Drop a deleted space's rows from `pdf_conversions`. Without this, a
 *  stale conversion record survives the space's deletion and makes
 *  `discoverNewSources` skip auto-conversion for a later same-named PDF /
 *  image (it sees a "record" and assumes it was already handled). `space`
 *  is the kbRoot-relative name (its rows are `space` itself or
 *  `space/...`); the `substr` prefix match avoids LIKE wildcard escaping
 *  on arbitrary space names. */
export function deleteSpaceState(space: string): void {
  const name = space.replace(/\/+$/, '');
  if (!name) return;
  const prefix = name + '/';
  getStateDb().prepare(
    'DELETE FROM pdf_conversions WHERE path = @name OR substr(path, 1, @plen) = @prefix',
  ).run({ name, prefix, plen: prefix.length });
}
