import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWithFolderRoot } from './folder.ts';
import {
  createFolder,
  deleteFile,
  isSameExistingPath,
  readText,
  renameFolder,
  renameOnDisk,
  saveText,
  sanitizeFilename,
} from './files.ts';

test('renameOnDisk supports case-only file renames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-case-rename-'));
  try {
    fs.writeFileSync(path.join(root, 'note.md'), 'hello');

    await runWithFolderRoot(root, async () => {
      const targetExistsBeforeRename = fs.existsSync(path.join(root, 'Note.md'));
      if (targetExistsBeforeRename) {
        assert.equal(isSameExistingPath('note.md', 'Note.md'), true);
      }

      renameOnDisk('note.md', 'Note.md');
    });

    assert.deepEqual(fs.readdirSync(root), ['Note.md']);
    assert.equal(fs.readFileSync(path.join(root, 'Note.md'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renameFolder supports case-only folder renames', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-case-folder-'));
  try {
    fs.mkdirSync(path.join(root, 'folder'));
    fs.writeFileSync(path.join(root, 'folder', 'note.md'), 'hello');

    await runWithFolderRoot(root, () => renameFolder('folder', 'Folder'));

    assert.deepEqual(fs.readdirSync(root), ['Folder']);
    assert.equal(fs.readFileSync(path.join(root, 'Folder', 'note.md'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quoted imported filenames remain readable, writable, and deletable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-quoted-file-'));
  try {
    const name = "John's Notes.md";
    fs.writeFileSync(path.join(root, name), 'hello');

    await runWithFolderRoot(root, () => {
      assert.equal(readText(name), 'hello');
      saveText(name, 'updated');
      assert.equal(readText(name), 'updated');
      assert.equal(deleteFile(name), true);
      assert.equal(readText(name), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createFolder applies writable protected-segment policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-create-folder-'));
  try {
    await runWithFolderRoot(root, () => {
      assert.equal(createFolder('Projects'), true);
      assert.equal(fs.statSync(path.join(root, 'Projects')).isDirectory(), true);
      assert.throws(() => createFolder('.stashbase/state'), /cannot write into \.stashbase/);
      assert.throws(() => createFolder('node_modules/pkg'), /excluded directory "node_modules"/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeFilename keeps folder creation names portable', () => {
  assert.equal(sanitizeFilename('Research:2026/Question?A'), 'Research-2026/Question-A');
});
