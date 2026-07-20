import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { matchesSearchTypes, searchExtensionsForTypes } from './format.ts';
import {
  hasWholeTokenBoundaries,
  normalizeRipgrepSubmatches,
  resolveSpawnableRipgrepPath,
  snippetForLine,
} from './keyword-search.ts';

test('ripgrep byte offsets map to UTF-16 ranges for multibyte text', () => {
  const line = '前缀 alpha 结果';
  const start = Buffer.byteLength('前缀 ', 'utf8');
  const end = start + Buffer.byteLength('alpha', 'utf8');

  assert.deepEqual(normalizeRipgrepSubmatches(line, [{ start, end }]), [[3, 8]]);
});

test('whole-token matching treats CJK letters and underscores as word chars', () => {
  assert.equal(hasWholeTokenBoundaries('alpha beta', 0, 5), true);
  assert.equal(hasWholeTokenBoundaries('prealpha beta', 3, 8), false);
  assert.equal(hasWholeTokenBoundaries('alpha_beta', 0, 5), false);
  assert.equal(hasWholeTokenBoundaries('中文结果', 0, 2), false);
});

test('keyword snippets keep highlighted ranges inside the visible window', () => {
  const line = `${'a'.repeat(260)}MATCH${'b'.repeat(260)}`;
  const snippet = snippetForLine(line, [[260, 265]]);

  assert.ok(snippet.text.startsWith('…'));
  assert.ok(snippet.text.endsWith('…'));
  assert.equal(snippet.text.slice(snippet.ranges[0][0], snippet.ranges[0][1]), 'MATCH');
});

test('packaged ripgrep path prefers app.asar.unpacked when present', () => {
  const candidate = path.join('/tmp', 'App.app', 'Contents', 'Resources', 'app.asar', 'node_modules', 'rg');

  assert.equal(resolveSpawnableRipgrepPath(candidate), candidate);
});

test('search type categories map to source extensions', () => {
  assert.deepEqual(searchExtensionsForTypes(['pdf']), ['.pdf']);
  assert.deepEqual(searchExtensionsForTypes(['notes']), ['.md', '.markdown', '.html', '.htm']);
  assert.deepEqual(searchExtensionsForTypes(['docx', 'docx']), ['.docx']);
  assert.equal(searchExtensionsForTypes([]), null);
  assert.equal(searchExtensionsForTypes(['notes', 'pdf', 'image', 'docx']), null);
});

test('type membership checks extensions case-insensitively', () => {
  assert.equal(matchesSearchTypes('a/Report.PDF', ['pdf']), true);
  assert.equal(matchesSearchTypes('a/report.pdf', ['notes']), false);
  assert.equal(matchesSearchTypes('shot.jpeg', ['image']), true);
  assert.equal(matchesSearchTypes('doc.docx', ['pdf', 'docx']), true);
  assert.equal(matchesSearchTypes('note.md', []), true);
});
