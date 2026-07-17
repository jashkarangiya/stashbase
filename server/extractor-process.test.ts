import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnOptionsForExtractor, terminateExtractorTree } from './extractor-process.ts';

const CHILD_SOURCE = 'setInterval(() => undefined, 1000)';
const PARENT_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  `const child = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD_SOURCE)}], { stdio: 'ignore' });`,
  "fs.writeFileSync(process.argv[1], String(child.pid));",
  'setInterval(() => undefined, 1000);',
].join('\n');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test('extractor cancellation terminates the descendant process tree', { timeout: 10_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-extractor-tree-'));
  const pidFile = path.join(tmp, 'child.pid');
  const parent = spawn(process.execPath, ['-e', PARENT_SOURCE, pidFile], spawnOptionsForExtractor());
  let childPid = 0;
  try {
    assert.equal(await waitUntil(() => fs.existsSync(pidFile), 3_000), true);
    childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(processExists(childPid), true);

    const parentClosed = new Promise<void>((resolve) => parent.once('close', () => resolve()));
    terminateExtractorTree(parent);
    await parentClosed;
    assert.equal(await waitUntil(() => !processExists(childPid), 3_000), true);
  } finally {
    if (parent.exitCode == null && parent.signalCode == null) {
      try { parent.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (childPid > 0 && processExists(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
