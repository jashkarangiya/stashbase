/**
 * KB-level transactional state in `<kbRoot>/.stashbase/state.db`.
 *
 * This is StashBase-owned state, separate from MFS/Milvus' `store/`
 * schema. The tables here track file reconcile facts, PDF conversion
 * status, and the indexing queue boundary that needs atomic updates and
 * field-level queries.
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

export interface FileStateRow {
  path: string;
  mtime: number;
  size: number;
  contentHash: string;
  lastIndexedAt?: string;
  status: 'indexed' | 'pending' | 'failed' | 'deleted';
  lastError?: string;
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
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime REAL NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '',
      last_indexed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('indexed', 'pending', 'failed', 'deleted')),
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS pdf_conversions (
      path TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('in-flight', 'done', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT NOT NULL,
      done_at TEXT
    );

    CREATE TABLE IF NOT EXISTS index_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      op TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in-progress', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS index_queue_status_idx ON index_queue(status, updated_at);
    CREATE INDEX IF NOT EXISTS files_status_idx ON files(status);
    CREATE INDEX IF NOT EXISTS pdf_conversions_status_idx ON pdf_conversions(status, last_attempt_at);
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

export function markFilePending(pathKey: string): void {
  upsertFileState(pathKey, { status: 'pending' });
}

export function markFileIndexed(pathKey: string, stat: { mtime: number; size: number }, contentHash: string): void {
  upsertFileState(pathKey, {
    status: 'indexed',
    mtime: stat.mtime,
    size: stat.size,
    contentHash,
    lastIndexedAt: new Date().toISOString(),
  });
}

export function markFileDeleted(pathKey: string): void {
  upsertFileState(pathKey, { status: 'deleted' });
}

export function markFileFailed(pathKey: string, error: string): void {
  upsertFileState(pathKey, { status: 'failed', lastError: error });
}

function upsertFileState(
  pathKey: string,
  patch: Partial<Omit<FileStateRow, 'path'>>,
): void {
  const prev = getStateDb().prepare('SELECT * FROM files WHERE path = ?').get(pathKey) as any;
  getStateDb().prepare(`
    INSERT INTO files (path, mtime, size, content_hash, last_indexed_at, status, last_error)
    VALUES (@path, @mtime, @size, @contentHash, @lastIndexedAt, @status, @lastError)
    ON CONFLICT(path) DO UPDATE SET
      mtime = excluded.mtime,
      size = excluded.size,
      content_hash = excluded.content_hash,
      last_indexed_at = excluded.last_indexed_at,
      status = excluded.status,
      last_error = excluded.last_error
  `).run({
    path: pathKey,
    mtime: patch.mtime ?? prev?.mtime ?? 0,
    size: patch.size ?? prev?.size ?? 0,
    contentHash: patch.contentHash ?? prev?.content_hash ?? '',
    lastIndexedAt: patch.lastIndexedAt ?? prev?.last_indexed_at ?? null,
    status: patch.status ?? prev?.status ?? 'pending',
    lastError: patch.lastError ?? null,
  });
}

export function enqueueIndexOp(pathKey: string, op: string): number {
  const now = new Date().toISOString();
  const res = getStateDb().prepare(`
    INSERT INTO index_queue (path, op, status, updated_at)
    VALUES (?, ?, 'pending', ?)
  `).run(pathKey, op, now);
  return Number(res.lastInsertRowid);
}

export function updateIndexOp(id: number, status: 'in-progress' | 'done' | 'failed', error?: string): void {
  getStateDb().prepare(`
    UPDATE index_queue
    SET status = ?, attempts = attempts + CASE WHEN ? = 'in-progress' THEN 1 ELSE 0 END,
        last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(status, status, error ?? null, new Date().toISOString(), id);
}
