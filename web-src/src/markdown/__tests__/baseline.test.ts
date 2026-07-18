import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown, renderMarkdownInline } from '../../markdown.ts';

test('document soft breaks collapse while inline soft breaks remain visible', () => {
  const document = renderMarkdown('first line\nsecond line');
  const inline = renderMarkdownInline('first line\nsecond line');

  assert.match(document, /<p>first line\nsecond line<\/p>/);
  assert.doesNotMatch(document, /<br\s*\/?\s*>/);
  assert.match(inline, /first line<br>second line/);
});

test('document hard-break syntax creates line breaks', () => {
  const document = renderMarkdown('spaces  \nbackslash\\\nnext');

  assert.match(document, /<p>spaces<br\s*\/>backslash<br\s*\/>next<\/p>/);
});

test('document renderer preserves the GFM block baseline', () => {
  const document = renderMarkdown([
    '- item',
    '- [x] done',
    '',
    '| Left | Right |',
    '| --- | --- |',
    '| one | two |',
  ].join('\n'));

  assert.match(document, /<ul>[\s\S]*<li>item<\/li>/);
  const checkbox = document.match(/<input\b[^>]*>/)?.[0] ?? '';
  assert.match(checkbox, /\btype="checkbox"/);
  assert.match(checkbox, /\bchecked(?:="")?/);
  assert.match(checkbox, /\bdisabled(?:="")?/);
  assert.match(document, /\/?> done/);
  assert.match(document, /<table>[\s\S]*<th>Left<\/th>[\s\S]*<td>two<\/td>/);
});

test('document renderer preserves links, images, escapes, entities, and code', () => {
  const document = renderMarkdown([
    '[link](https://example.com) ![alt](image.png) \\*literal\\* &amp; `inline`',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '    indented code',
  ].join('\n'));

  assert.match(document, /<a href="https:\/\/example\.com">link<\/a>/);
  assert.match(document, /<img src="image\.png" alt="alt"\s*\/>/);
  assert.match(document, /\*literal\* &amp; <code>inline<\/code>/);
  // `language-ts` is a registered common language, so the block now
  // carries static Highlight.js spans; content and structure still hold.
  assert.match(document, /<pre><code class="language-ts">[\s\S]*?const[\s\S]*?42[\s\S]*?;\n<\/code><\/pre>/);
  assert.match(document, /<pre><code>indented code\n<\/code><\/pre>/);
});

test('document headings have deterministic duplicate-safe GitHub anchors', () => {
  const document = renderMarkdown('# Café 世界\n\n# Café 世界\n\n# Release notes!\n\n# Release notes!');

  assert.match(document, /<h1 id="café-世界">Café 世界<\/h1>/);
  assert.match(document, /<h1 id="café-世界-1">Café 世界<\/h1>/);
  assert.match(document, /<h1 id="release-notes">Release notes!<\/h1>/);
  assert.match(document, /<h1 id="release-notes-1">Release notes!<\/h1>/);
});

test('document heading anchors avoid collisions with generated suffixes', () => {
  const document = renderMarkdown('# Foo\n\n# Foo-1\n\n# Foo');

  assert.match(document, /<h1 id="foo">Foo<\/h1>/);
  assert.match(document, /<h1 id="foo-1">Foo-1<\/h1>/);
  assert.match(document, /<h1 id="foo-2">Foo<\/h1>/);
});

test('raw HTML and Markdown headings share one duplicate-safe ID registry', () => {
  const document = renderMarkdown('<h1 id="raw-heading">Raw Heading</h1>\n\n# Raw Heading\n\n<h1 id="foo-1">Foo</h1>\n\n# Foo\n\n# Foo');

  assert.equal(document.match(/id="raw-heading"/g)?.length, 1);
  assert.match(document, /<h1 id="raw-heading-1">Raw Heading<\/h1>/);
  assert.equal(document.match(/id="foo-1"/g)?.length, 1);
  assert.match(document, /<h1 id="foo">Foo<\/h1>/);
  assert.match(document, /<h1 id="foo-2">Foo<\/h1>/);
});

test('raw heading IDs cannot collide with package footnote targets', () => {
  const document = renderMarkdown('<section class="footnotes" data-footnotes><h2 id="footnote:label" class="sr-only">Raw Heading</h2></section>\n\nText[^note].\n\n[^note]: Detail.');

  assert.match(document, /<h2 id="raw-heading" class="sr-only">Raw Heading<\/h2>/);
  assert.match(document, /aria-describedby="footnote:label"/);
  assert.equal(document.match(/id="footnote:label"/g)?.length, 1);
});
