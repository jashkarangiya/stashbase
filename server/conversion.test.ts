import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeStateDb } from './state-db.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('stale final output is invalidated synchronously when conversion is queued', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-conversion-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  try {
    const { maybeConvert } = await import('./conversion.ts');
    const source = path.join(root, 'report.docx');
    const derived = path.join(root, 'report.html');
    const runGate = deferred();
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(derived, 'stale derived output');
    fs.utimesSync(derived, new Date(1_000), new Date(1_000));
    fs.utimesSync(source, new Date(2_000), new Date(2_000));

    const completion = maybeConvert(source, {
      kind: 'test_extract',
      lane: 'light',
      cost: 0,
      matches: (name: string) => name.endsWith('.docx'),
      derivedNote: () => derived,
      convert: async () => {
        await runGate.promise;
        fs.writeFileSync(derived, '<p>fresh searchable text</p>');
      },
      cleanupDerived: () => fs.rmSync(derived, { force: true }),
    });

    assert.ok(completion);
    assert.equal(fs.existsSync(derived), false);
    runGate.resolve();
    await completion;
    assert.equal(fs.readFileSync(derived, 'utf8'), '<p>fresh searchable text</p>');
  } finally {
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem-root folder paths retain one separator', async () => {
  const { runWithFolderRoot, toSourcePath } = await import('./folder.ts');
  const { filesystemPath } = await import('./filesystem-path.ts');
  const filesystemRoot = path.parse(process.cwd()).root;
  const child = path.resolve(filesystemRoot, 'nested', 'report.docx');
  assert.equal(filesystemPath.relative(filesystemRoot, child), 'nested/report.docx');
  assert.equal(filesystemPath.join(filesystemRoot, 'nested/report.docx'), filesystemPath.absolute(child));
  await runWithFolderRoot(filesystemRoot, () => {
    assert.equal(toSourcePath('nested/report.docx'), filesystemPath.absolute(child));
  });
  if (process.platform === 'win32') {
    assert.equal(filesystemPath.equal(child, filesystemPath.absolute(child).toUpperCase()), true);
  }
});

test('running conversions protect file operations while queued work stays usable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-file-guard-'));
  const previousDataRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(root, 'data');
  const source = path.join(root, 'report.docx');
  const secondSource = path.join(root, 'second.docx');
  const queuedSource = path.join(root, 'queued.docx');
  const gate = deferred();
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(secondSource, 'source');
  fs.writeFileSync(queuedSource, 'source');
  try {
    const { cancelConversion, getScheduledConversion, maybeConvert } = await import('./conversion.ts');
    const { runWithFolderRoot } = await import('./folder.ts');
    const { filesystemPath } = await import('./filesystem-path.ts');
    const { inFlightFileOperationError } = await import('./routes/files.ts');
    const spec = {
      kind: 'guard_test',
      lane: 'light',
      cost: 0,
      matches: (name: string) => name.endsWith('.docx'),
      derivedNote: (absPath: string) => `${absPath}.html`,
      convert: async (absPath: string) => {
        await gate.promise;
        fs.writeFileSync(`${absPath}.html`, '<p>done</p>');
      },
      cleanupDerived: (absPath: string) => fs.rmSync(`${absPath}.html`, { force: true }),
    } as const;
    const completion = maybeConvert(source, spec);
    const secondCompletion = maybeConvert(secondSource, spec);
    const queuedCompletion = maybeConvert(queuedSource, spec);
    assert.ok(completion);
    assert.ok(secondCompletion);
    assert.ok(queuedCompletion);
    for (let attempt = 0; attempt < 10 && getScheduledConversion(source)?.state !== 'running'; attempt += 1) {
      await tick();
    }
    assert.equal(getScheduledConversion(source)?.state, 'running');
    assert.equal(getScheduledConversion(queuedSource)?.state, 'queued');
    if (process.platform === 'win32') {
      assert.equal(filesystemPath.canonicalRelative(root, 'REPORT.DOCX'), 'report.docx');
    }
    await runWithFolderRoot(root, () => {
      assert.equal(inFlightFileOperationError('report.docx', 'rename')?.body.code, 'CONVERSION_IN_FLIGHT');
      assert.equal(inFlightFileOperationError('report.docx', 'delete')?.body.code, 'CONVERSION_IN_FLIGHT');
      assert.equal(inFlightFileOperationError('queued.docx', 'rename'), null);
      assert.equal(inFlightFileOperationError('queued.docx', 'delete'), null);
    });
    cancelConversion(source);
    cancelConversion(secondSource);
    cancelConversion(queuedSource);
    gate.resolve();
    await Promise.all([completion, secondCompletion, queuedCompletion]);
  } finally {
    gate.resolve();
    closeStateDb();
    if (previousDataRoot == null) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
