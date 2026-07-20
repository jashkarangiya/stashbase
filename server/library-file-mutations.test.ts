import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-library-mutations-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const {
  clearCurrentFolder,
  getCurrentFolder,
  setCurrentFolder,
} = await import('./folder.ts');
const {
  deleteLibraryFile,
  editLibraryFile,
  moveLibraryFile,
  writeLibraryFile,
} = await import('./library-file-mutations.ts');

test('library file mutations work outside an active folder and enforce versions', async (t) => {
  t.after(() => {
    clearCurrentFolder();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  const root = path.join(testHome, 'Library Folder');
  const source = path.join(root, 'Drafts', 'Note.md');
  const target = path.join(root, 'Archive', 'Note.md');
  fs.mkdirSync(root, { recursive: true });

  setCurrentFolder(root);
  clearCurrentFolder();
  assert.equal(getCurrentFolder(), null);

  const created = await writeLibraryFile(source, 'version one');
  assert.ok(created.version);
  assert.equal(fs.readFileSync(source, 'utf8'), 'version one');
  assert.equal(getCurrentFolder(), null);

  const updated = await writeLibraryFile(source, 'version two', { baseVersion: created.version });
  assert.ok(updated.version);
  await assert.rejects(
    writeLibraryFile(source, 'stale writer', { baseVersion: created.version }),
    (error: Error & { code?: string }) => error.code === 'FILE_CHANGED',
  );

  const edited = await editLibraryFile(source, 'version two', 'version three', {
    baseVersion: updated.version,
  });
  assert.equal(edited.replacements, 1);
  assert.equal(fs.readFileSync(source, 'utf8'), 'version three');

  const moved = await moveLibraryFile(source, target);
  assert.equal(moved.linksUpdated, 0);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'version three');

  const deleted = await deleteLibraryFile(target);
  assert.equal(deleted.alreadyGone, false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(getCurrentFolder(), null);
});
