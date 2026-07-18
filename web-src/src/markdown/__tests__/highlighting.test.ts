import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown, renderMarkdownInline } from '../../markdown.ts';

/** The preview CSS in <head> names .hljs-* selectors, so "no highlighting
 *  happened" assertions must look at the rendered body only. */
function bodyOf(document: string): string {
  return document.slice(document.indexOf('<body>'));
}

test('labelled common-language fenced code is highlighted with static spans', () => {
  const document = renderMarkdown('```ts\nconst answer = 42;\n```');

  assert.match(document, /<pre><code class="language-ts">/);
  assert.match(document, /<span class="hljs-keyword">const<\/span>/);
  assert.match(document, /<span class="hljs-number">42<\/span>/);
  assert.doesNotMatch(document, /<script/i);
});

test('unknown language labels fall back to plain escaped code', () => {
  const body = bodyOf(renderMarkdown('```notalanguage\na < b && c > d\n```'));

  assert.match(body, /<pre><code class="language-notalanguage">a &lt; b &amp;&amp; c &gt; d\n<\/code><\/pre>/);
  assert.doesNotMatch(body, /hljs-/);
});

test('unlabelled fenced and indented code stays plain escaped code', () => {
  const body = bodyOf(renderMarkdown('```\n<b>not html</b>\n```\n\n    indented <i>code</i>'));

  assert.match(body, /<pre><code>&lt;b&gt;not html&lt;\/b&gt;\n<\/code><\/pre>/);
  assert.match(body, /<pre><code>indented &lt;i&gt;code&lt;\/i&gt;\n<\/code><\/pre>/);
  assert.doesNotMatch(body, /hljs-/);
});

test('highlighted markup cannot smuggle live HTML past the sanitizer', () => {
  const document = renderMarkdown('```html\n<img src=x onerror=alert(1)><script>alert(1)</script>\n```');

  assert.doesNotMatch(document, /<script/);
  assert.doesNotMatch(document, /<img\s/);
  assert.match(document, /&lt;\/?/);
});

test('hostile language labels never throw and stay escaped', () => {
  assert.doesNotThrow(() => renderMarkdown('```"><script>alert(1)</script>\ncode\n```'));

  const document = renderMarkdown('```"><script>alert(1)</script>\ncode\n```');
  assert.doesNotMatch(document, /<script/);
});

test('raw-HTML span classes outside the highlight vocabulary are stripped', () => {
  const document = renderMarkdown('<span class="hljs-keyword evil" onclick="alert(1)">x</span>');

  assert.match(document, /<span class="hljs-keyword">x<\/span>/);
  assert.doesNotMatch(document, /evil/);
  assert.doesNotMatch(document, /onclick/);
});

test('inline Agent-message rendering is not highlighted', () => {
  const inline = renderMarkdownInline('```ts\nconst answer = 42;\n```');

  assert.doesNotMatch(inline, /hljs-/);
  assert.match(inline, /<pre><code class="language-ts">/);
});
