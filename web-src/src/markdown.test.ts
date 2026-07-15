import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown, renderMarkdownInline } from './markdown.ts';

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
  assert.match(document, /<pre><code class="language-ts">const answer = 42;\n<\/code><\/pre>/);
  assert.match(document, /<pre><code>indented code\n<\/code><\/pre>/);
});

test('document headings have deterministic duplicate-safe Unicode anchors', () => {
  const document = renderMarkdown('# Café 世界\n\n# Café 世界\n\n# !!!\n\n# !!!');

  assert.match(document, /<h1 id="café-世界">Café 世界<\/h1>/);
  assert.match(document, /<h1 id="café-世界-1">Café 世界<\/h1>/);
  assert.match(document, /<h1 id="section">!!!<\/h1>/);
  assert.match(document, /<h1 id="section-1">!!!<\/h1>/);
});

test('document heading anchors avoid collisions with generated suffixes', () => {
  const document = renderMarkdown('# Foo\n\n# Foo-1\n\n# Foo');

  assert.match(document, /<h1 id="foo">Foo<\/h1>/);
  assert.match(document, /<h1 id="foo-1">Foo-1<\/h1>/);
  assert.match(document, /<h1 id="foo-2">Foo<\/h1>/);
});

test('document renderer removes executable and navigation-breaking HTML', () => {
  const document = renderMarkdown(`
<script>alert('script')</script>
<style>body { display: none }</style>
<iframe src="https://example.com"></iframe>
<object data="https://example.com/payload"></object>
<embed src="https://example.com/payload">
<base href="https://example.com/">
<meta http-equiv="refresh" content="0;url=https://example.com">
<form action="https://example.com"><button type="submit">Leave</button></form>
<a href="javascript:alert('link')" target="_top" onclick="alert('click')">unsafe link</a>
<a href="file:///etc/passwd">unsafe file</a>
<p style="position:fixed" onmouseover="alert('hover')">styled text</p>
<img src="javascript:alert('image')" onerror="alert('image error')">
<img src="data:text/html,<script>alert('data')</script>">
<img src="blob:https://example.com/unsafe">
`);

  const body = document.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  assert.doesNotMatch(body, /<(?:script|style|iframe|object|embed|base|form|button)\b/i);
  assert.doesNotMatch(body, /<meta\b[^>]*http-equiv/i);
  assert.doesNotMatch(body, /\s(?:onerror|onclick|onmouseover|style|target)=/i);
  assert.doesNotMatch(body, /(?:javascript:|file:|data:|blob:)/i);
  assert.match(body, />unsafe link<\/a>/);
  assert.match(body, />unsafe file<\/a>/);
  assert.match(body, /<img\s*\/>|<img>/);
});

test('document renderer preserves ordinary HTML and safe URLs', () => {
  const document = renderMarkdown(`
# Document

| Name | Value |
| --- | --- |
| One | Two |

<details open><summary>More</summary><p>Use <kbd>Cmd</kbd> + <mark>K</mark>, H<sub>2</sub>O, and x<sup>2</sup>.</p></details>

[Relative note](other.md#section)

![Relative image](images/example.png)

- [x] Complete
`);

  assert.match(document, /<h1 id="document">Document<\/h1>/);
  assert.match(document, /<table>/);
  assert.match(document, /<details open(?:="")?><summary>More<\/summary>/);
  assert.match(document, /<kbd>Cmd<\/kbd>/);
  assert.match(document, /<mark>K<\/mark>/);
  assert.match(document, /H<sub>2<\/sub>O/);
  assert.match(document, /x<sup>2<\/sup>/);
  assert.match(document, /href="other\.md#section"/);
  assert.match(document, /src="images\/example\.png"/);
});
