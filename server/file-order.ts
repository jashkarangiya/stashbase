/**
 * Per-folder manual sidebar ordering.
 *
 * Source: app-local data keyed by folder root — a map from
 *   parent path (folder-relative, `""` = root)
 * to
 *   ordered list of child basenames (files OR folders).
 *
 * Only parents the user has explicitly rearranged appear in the file.
 * For other parents the renderer falls back to the default sort
 * (folders-first + alphabetical). Invalid/corrupt entries are dropped
 * on read; rename/delete routes keep valid order entries in lockstep
 * with disk mutations so a manually-arranged sidebar survives reloads.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger, errorMessage, errorCode } from './log.ts';
import { getFolderHome, requireCurrentFolder, toPosixAbs } from './folder.ts';
import { fileOrderDir, localDataDirForRoot } from './local-data.ts';

const log = logger('file-order');

export type FileOrderMap = Record<string, string[]>;

function orderFileName(root: string): string {
  const abs = toPosixAbs(root);
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16);
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
  return `${base}-${hash}.json`;
}

function configPath(root: string): string {
  return path.join(fileOrderDir(), orderFileName(root));
}

function legacyAppDataConfigPath(root: string): string {
  return path.join(localDataDirForRoot(getFolderHome()), 'file-order', orderFileName(root));
}

function legacyConfigPath(root: string): string {
  return path.join(root, '.stashbase', 'file-order.json');
}

/** Read the full map. Returns `{}` if the file doesn't exist or is
 *  corrupt — never throws, since the sidebar must still render. */
export function readFileOrder(): FileOrderMap {
  let root: string;
  try { root = requireCurrentFolder(); } catch { return {}; }
  try {
    const raw = readOrderFile(root);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FileOrderMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string') continue;
      if (!Array.isArray(v)) continue;
      let parent: string;
      try { parent = normalizeParentPath(k); } catch { continue; }
      const names = uniqueNames(v.filter((s): s is string => typeof s === 'string')
        .map((s) => {
          try { return normalizeChildName(s); } catch { return null; }
        })
        .filter((s): s is string => s != null));
      if (names.length === 0) continue;
      out[parent] = names;
    }
    return out;
  } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn(`failed to read file-order.json: ${errorMessage(err)}`);
    }
    return {};
  }
}

function readOrderFile(root: string): string {
  const current = configPath(root);
  try {
    return fs.readFileSync(current, 'utf8');
  } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }

  for (const legacy of [legacyAppDataConfigPath(root), legacyConfigPath(root)]) {
    let raw: string;
    try {
      raw = fs.readFileSync(legacy, 'utf8');
    } catch (err: any) {
      if (errorCode(err) === 'ENOENT') continue;
      throw err;
    }
    try {
      writeOrderMap(root, sanitizeRawOrder(raw));
      fs.rmSync(legacy, { force: true });
    } catch (err) {
      log.warn(`failed to migrate legacy file-order.json: ${errorMessage(err)}`);
    }
    return raw;
  }

  throw Object.assign(new Error('file order not found'), { code: 'ENOENT' });
}

function sanitizeRawOrder(raw: string): FileOrderMap {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: FileOrderMap = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof k !== 'string' || !Array.isArray(v)) continue;
    try {
      out[normalizeParentPath(k)] = uniqueNames(
        v.filter((s): s is string => typeof s === 'string').map(normalizeChildName),
      );
    } catch {
      // Drop invalid legacy entries.
    }
  }
  return cleanMap(out);
}

/** Replace one parent's ordered list. Drops the entry entirely when
 *  `names` is empty (avoids accumulating stale keys). Atomic write
 *  via `.tmp` + rename. */
export function setFolderOrder(parentPath: string, names: string[]): void {
  const root = requireCurrentFolder();
  const map = readFileOrder();
  const parent = normalizeParentPath(parentPath);
  const cleanNames = uniqueNames(names.map(normalizeChildName));
  if (cleanNames.length === 0) {
    delete map[parent];
  } else {
    map[parent] = cleanNames;
  }
  writeOrderMap(root, map);
}

export function deleteFileOrderForRoot(root: string): void {
  try { fs.rmSync(configPath(root), { force: true }); } catch { /* best effort */ }
  try { fs.rmSync(legacyAppDataConfigPath(root), { force: true }); } catch { /* best effort */ }
}

export function remapFileOrderPath(oldRel: string, newRel: string, kind: 'file' | 'folder'): void {
  const root = requireCurrentFolder();
  const oldPath = normalizeEntryPath(oldRel);
  const newPath = normalizeEntryPath(newRel);
  if (oldPath === newPath) return;
  const map = readFileOrder();
  const next: FileOrderMap = {};
  let changed = false;

  for (const [parent, names] of Object.entries(map)) {
    const remappedParent = kind === 'folder' ? remapPath(parent, oldPath, newPath) : parent;
    const existing = next[remappedParent] ?? [];
    next[remappedParent] = uniqueNames([...existing, ...names]);
    if (remappedParent !== parent) changed = true;
  }

  const oldSplit = splitPath(oldPath);
  const newSplit = splitPath(newPath);
  const oldList = next[oldSplit.parent] ?? [];
  const oldIdx = oldList.indexOf(oldSplit.base);
  if (oldIdx >= 0) {
    const replacement = oldSplit.parent === newSplit.parent ? newSplit.base : null;
    next[oldSplit.parent] = replaceOrRemove(oldList, oldSplit.base, replacement);
    changed = true;
    if (oldSplit.parent !== newSplit.parent) {
      const target = next[newSplit.parent] ?? [];
      if (!target.includes(newSplit.base)) {
        next[newSplit.parent] = [...target, newSplit.base];
      }
    }
  }

  const cleaned = cleanMap(next);
  if (changed || JSON.stringify(cleaned) !== JSON.stringify(map)) writeOrderMap(root, cleaned);
}

export function removeFileOrderPath(relPath: string, kind: 'file' | 'folder'): void {
  const root = requireCurrentFolder();
  const target = normalizeEntryPath(relPath);
  const targetSplit = splitPath(target);
  const map = readFileOrder();
  const next: FileOrderMap = {};
  let changed = false;

  for (const [parent, names] of Object.entries(map)) {
    if (kind === 'folder' && (parent === target || parent.startsWith(target + '/'))) {
      changed = true;
      continue;
    }
    const without = parent === targetSplit.parent
      ? names.filter((n) => n !== targetSplit.base)
      : names;
    if (without.length !== names.length) changed = true;
    next[parent] = without;
  }

  const cleaned = cleanMap(next);
  if (changed || JSON.stringify(cleaned) !== JSON.stringify(map)) writeOrderMap(root, cleaned);
}

function writeOrderMap(root: string, map: FileOrderMap): void {
  const cleaned = cleanMap(map);
  const target = configPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

function normalizeParentPath(value: string): string {
  if (typeof value !== 'string') throw new Error('parent path required');
  if (value === '') return '';
  return normalizeEntryPath(value);
}

function normalizeEntryPath(value: string): string {
  if (typeof value !== 'string') throw new Error('path required');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    throw new Error('path must be folder-relative POSIX path');
  }
  const norm = value.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!norm) throw new Error('empty path');
  if (/[\x00-\x1f'"]/.test(norm)) throw new Error('invalid path (control chars / quotes not allowed)');
  for (const seg of norm.split('/')) normalizeChildName(seg);
  return norm;
}

function normalizeChildName(value: string): string {
  if (typeof value !== 'string') throw new Error('child name required');
  const name = value.normalize('NFC');
  if (!name || name.includes('/') || name.includes('\\')) throw new Error('invalid child name');
  if (/[\x00-\x1f'"]/.test(name)) throw new Error('invalid child name');
  if (name === '.' || name === '..') throw new Error('invalid child name');
  return name;
}

function splitPath(relPath: string): { parent: string; base: string } {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? { parent: '', base: relPath } : { parent: relPath.slice(0, i), base: relPath.slice(i + 1) };
}

function remapPath(pathValue: string, from: string, to: string): string {
  if (!pathValue) return pathValue;
  if (pathValue === from) return to;
  if (pathValue.startsWith(from + '/')) return to + pathValue.slice(from.length);
  return pathValue;
}

function replaceOrRemove(names: string[], oldName: string, newName: string | null): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (name === oldName) {
      if (newName && !out.includes(newName)) out.push(newName);
    } else if (!out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

function cleanMap(map: FileOrderMap): FileOrderMap {
  const out: FileOrderMap = {};
  for (const [parentRaw, namesRaw] of Object.entries(map)) {
    let parent: string;
    try { parent = normalizeParentPath(parentRaw); } catch { continue; }
    const names = uniqueNames(namesRaw.map((name) => {
      try { return normalizeChildName(name); } catch { return null; }
    }).filter((name): name is string => name != null));
    if (names.length) out[parent] = names;
  }
  return out;
}
