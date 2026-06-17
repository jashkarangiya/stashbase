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

export function kbLocalDataDir(kbRoot: string): string {
  const resolved = canonicalKbRoot(kbRoot);
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'kb';
  return path.join(appDataRoot(), 'kb', `${base}-${hash}`);
}

function canonicalKbRoot(kbRoot: string): string {
  const resolved = path.resolve(kbRoot);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function stateDbPathForKb(kbRoot: string): string {
  return path.join(kbLocalDataDir(kbRoot), 'state', 'state.db');
}

export function vectorStoreDirForKb(kbRoot: string): string {
  return path.join(kbLocalDataDir(kbRoot), 'vector-store');
}
