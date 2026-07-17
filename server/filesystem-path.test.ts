import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemPath, filesystemPath } from './filesystem-path.ts';

test('POSIX paths preserve case and root joins', () => {
  const paths = createFilesystemPath({ platform: 'posix', cwd: '/workspace' });
  assert.equal(paths.absolute('./Notes/../File.md'), '/workspace/File.md');
  assert.equal(paths.join('/', 'Folder/File.md'), '/Folder/File.md');
  assert.equal(paths.equal('/Data/File.md', '/Data/file.md'), false);
  assert.equal(paths.relative('/Data', '/Data/Folder/File.md'), 'Folder/File.md');
  assert.equal(paths.relative('/Data', '/Database/File.md'), null);
});

test('macOS identity follows the mounted volume case behaviour', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('requires a native macOS filesystem');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-darwin-path-'));
  const root = path.join(temp, 'MixedCaseRoot');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const alias = path.join(temp, 'mixedcaseroot');
  let sameEntry = false;
  try {
    const actualStat = fs.statSync(root);
    const aliasStat = fs.statSync(alias);
    sameEntry = actualStat.dev === aliasStat.dev && actualStat.ino === aliasStat.ino;
  } catch {
    // A case-sensitive APFS volume correctly keeps the identities distinct.
  }

  const paths = createFilesystemPath({ platform: 'darwin', cwd: temp });
  assert.equal(paths.equal(root, alias), sameEntry);
  assert.equal(paths.sameExistingPath(root, alias), sameEntry);
  assert.equal(
    paths.equal(path.join(root, 'Future.docx'), path.join(alias, 'future.docx')),
    sameEntry,
  );
  assert.equal(paths.contains(root, path.join(alias, 'future.docx')), sameEntry);
  assert.equal(
    paths.relative(root, path.join(alias, 'future.docx')),
    sameEntry ? 'future.docx' : null,
  );

  const composed = path.join(temp, 'Caf\u00e9');
  const decomposed = path.join(temp, 'Cafe\u0301');
  fs.mkdirSync(composed);
  let sameUnicodeEntry = false;
  try {
    const composedStat = fs.statSync(composed);
    const decomposedStat = fs.statSync(decomposed);
    sameUnicodeEntry = composedStat.dev === decomposedStat.dev && composedStat.ino === decomposedStat.ino;
  } catch {
    // Preserve distinct normalization forms when the mounted volume does.
  }
  assert.equal(paths.equal(composed, decomposed), sameUnicodeEntry);
});

test('existing path aliases do not collapse distinct hard links', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-alias-'));
  const source = path.join(temp, 'source.md');
  const hardLink = path.join(temp, 'hard-link.md');
  fs.writeFileSync(source, 'content');
  fs.linkSync(source, hardLink);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(filesystemPath.sameExistingPath(source, source), true);
  assert.equal(filesystemPath.sameExistingPath(source, hardLink), false);
});

test('Windows drive paths share one identity across separator and case variants', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(paths.absolute('c:\\Users\\Alice\\..\\ALICE\\File.docx'), 'c:/Users/ALICE/File.docx');
  assert.equal(paths.identity('C:\\Users\\Alice\\File.docx'), 'c:/users/alice/file.docx');
  assert.equal(paths.equal('C:/Users/Alice/File.docx', 'c:\\users\\alice\\FILE.docx'), true);
  assert.equal(paths.contains('C:/Users/Alice', 'c:\\users\\alice\\Notes\\File.md'), true);
  assert.equal(paths.contains('C:/Users/Alice', 'C:/Users/Alicev2/File.md'), false);
  assert.equal(paths.relative('C:/Users/Alice', 'c:\\users\\ALICE\\Notes\\File.md'), 'Notes/File.md');
  assert.equal(paths.join('C:/', 'Users/Alice'), 'C:/Users/Alice');
  assert.equal(paths.resolveUnder('C:\\Users\\Alice', 'Notes\\File.md'), 'C:/Users/Alice/Notes/File.md');
});

test('Windows existing resolution restores actual component spelling', (t) => {
  const originalReaddir = fs.readdirSync;
  const originalRealpath = fs.realpathSync.native;
  (fs.readdirSync as unknown as (cursor: string) => string[]) = ((cursor: string) => {
    const normalized = cursor.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'c:/users/alice') return ['Docs'];
    if (normalized === 'c:/users/alice/docs') return ['Report.docx'];
    return [];
  }) as typeof fs.readdirSync;
  fs.realpathSync.native = ((value: fs.PathLike) => String(value)) as typeof fs.realpathSync.native;
  t.after(() => {
    fs.readdirSync = originalReaddir;
    fs.realpathSync.native = originalRealpath;
  });

  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(
    paths.resolveUnder('C:/Users/Alice', 'docs/report.docx', { access: 'existing' }),
    'C:/Users/Alice/Docs/Report.docx',
  );
});

test('Windows UNC and extended-length spellings normalize without losing share roots', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.equal(paths.absolute('\\\\server\\share\\Folder'), '//server/share/Folder');
  assert.equal(paths.join('//server/share/', 'Folder/File.md'), '//server/share/Folder/File.md');
  assert.equal(paths.contains('//SERVER/SHARE', '\\\\server\\share\\folder\\file.md'), true);
  assert.equal(paths.relative('//server/share', '//SERVER/SHARE/Folder/File.md'), 'Folder/File.md');
  assert.equal(paths.absolute('\\\\?\\C:\\Users\\Alice'), 'C:/Users/Alice');
  assert.equal(paths.absolute('\\\\?\\UNC\\server\\share\\Folder'), '//server/share/Folder');
});

test('ambiguous Windows and escaping relative paths are rejected', () => {
  const paths = createFilesystemPath({ platform: 'win32', cwd: 'C:\\workspace' });
  assert.throws(() => paths.absolute('C:relative\\file.md'), /drive-relative/);
  assert.throws(() => paths.absolute('\\\\.\\PhysicalDrive0'), /device paths/);
  assert.throws(() => paths.absolute('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'), /namespace/);
  assert.throws(() => paths.absolute('\\\\?\\Volume{abc}\\Folder'), /namespace/);
  assert.throws(() => paths.join('C:/Root', '../escape.md'), /invalid path segment/);
  assert.throws(() => paths.join('C:/Root', 'D:/escape.md'), /relative/);
});

test('POSIX paths reject foreign Windows absolute drive syntax but keep valid colon names', () => {
  const paths = createFilesystemPath({ platform: 'posix', cwd: '/workspace' });
  assert.throws(() => paths.absolute('C:/Users/Alice/File.docx'), /Windows drive paths/);
  assert.throws(() => paths.absolute('C:\\Users\\Alice\\File.docx'), /Windows drive paths/);
  assert.equal(paths.absolute('A:notes.md'), '/workspace/A:notes.md');
});

test('resolveUnder blocks existing and creatable symlink or junction escapes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-path-'));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'linked-file.md'));
  }
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(
    filesystemPath.resolveUnder(root, 'inside.md', { access: 'existing' }),
    path.join(root, 'inside.md'),
  );
  assert.throws(
    () => filesystemPath.resolveUnder(root, 'link/outside.md', { access: 'existing' }),
    /escapes folder through symlink/,
  );
  assert.throws(
    () => filesystemPath.resolveUnder(root, 'link/new.md', { access: 'creatable' }),
    /escapes folder through symlink/,
  );
  if (process.platform !== 'win32') {
    assert.throws(
      () => filesystemPath.resolveUnder(root, 'linked-file.md', { access: 'creatable' }),
      /escapes folder through symlink/,
    );
  }
  assert.equal(
    filesystemPath.resolveUnder(root, 'new/child.md', { access: 'creatable' }),
    path.join(root, 'new', 'child.md'),
  );
  assert.equal(filesystemPath.real(path.join(root, 'link')), fs.realpathSync.native(outside));
});
