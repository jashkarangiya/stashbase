import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { errorCode, errorMessage, logger } from './log.ts';
import { isImageFile, matchNoteStem, NOTE_EXTS } from './format.ts';
import { filesystemPath } from './filesystem-path.ts';
import { renameAbsPreservingCase, resolveSafe } from './file-paths.ts';

const log = logger('files');

export function saveText(relPath: string, content: string): void {
  saveBytes(relPath, Buffer.from(content, 'utf8'));
}

export function fileVersion(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Cheap cache/reload identity for binary viewers. Text write conflicts use
 * the content hash above; binary previews only need a token that changes when
 * the filesystem object or its bytes are replaced. */
export function fileStatVersion(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try {
    const st = fs.statSync(target, { bigint: true });
    if (!st.isFile()) return null;
    return `stat:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return null;
  }
}

/** Write raw bytes (e.g. images / css / fonts that arrive alongside
 *  an HTML bundle on drag-import). Same atomic write-then-rename as
 *  saveText so partial writes don't leave a half-baked file in the
 *  folder. */
export function saveBytes(relPath: string, bytes: Buffer): void {
  const target = resolveSafe(relPath, 'creatable');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  resolveSafe(relPath, 'creatable');
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Exclusive-create variant: returns false if the file already exists
 *  (POSIX O_EXCL via `wx` flag). Used by `+ new file` so concurrent
 *  clicks can't race-pick the same `untitled-N.md`. Creates intermediate
 *  directories if needed. */
export function createTextExclusive(relPath: string, content: string): boolean {
  const target = resolveSafe(relPath, 'creatable');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  resolveSafe(relPath, 'creatable');
  try {
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
}

/** Atomic in-place rename / move. Same FS only. Creates the target's
 *  parent dirs as needed (moving across folders works). */
export function renameOnDisk(oldRel: string, newRel: string): void {
  const o = resolveSafe(oldRel);
  const n = resolveSafe(newRel, 'creatable', 'target file');
  if (!fs.existsSync(o) || !fs.statSync(o).isFile()) {
    throw new Error('source file not found');
  }
  resolveSafe(oldRel, 'existing', 'source file');
  if (fs.existsSync(n) && !filesystemPath.sameExistingPath(o, n)) {
    throw new Error('target already exists');
  }
  fs.mkdirSync(path.dirname(n), { recursive: true });
  resolveSafe(newRel, 'creatable', 'target file');
  renameAbsPreservingCase(o, n);
  renameBundleSibling(oldRel, newRel);
  if (/\.pdf$/i.test(oldRel) || isImageFile(oldRel)) {
    renameDerivedArtifactsForSource(oldRel, newRel);
  }
}

/** Resolve a folder-relative path to an absolute filesystem path for
 *  asset serving (images, css, fonts referenced from an HTML iframe).
 *  Returns null if the path resolves outside the folder, doesn't exist,
 *  or isn't a regular file. Safe to pass to `fs.createReadStream`. */
export function resolveAsset(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
  } catch { return null; }
  return target;
}

export function readText(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try {
    return fs.readFileSync(target, 'utf8');
  } catch { return null; }
}

/** True if a file or directory exists at the folder-relative path. */
export function pathExists(relPath: string): boolean {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return false; }
  try { fs.statSync(target); return true; } catch { return false; }
}

/** Resolve to an absolute path if anything exists at the folder-relative
 *  location (file OR directory). Used by the reveal-in-OS route, which
 *  needs to accept both files and folders. */
export function resolveExisting(relPath: string): string | null {
  let target: string;
  try { target = resolveSafe(relPath, 'existing'); } catch { return null; }
  try { fs.statSync(target); return target; } catch { return null; }
}

/** Delete a file at the given folder-relative path. Returns false only
 *  when the file genuinely isn't there (ENOENT). */
export function deleteFile(relPath: string): boolean {
  const target = resolveSafe(relPath);
  let removed = false;
  try {
    if (!fs.existsSync(target)) return false;
    resolveSafe(relPath, 'existing', 'file');
    fs.unlinkSync(target);
    removed = true;
  } catch (err: any) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }
  if (removed) {
    deleteBundleSibling(relPath);
    if (/\.pdf$/i.test(relPath) || isImageFile(relPath)) deleteDerivedArtifactsForSource(relPath);
  }
  return removed;
}

/** Map a note's folder-relative path to its `<stem>_files/` sibling
 *  bundle dir. Returns null when the path isn't a recognised note. */
function bundleDirSibling(noteRel: string): string | null {
  const m = matchNoteStem(path.posix.basename(noteRel));
  if (!m) return null;
  const dir = path.posix.dirname(noteRel);
  const bundle = `${m.stem}_files`;
  return dir === '.' ? bundle : `${dir}/${bundle}`;
}

function renameBundleSibling(oldNoteRel: string, newNoteRel: string): void {
  const oldBundle = bundleDirSibling(oldNoteRel);
  const newBundle = bundleDirSibling(newNoteRel);
  if (!oldBundle || !newBundle || oldBundle === newBundle) return;
  let oldAbs: string;
  let newAbs: string;
  try {
    oldAbs = resolveSafe(oldBundle, 'existing');
    newAbs = resolveSafe(newBundle, 'creatable');
  }
  catch { return; }
  try {
    if (!fs.statSync(oldAbs).isDirectory()) return;
  } catch { return; }
  if (fs.existsSync(newAbs) && !filesystemPath.sameExistingPath(oldAbs, newAbs)) return;
  renameAbsPreservingCase(oldAbs, newAbs);
}

function deleteBundleSibling(noteRel: string): void {
  const bundle = bundleDirSibling(noteRel);
  if (!bundle) return;
  let abs: string;
  try { abs = resolveSafe(bundle); } catch { return; }
  try {
    if (fs.statSync(abs).isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch { /* no bundle — fine */ }
}

export interface DerivedArtifacts {
  notes: string[];
  bundles: string[];
}

/** Legacy sibling-derived artifacts for a PDF/image/DOCX source. Current
 *  derived text lives in AppData (`derived-store.ts`); these names are kept
 *  only to clean up older on-disk artifacts and stale index rows. */
export function derivedArtifactsForSource(relPath: string): DerivedArtifacts {
  const base = path.posix.basename(relPath);
  const parent = path.posix.dirname(relPath);
  const join = (name: string) => (parent === '.' ? name : `${parent}/${name}`);
  const notes: string[] = [];
  const bundles: string[] = [];
  const addNote = (name: string) => {
    if (!notes.includes(name)) notes.push(name);
  };
  const addBundle = (name: string) => {
    if (!bundles.includes(name)) bundles.push(name);
  };

  if (/\.pdf$/i.test(base)) {
    const stem = base.replace(/\.pdf$/i, '');
    for (const sourceBase of [base, stem]) {
      if (!sourceBase) continue;
      for (const ext of NOTE_EXTS) addNote(join(`.${sourceBase}.${ext}`));
      addBundle(join(`.${sourceBase}_files`));
    }
  } else if (isImageFile(base)) {
    const stem = base.replace(/\.[^.]+$/, '');
    for (const sourceBase of [base, stem]) {
      if (!sourceBase) continue;
      addNote(join(`.${sourceBase}.md`));
      addNote(join(`.${sourceBase}.markdown`));
    }
  }

  return { notes, bundles };
}

/** Tear down a source file's legacy app-derived siblings. Best-effort: missing
 *  artifacts are fine, but permission/IO failures are logged so hidden
 *  stale conversion output is diagnosable. */
function deleteDerivedArtifactsForSource(sourceRel: string): void {
  const artifacts = derivedArtifactsForSource(sourceRel);
  for (const rel of artifacts.notes) {
    let abs: string;
    try { abs = resolveSafe(rel); } catch { continue; }
    try { fs.unlinkSync(abs); } catch (err: any) {
      if (errorCode(err) !== 'ENOENT') {
        log.warn(`failed to unlink derived ${rel}: ${errorMessage(err)}`);
      }
    }
  }
  for (const rel of artifacts.bundles) {
    let abs: string;
    try { abs = resolveSafe(rel); } catch { continue; }
    try {
      if (fs.statSync(abs).isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch { /* no bundle — fine */ }
  }
  deleteDerivedScratchBundlesForSource(sourceRel);
}

function renameDerivedArtifactsForSource(oldSourceRel: string, newSourceRel: string): void {
  const oldArtifacts = derivedArtifactsForSource(oldSourceRel);
  const newArtifacts = derivedArtifactsForSource(newSourceRel);
  renameFirstExistingArtifact(oldArtifacts.notes, newArtifacts.notes[0], 'file');
  renameFirstExistingArtifact(oldArtifacts.bundles, newArtifacts.bundles[0], 'dir');
}

function renameFirstExistingArtifact(oldRels: string[], newRel: string | undefined, kind: 'file' | 'dir'): void {
  let moved = false;
  for (const oldRel of oldRels) {
    let oldAbs: string;
    try { oldAbs = resolveSafe(oldRel); } catch { continue; }
    if (!fs.existsSync(oldAbs)) continue;
    if (!moved && newRel) {
      let newAbs: string;
      try { newAbs = resolveSafe(newRel); } catch { continue; }
      try {
        fs.mkdirSync(path.dirname(newAbs), { recursive: true });
        fs.rmSync(newAbs, { recursive: kind === 'dir', force: true });
        fs.renameSync(oldAbs, newAbs);
        moved = true;
        continue;
      } catch (err: unknown) {
        log.warn(`failed to rename derived ${oldRel} -> ${newRel}: ${errorMessage(err)}`);
      }
    }
    try {
      fs.rmSync(oldAbs, { recursive: kind === 'dir', force: true });
    } catch (err: unknown) {
      log.warn(`failed to remove stale derived ${oldRel}: ${errorMessage(err)}`);
    }
  }
}

/** Create a (possibly nested) folder inside the folder. Returns false if
 *  the folder already exists, throws on other errors. */
export function createFolder(relPath: string): boolean {
  const target = resolveSafe(relPath, 'creatable', 'folder', { writable: true });
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(target, { recursive: true });
  resolveSafe(relPath, 'existing', 'folder', { writable: true });
  return true;
}

/** Rename a folder in place. The PATCH route handles the index
 *  update separately (see Indexer.renamePathPrefix); this function
 *  only moves the directory on disk. Refuses to overwrite an existing
 *  target. */
export function renameFolder(oldRel: string, newRel: string): void {
  const oldAbs = resolveSafe(oldRel);
  const newAbs = resolveSafe(newRel, 'creatable', 'target folder');
  if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isDirectory()) {
    throw new Error('source folder not found');
  }
  resolveSafe(oldRel, 'existing', 'source folder');
  if (fs.existsSync(newAbs) && !filesystemPath.sameExistingPath(oldAbs, newAbs)) {
    throw new Error('target already exists');
  }
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  resolveSafe(newRel, 'creatable', 'target folder');
  renameAbsPreservingCase(oldAbs, newAbs);
}

/** Delete a folder and everything inside it (recursively). The route
 *  layer already prompts the user for confirmation before calling
 *  this, so the confirmation guard lives in the UI. */
export function deleteFolder(relPath: string): boolean {
  let target: string;
  try { target = resolveSafe(relPath); } catch { return false; }
  try {
    if (!fs.existsSync(target)) return false;
    resolveSafe(relPath, 'existing', 'folder');
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err: any) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function deleteDerivedScratchBundlesForSource(sourceRel: string): void {
  const base = path.posix.basename(sourceRel);
  if (!/\.pdf$/i.test(base)) return;
  const stem = base.replace(/\.pdf$/i, '');
  const sourceNames = [base, stem].filter(Boolean).map(escapeRegExp).join('|');
  const scratchRe = new RegExp(
    `^(?:\\.{1,2}(?:${sourceNames})_files\\.(?:tmp|batch)-.*|\\.${escapeRegExp(base)}\\.md\\.tmp-.*|\\.${escapeRegExp(base)}\\.md\\.batches)$`,
    'i',
  );
  let parentAbs: string;
  try { parentAbs = path.dirname(resolveSafe(sourceRel)); } catch { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parentAbs, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!scratchRe.test(ent.name)) continue;
    try {
      fs.rmSync(path.join(parentAbs, ent.name), { recursive: ent.isDirectory(), force: true });
    } catch (err: unknown) {
      log.warn(`failed to remove stale derived scratch ${ent.name}: ${errorMessage(err)}`);
    }
  }
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
