import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown, renderMarkdownInline } from '../../markdown.ts';

test('document renderer keeps marked-footnote navigation and screen-reader markup through sanitization', () => {
  const document = renderMarkdown([
    'A documented claim.[^source]',
    '',
    '[^source]: **Primary** source.',
  ].join('\n'));

  assert.match(
    document,
    /<sup><a id="footnote:ref-source" href="#footnote:source" data-footnote:ref aria-describedby="footnote:label">1<\/a><\/sup>/,
  );
  assert.match(document, /<section class="footnotes" data-footnotes>/);
  assert.match(document, /<h2 id="footnote:label" class="sr-only">Footnotes<\/h2>/);
  assert.match(document, /<li id="footnote:source">\s*<p><strong>Primary<\/strong> source\./);
  assert.match(
    document,
    /<a href="#footnote:ref-source" data-footnote:backref aria-label="Back to reference source">↩<\/a>/,
  );
  assert.doesNotMatch(document, /\[\^source\]/);
});

test('document footnotes support indented continuation blocks', () => {
  const document = renderMarkdown([
    'Claim.[^details]',
    '',
    '[^details]: First paragraph.',
    '',
    '    Second paragraph with `code`.',
  ].join('\n'));

  assert.match(
    document,
    /<li id="footnote:details">\s*<p>First paragraph.<\/p>\s*<p>Second paragraph with <code>code<\/code>\./,
  );
  assert.doesNotMatch(document, /<pre><code>Second paragraph/);
});

test('document footnotes parse CRLF and CR source consistently', () => {
  for (const newline of ['\r\n', '\r']) {
    const document = renderMarkdown(`Claim.[^note]${newline}${newline}[^note]: Detail.${newline}`);

    assert.match(document, /href="#footnote:note" id="footnote:ref-note"|id="footnote:ref-note" href="#footnote:note"/);
    assert.match(document, /<li id="footnote:note">\s*<p>Detail\./);
  }
});

test('repeated footnote references have unique backlinks and one footnote body', () => {
  const document = renderMarkdown([
    'First[^same] and second[^same].',
    '',
    '[^same]: Shared note.',
  ].join('\n'));

  assert.match(document, /id="footnote:ref-same" href="#footnote:same"/);
  assert.match(document, /id="footnote:ref-same-2" href="#footnote:same"/);
  assert.equal(document.match(/<li id="footnote:same">/g)?.length, 1);
  assert.match(document, /href="#footnote:ref-same" data-footnote:backref/);
  assert.match(document, /href="#footnote:ref-same-2" data-footnote:backref/);
});

test('footnote entry IDs cannot collide with generated heading IDs', () => {
  const document = renderMarkdown([
    '# Footnote note',
    '',
    'Text[^note].',
    '',
    '[^note]: Detail.',
  ].join('\n'));

  assert.match(document, /<h1 id="footnote-note">Footnote note<\/h1>/);
  assert.match(document, /href="#footnote:note" id="footnote:ref-note"|id="footnote:ref-note" href="#footnote:note"/);
  assert.match(document, /<li id="footnote:note">\s*<p>Detail\./);
  assert.equal(document.match(/id="footnote-note"/g)?.length, 1);
});

test('malformed, undefined, code, and fenced footnotes remain literal', () => {
  const document = renderMarkdown([
    'Undefined[^missing], malformed [^], and `code[^code]`.',
    '',
    '```md',
    'fenced[^fence]',
    '[^fence]: Not a definition.',
    '```',
  ].join('\n'));

  assert.match(document, /Undefined\[\^missing\], malformed \[\^\], and <code>code\[\^code\]<\/code>/);
  // `md` is a highlighted common language, so the fenced block may carry
  // static token spans; the footnote text must survive literally once
  // markup is ignored, and must never become a live definition.
  const fencedText = document.slice(document.indexOf('<body>')).replace(/<[^>]+>/g, '');
  assert.match(fencedText, /fenced\[\^fence\]/);
  assert.match(fencedText, /\[\^fence\]: Not a definition\./);
  assert.doesNotMatch(document, /data-footnotes/);
});

test('document sanitization preserves marked-footnote attributes', () => {
  const document = renderMarkdown([
    '<a class="unrelated" href="https://example.com">Link</a>',
    '<section class="unrelated">Section</section>',
    '',
    'Text[^note].',
    '',
    '[^note]: Detail.',
  ].join('\n'));

  assert.doesNotMatch(document, /class="unrelated"/);
  assert.match(document, /<a id="footnote:ref-note" href="#footnote:note" data-footnote:ref/);
  assert.match(document, /<section class="footnotes" data-footnotes>/);
});

test('footnote parsing is isolated from inline rendering', () => {
  const inline = renderMarkdownInline('Inline[^note]\n\n[^note]: Keep literal.');

  assert.match(inline, /Inline\[\^note\]/);
  assert.match(inline, /\[\^note\]: Keep literal\./);
  assert.doesNotMatch(inline, /data-footnote:/);
});

test('footnote references and backlinks have preview-local readable focus styles', () => {
  const document = renderMarkdown('Text[^note].\n\n[^note]: Detail.');

  assert.match(document, /\[data-footnote\\:ref\]:focus-visible,\s*\[data-footnote\\:backref\]:focus-visible \{/);
  assert.match(document, /outline: 2px solid #0e7490/);
});
