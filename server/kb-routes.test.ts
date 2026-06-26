import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stashbase-${label}-`));
}

const home = tmpDir('kb-routes-home');
process.env.HOME = home;
process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(home, 'app-data');

async function openKbRoot(label: string): Promise<void> {
  const { setKbRoot } = await import('./space.ts');
  const kbRoot = tmpDir(`${label}-kb`);
  fs.mkdirSync(path.join(kbRoot, 'Project'), { recursive: true });
  await setKbRoot(kbRoot, { allowNonEmpty: true });
}

test('normalizeKbSearchScope validates explicit space and kb-relative prefix', async () => {
  await openKbRoot('kb-search-scope');
  const { normalizeKbSearchScope } = await import('./routes/kb.ts');

  assert.deepEqual(
    normalizeKbSearchScope('Project', 'Project/docs'),
    { space: 'Project', pathPrefix: 'Project/docs' },
  );
  assert.deepEqual(
    normalizeKbSearchScope(undefined, 'Project/docs/'),
    { space: undefined, pathPrefix: 'Project/docs' },
  );
});

test('normalizeKbSearchScope rejects missing spaces and escaping prefixes', async () => {
  await openKbRoot('kb-search-invalid');
  const { normalizeKbSearchScope } = await import('./routes/kb.ts');

  assert.throws(
    () => normalizeKbSearchScope('Missing', undefined),
    /space not found/,
  );
  assert.throws(
    () => normalizeKbSearchScope(undefined, 'Missing/docs'),
    /space not found/,
  );
  assert.throws(
    () => normalizeKbSearchScope(undefined, '../Project'),
    /invalid segment/,
  );
  assert.throws(
    () => normalizeKbSearchScope(undefined, '/Project'),
    /kbRoot-relative POSIX path/,
  );
});

test('requireKbStatusSpace validates explicit status spaces', async () => {
  await openKbRoot('kb-status-space');
  const { requireKbStatusSpace } = await import('./routes/kb.ts');

  assert.equal(requireKbStatusSpace('Project'), 'Project');
  assert.equal(requireKbStatusSpace(undefined), undefined);
  assert.throws(
    () => requireKbStatusSpace('Missing'),
    /space not found/,
  );
});

test('KB file helpers perform CRUD with kbRoot-relative paths', async () => {
  await openKbRoot('kb-file-crud');
  const {
    deleteKbFile,
    editKbFile,
    listKbDirectory,
    moveKbFile,
    readKbFile,
    writeKbFile,
  } = await import('./routes/kb.ts');

  const written = await writeKbFile('Project/docs/hello.md', '# Hello\n\nfirst\n', {});
  assert.equal(written.path, 'Project/docs/hello.md');

  assert.deepEqual(
    (await listKbDirectory('')).entries.map((e) => ({ name: e.name, path: e.path, type: e.type })),
    [{ name: 'Project', path: 'Project', type: 'directory' }],
  );
  assert.deepEqual(
    (await listKbDirectory('Project')).entries.map((e) => ({ name: e.name, path: e.path, type: e.type })),
    [{ name: 'docs', path: 'Project/docs', type: 'directory' }],
  );

  const read = await readKbFile('Project/docs/hello.md');
  assert.equal(read.content, '# Hello\n\nfirst\n');
  assert.equal(read.format, 'md');
  assert.ok(read.version);
  const { getKbRoot } = await import('./space.ts');
  assert.equal(
    (await readKbFile(path.join(getKbRoot(), 'Project', 'docs', 'hello.md'))).content,
    '# Hello\n\nfirst\n',
  );

  const edited = await editKbFile('Project/docs/hello.md', 'first', 'second');
  assert.equal(edited.replacements, 1);
  assert.equal((await readKbFile('Project/docs/hello.md')).content, '# Hello\n\nsecond\n');

  const moved = await moveKbFile('Project/docs/hello.md', 'Project/notes/greeting.md');
  assert.equal(moved.oldPath, 'Project/docs/hello.md');
  assert.equal(moved.path, 'Project/notes/greeting.md');
  assert.equal((await readKbFile('Project/notes/greeting.md')).content, '# Hello\n\nsecond\n');

  const deleted = await deleteKbFile('Project/notes/greeting.md');
  assert.equal(deleted.alreadyGone, false);
  await assert.rejects(
    () => readKbFile('Project/notes/greeting.md'),
    /not found/,
  );
});

test('agentContextFile prefers extracted Markdown for PDF and image sources', async () => {
  await openKbRoot('kb-agent-context-derived');
  const { getKbRoot } = await import('./space.ts');
  const root = getKbRoot();
  fs.writeFileSync(path.join(root, 'Project', 'paper.pdf'), '%PDF-1.7\n');
  fs.writeFileSync(path.join(root, 'Project', '.paper.pdf.md'), '# Extracted paper\n');
  fs.writeFileSync(path.join(root, 'Project', 'shot.png'), 'not really a png');
  fs.writeFileSync(path.join(root, 'Project', '.shot.png.md'), '# OCR text\n');
  const { agentContextFile } = await import('./routes/kb.ts');

  assert.deepEqual(
    await agentContextFile('Project/paper.pdf'),
    {
      path: 'Project/paper.pdf',
      space: 'Project',
      sourcePath: 'paper.pdf',
      readPath: '.paper.pdf.md',
      kind: 'derived',
      sourceFormat: 'pdf',
      available: true,
      reason: 'Read the extracted Markdown/OCR note first for this pdf; use the original only when raw visual or binary detail is needed.',
    },
  );
  assert.deepEqual(
    await agentContextFile('Project/shot.png'),
    {
      path: 'Project/shot.png',
      space: 'Project',
      sourcePath: 'shot.png',
      readPath: '.shot.png.md',
      kind: 'derived',
      sourceFormat: 'image',
      available: true,
      reason: 'Read the extracted Markdown/OCR note first for this image; use the original only when raw visual or binary detail is needed.',
    },
  );
});

test('agentContextFile returns direct paths for structured files and missing conversions', async () => {
  await openKbRoot('kb-agent-context-direct');
  const { getKbRoot } = await import('./space.ts');
  const root = getKbRoot();
  fs.writeFileSync(path.join(root, 'Project', 'note.md'), '# Note\n');
  fs.writeFileSync(path.join(root, 'Project', 'unread.pdf'), '%PDF-1.7\n');
  const { agentContextFile } = await import('./routes/kb.ts');

  assert.deepEqual(
    await agentContextFile('Project/note.md'),
    {
      path: 'Project/note.md',
      space: 'Project',
      sourcePath: 'note.md',
      readPath: 'note.md',
      kind: 'direct',
      sourceFormat: 'md',
      available: true,
      reason: 'Structured text files are the readable source.',
    },
  );
  assert.deepEqual(
    await agentContextFile('Project/unread.pdf'),
    {
      path: 'Project/unread.pdf',
      space: 'Project',
      sourcePath: 'unread.pdf',
      readPath: 'unread.pdf',
      kind: 'direct',
      sourceFormat: 'pdf',
      available: false,
      reason: 'No extracted Markdown exists yet for this pdf; retry after conversion if you need text context.',
    },
  );
});

test('KB file helpers reject host paths, hidden derived notes, and cross-space moves', async () => {
  await openKbRoot('kb-file-invalid');
  fs.mkdirSync(path.join((await import('./space.ts')).getKbRoot(), 'Other'), { recursive: true });
  const { deleteKbFile, moveKbFile, readKbFile, writeKbFile } = await import('./routes/kb.ts');

  await assert.rejects(
    () => readKbFile('/Users/me/Documents/StashBase/Project/a.md'),
    /absolute path must live under kb_root/,
  );
  await assert.rejects(
    () => writeKbFile('Project/.paper.pdf.md', 'hidden'),
    /derived notes are hidden/,
  );
  await writeKbFile('Project/a.md', 'hello');
  await assert.rejects(
    () => moveKbFile('Project/a.md', 'Other/a.md'),
    /same space only/,
  );
  assert.deepEqual(await deleteKbFile('Project/a.md'), { path: 'Project/a.md', alreadyGone: false });
});
