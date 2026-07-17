import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFolderRelativePath } from './folder-relative-path.ts';

test('folder-relative paths share one separator and traversal policy', () => {
  assert.equal(normalizeFolderRelativePath('Folder\\nested//File.md'), 'Folder/nested/File.md');
  assert.throws(() => normalizeFolderRelativePath('/absolute/File.md'), /relative/);
  assert.throws(() => normalizeFolderRelativePath('C:\\absolute\\File.md'), /relative/);
  assert.throws(() => normalizeFolderRelativePath('Folder/../File.md'), /invalid segment/);
  assert.throws(() => normalizeFolderRelativePath('Folder/\u0000File.md'), /invalid characters/);
});

test('writable folder-relative paths share one protected-segment policy', () => {
  assert.equal(
    normalizeFolderRelativePath('Folder/File.md', { writable: true }),
    'Folder/File.md',
  );
  assert.throws(
    () => normalizeFolderRelativePath('.stashbase/state.db', { writable: true }),
    /cannot write into \.stashbase/,
  );
  assert.throws(
    () => normalizeFolderRelativePath('node_modules/file.md', { writable: true }),
    /excluded directory "node_modules"/,
  );
  assert.throws(
    () => normalizeFolderRelativePath('pending.icloud', { writable: true }),
    /iCloud placeholder/,
  );
  assert.equal(
    normalizeFolderRelativePath("Imported/John's Notes.pdf", { writable: true, allowQuotes: true }),
    "Imported/John's Notes.pdf",
  );
  assert.equal(
    normalizeFolderRelativePath("Imported/John's Notes.pdf", { allowQuotes: true }),
    "Imported/John's Notes.pdf",
  );
  assert.throws(() => normalizeFolderRelativePath("John's Notes.md"), /invalid characters/);
});
