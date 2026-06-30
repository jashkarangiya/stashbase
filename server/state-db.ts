/**
 * Library-level transactional state in the per-machine app data directory.
 *
 * This is StashBase-owned state, separate from MFS/Milvus' `store/`
 * schema. It holds exactly one thing: failed PDF / image conversion
 * status, which is non-derivable — a failed conversion looks identical
 * on disk to one that hasn't run — and drives the per-file Retry banner.
 *
 * Everything else lives at its authoritative source: the daemon/store
 * owns the per-file hash + index state (via `scan_diff`), the filesystem
 * answers "does this file exist", and `~/.stashbase/config.json` holds
 * library folders and embedder config. (Earlier `files` and `index_queue`
 * tables duplicated daemon/reconcile state write-only and were removed.)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';
import { getFolderHome } from './folder.ts';
import { appStateDbPath, stateDbPathForRoot } from './local-data.ts';

const log = logger('state-db');

export type ConversionStatus = 'in-flight' | 'done' | 'failed' | 'cancelled';

export interface ConversionStatusEntry {
  status: ConversionStatus;
  attempts: number;
  lastError?: string;
  lastAttemptAt: string;
  doneAt?: string;
}

let db: Database.Database | null = null;
let dbPath: string | null = null;

function stateDbPath(): string {
  return appStateDbPath();
}

function getStateDb(): Database.Database {
  const target = stateDbPath();
  if (db && dbPath === target) return db;
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  migrateLegacyStateDb(target);
  db = new Database(target);
  dbPath = target;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  migrateLegacyStateDbRows(db);
  migrateLegacyStatusJson(db);
  return db;
}

function legacyFolderStateDbPath(): string {
  return path.join(getFolderHome(), '.stashbase', 'state.db');
}

function legacyStateDbPaths(): string[] {
  const target = path.resolve(stateDbPath());
  const candidates = [
    stateDbPathForRoot(getFolderHome()),
    legacyFolderStateDbPath(),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved === target || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(candidate);
  }
  return out;
}

function migrateLegacyStateDb(target: string): void {
  if (fs.existsSync(target)) return;
  const legacy = legacyStateDbPaths().find((candidate) => fs.existsSync(candidate));
  if (!legacy) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const suffixes = ['', '-wal', '-shm'].filter((suffix) => fs.existsSync(legacy + suffix));
  const nonce = `${process.pid}.${Date.now()}`;
  const temps = suffixes.map((suffix) => ({ suffix, path: `${target}${suffix}.${nonce}.tmp` }));
  const installed: string[] = [];
  try {
    for (const { suffix, path: tmp } of temps) {
      fs.copyFileSync(legacy + suffix, tmp);
    }
    for (const { suffix, path: tmp } of temps) {
      const to = target + suffix;
      fs.renameSync(tmp, to);
      installed.push(to);
    }
    for (const suffix of suffixes) {
      try { fs.unlinkSync(legacy + suffix); } catch { /* keep retry-safe source cleanup best-effort */ }
    }
    log.info(`migrated legacy state.db → ${target}`);
  } catch (err: unknown) {
    for (const { path: tmp } of temps) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    for (const file of installed) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    log.warn(`failed to migrate legacy state db ${legacy}: ${errorMessage(err)}`);
  }
}

export function closeStateDb(): void {
  if (!db) return;
  try { db.close(); } catch { /* ignore */ }
  db = null;
  dbPath = null;
}

function migrate(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS conversions (
      path TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('in-flight', 'done', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT NOT NULL,
      done_at TEXT
    );

    CREATE INDEX IF NOT EXISTS conversions_status_idx ON conversions(status, last_attempt_at);

    -- 2026-06: only failures are persisted now. in-flight lives in
    -- process memory (a crash kills the conversion with us — persisting
    -- it only produced corpses needing a reclaim pass), and "done" is
    -- recorded by the derived note's existence on disk. Shed legacy rows.
    DELETE FROM conversions WHERE status != 'failed';

    -- Drop legacy tables on open so existing installs shed dead schema:
    --   'pdf_conversions'  → renamed to 'conversions' (covers PDF + image
    --        alike; the old name predated image OCR sharing the table).
    --        Its rows are ephemeral conversion status — dropping them just
    --        makes reconcile re-trigger any untracked source, so no
    --        migration is needed.
    --   'files' (per-file index/hash) and 'index_queue' (op queue) — both
    --        were write-only: the daemon/store owns the authoritative
    --        per-file hash (via scan_diff) and reconcile recovers
    --        idempotently, so nothing consumed them.
    -- 'conversions' is the only state.db data that is non-derivable and
    -- actually read.
    DROP TABLE IF EXISTS pdf_conversions;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS index_queue;
  `);
}

function migrateLegacyStateDbRows(conn: Database.Database): void {
  for (const legacy of legacyStateDbPaths()) migrateLegacyStateDbRowsFrom(conn, legacy);
}

function migrateLegacyStateDbRowsFrom(conn: Database.Database, legacy: string): void {
  if (!fs.existsSync(legacy)) return;
  let attached = false;
  try {
    conn.prepare('ATTACH DATABASE ? AS legacy_state').run(legacy);
    attached = true;
    const hasConversions = conn.prepare(`
      SELECT 1 AS ok
      FROM legacy_state.sqlite_master
      WHERE type = 'table' AND name = 'conversions'
      LIMIT 1
    `).get();
    if (hasConversions) {
      conn.exec(`
        INSERT INTO conversions (path, status, attempts, last_error, last_attempt_at, done_at)
        SELECT path, status, attempts, last_error, last_attempt_at, done_at
        FROM legacy_state.conversions
        WHERE status = 'failed'
        ON CONFLICT(path) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          last_error = excluded.last_error,
          last_attempt_at = excluded.last_attempt_at,
          done_at = excluded.done_at;
      `);
    }
    conn.prepare('DETACH DATABASE legacy_state').run();
    attached = false;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(legacy + suffix); } catch { /* best-effort */ }
    }
    log.info(`merged legacy state.db rows from ${legacy}`);
  } catch (err: unknown) {
    if (attached) {
      try { conn.prepare('DETACH DATABASE legacy_state').run(); } catch { /* best-effort */ }
    }
    log.warn(`failed to merge legacy state db rows from ${legacy}: ${errorMessage(err)}`);
  }
}

function migrateLegacyStatusJson(conn: Database.Database): void {
  const legacy = path.join(getFolderHome(), '.stashbase', 'pdf-status.json');
  const migrated = legacy + '.migrated';
  if (!fs.existsSync(legacy) || fs.existsSync(migrated)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const upsert = conn.prepare(`
        INSERT INTO conversions (path, status, attempts, last_error, last_attempt_at, done_at)
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
        const entry = sanitizeConversionEntry(raw);
        if (!entry) continue;
        // Only failures survive process restarts. Legacy in-flight rows
        // are corpse state (the child process died with us), and done is
        // represented by the derived note already being on disk.
        if (entry.status !== 'failed') continue;
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

function sanitizeConversionEntry(v: unknown): ConversionStatusEntry | null {
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

export function readConversionStatusMap(): Record<string, ConversionStatusEntry> {
  const rows = getStateDb().prepare(`
    SELECT path, status, attempts, last_error AS lastError,
           last_attempt_at AS lastAttemptAt, done_at AS doneAt
    FROM conversions
    ORDER BY path
  `).all() as Array<{ path: string } & ConversionStatusEntry>;
  const out: Record<string, ConversionStatusEntry> = {};
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

export function getConversionStatus(pathKey: string): ConversionStatusEntry | undefined {
  return readConversionStatusMap()[pathKey];
}


export function setConversionStatus(pathKey: string, status: ConversionStatus, opts: { error?: string; incrementAttempts?: boolean } = {}): void {
  const prev = getConversionStatus(pathKey);
  const now = new Date().toISOString();
  getStateDb().prepare(`
    INSERT INTO conversions (path, status, attempts, last_error, last_attempt_at, done_at)
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

export function clearConversionStatus(pathKey: string): void {
  getStateDb().prepare('DELETE FROM conversions WHERE path = ?').run(pathKey);
}

export function clearConversionStatusUnder(pathKey: string): void {
  const name = pathKey.replace(/\/+$/, '');
  if (!name) return;
  const prefix = name + '/';
  getStateDb().prepare(
    'DELETE FROM conversions WHERE path = @name OR substr(path, 1, @plen) = @prefix',
  ).run({ name, prefix, plen: prefix.length });
}

export function listConversionStatus(status: ConversionStatus): Array<{ path: string; entry: ConversionStatusEntry }> {
  const rows = getStateDb().prepare(`
    SELECT path, status, attempts, last_error AS lastError,
           last_attempt_at AS lastAttemptAt, done_at AS doneAt
    FROM conversions
    WHERE status = ?
    ORDER BY path
  `).all(status) as Array<{ path: string } & ConversionStatusEntry>;
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
