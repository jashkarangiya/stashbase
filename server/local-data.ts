import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'StashBase';

export function appDataRoot(): string {
  if (process.env.STASHBASE_LOCAL_DATA_ROOT?.trim()) {
    return path.resolve(process.env.STASHBASE_LOCAL_DATA_ROOT.trim());
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_NAME);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), APP_NAME);
}

export function localDataDirForRoot(root: string): string {
  const resolved = canonicalRoot(root);
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
  return path.join(appDataRoot(), 'folders', `${base}-${hash}`);
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Legacy per-root state DB path. Current conversion state is app-level
 *  (`appStateDbPath`); this remains only so old installs can migrate. */
export function stateDbPathForRoot(root: string): string {
  return path.join(localDataDirForRoot(root), 'state', 'state.db');
}

export function appStateDbPath(): string {
  return path.join(appDataRoot(), 'state', 'state.db');
}

export function fileOrderDir(): string {
  return path.join(appDataRoot(), 'file-order');
}

/** The single global vector store for the whole app. The daemon holds one
 *  Milvus collection here; every opened folder is indexed into it, keyed by
 *  absolute path. `.nosync` keeps iCloud off the WAL files even though this
 *  lives under Application Support (which isn't iCloud-synced) — the suffix
 *  is a cheap per-machine guard that travels with the convention. */
export function globalVectorStoreDir(): string {
  return path.join(appDataRoot(), 'vector-store.nosync');
}
