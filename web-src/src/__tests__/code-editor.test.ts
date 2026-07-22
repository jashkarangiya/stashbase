import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { search } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { applyEditorQuery, followLiveMarkdownLink, liveHeadingPosition } from '../components/CodeEditor.tsx';
import { renderMarkdown } from '../markdown.ts';
import {
  describeLiveMarkdownProjection,
  hiddenMarkdownMarkupRanges,
  isLiveMarkdownComposition,
  liveMarkdownCompositionGuard,
  setLiveMarkdownComposition,
  shouldRefreshLiveMarkdownProjection,
  toggleMarkdownEmphasis,
  toggleMarkdownLink,
  toggleMarkdownStrong,
} from '../components/liveMarkdown.ts';

test('restoring an open find query preserves a saved editor selection', () => {
  let state = EditorState.create({
    doc: 'needle alpha needle',
    extensions: [search()],
  });
  state = state.update({ selection: { anchor: 12 } }).state;
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;

  const result = applyEditorQuery(view, 'needle', false, false, false);

  assert.equal(state.selection.main.anchor, 12);
  assert.deepEqual(result, { current: 0, total: 2 });
});

function markdownState(doc: string, selection?: { anchor: number; head?: number }) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage }), history()],
  });
  // The production projection is intentionally viewport-bounded and can wait
  // for a background parse. These complete-document assertions need a stable
  // parsed tree instead of racing that background work.
  ensureSyntaxTree(state, state.doc.length, 1_000);
  return state;
}

function testView(state: EditorState) {
  let current = state;
  return {
    get state() { return current; },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
}

test('Live Editing and Reading View share the supported Markdown construct subset', () => {
  const doc = [
    '# ATX heading',
    '',
    '## Second-level ATX heading',
    '',
    '### Third-level ATX heading',
    '',
    '#### Fourth-level ATX heading',
    '',
    '##### Fifth-level ATX heading',
    '',
    '###### Sixth-level ATX heading',
    '',
    'Setext level one heading',
    '===',
    '',
    'Setext level two heading',
    '---',
    '',
    '*emphasis* **strong** ~~strikethrough~~ `inline code`',
    '',
    '---',
    '',
    '```ts',
    'const value = 42;',
    '```',
    '',
  ].join('\n');

  const projectedKinds = new Set(
    describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }))
      .map((construct) => construct.kind),
  );
  assert.deepEqual(projectedKinds, new Set([
    'heading',
    'emphasis',
    'strong',
    'strikethrough',
    'inline-code',
    'fenced-code',
    'horizontal-rule',
  ]));
  assert.equal(
    describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }))
      .filter((construct) => construct.kind === 'heading').length,
    8,
  );

  const readingView = renderMarkdown(doc);
  assert.match(readingView, /<h1 id="atx-heading">ATX heading<\/h1>/);
  assert.match(readingView, /<h2 id="second-level-atx-heading">Second-level ATX heading<\/h2>/);
  assert.match(readingView, /<h3 id="third-level-atx-heading">Third-level ATX heading<\/h3>/);
  assert.match(readingView, /<h4 id="fourth-level-atx-heading">Fourth-level ATX heading<\/h4>/);
  assert.match(readingView, /<h5 id="fifth-level-atx-heading">Fifth-level ATX heading<\/h5>/);
  assert.match(readingView, /<h6 id="sixth-level-atx-heading">Sixth-level ATX heading<\/h6>/);
  assert.match(readingView, /<h1 id="setext-level-one-heading">Setext level one heading<\/h1>/);
  assert.match(readingView, /<h2 id="setext-level-two-heading">Setext level two heading<\/h2>/);
  assert.match(readingView, /<em>emphasis<\/em>/);
  assert.match(readingView, /<strong>strong<\/strong>/);
  assert.match(readingView, /<del>strikethrough<\/del>/);
  assert.match(readingView, /<code>inline code<\/code>/);
  assert.match(readingView, /<hr\s*\/?>/);
  assert.match(readingView, /<pre><code class="language-ts">/);
});

test('inactive Markdown constructs hide only recognized syntax and reveal every intersected construct', () => {
  const doc = '# Heading *em* **strong** ~~strike~~ `code`\n\n---\n\n**open';
  const inactive = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }));

  assert.deepEqual(
    inactive.map(({ kind, from, to, active }) => ({ kind, from, to, active })),
    [
      { kind: 'heading', from: 0, to: 43, active: false },
      { kind: 'emphasis', from: 10, to: 14, active: false },
      { kind: 'strong', from: 15, to: 25, active: false },
      { kind: 'strikethrough', from: 26, to: 36, active: false },
      { kind: 'inline-code', from: 37, to: 43, active: false },
      { kind: 'horizontal-rule', from: 45, to: 48, active: false },
    ],
  );

  const selected = describeLiveMarkdownProjection(markdownState(doc, { anchor: 12, head: 48 }));
  assert.ok(selected.every(({ active }) => active));
  assert.equal(markdownState(doc, { anchor: doc.length }).doc.toString(), doc);

  const atx = '# Heading\n\nbody';
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(atx, { anchor: atx.length })), [{ from: 0, to: 2 }]);
  const closingAtx = '# Heading #\n\nbody';
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(closingAtx, { anchor: closingAtx.length })), [
    { from: 0, to: 2 },
    { from: 9, to: 11 },
  ]);

  const setext = 'Setext heading\n===\n\nLower\n---';
  assert.deepEqual(
    describeLiveMarkdownProjection(markdownState(setext, { anchor: 19 })),
    [
      { kind: 'heading', from: 0, to: 18, active: false },
      { kind: 'heading', from: 20, to: 29, active: false },
    ],
  );
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(setext, { anchor: 19 })), [
    { from: 14, to: 18 },
    { from: 25, to: 29 },
  ]);
});

test('Live fenced code presents an inert block and reveals its fences on entry', () => {
  const doc = '```ts\nconst x = 1;\n```\n\nafter';

  const inactive = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }));
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].kind, 'fenced-code');
  assert.equal(inactive[0].from, 0);
  assert.equal(inactive[0].active, false);

  // Inactive conceals exactly the two fences and the language label.
  assert.deepEqual(
    hiddenMarkdownMarkupRanges(markdownState(doc, { anchor: doc.length }))
      .map((range) => markdownState(doc).sliceDoc(range.from, range.to)),
    ['```', 'ts', '```'],
  );

  // A cursor anywhere inside the block reveals it and conceals nothing.
  const inside = doc.indexOf('const') + 2;
  const active = describeLiveMarkdownProjection(markdownState(doc, { anchor: inside }));
  assert.equal(active.length, 1);
  assert.equal(active[0].active, true);
  assert.deepEqual(hiddenMarkdownMarkupRanges(markdownState(doc, { anchor: inside })), []);

  // Leaving the block restores its inactive presentation, and the
  // projection never rewrites source in either state.
  assert.equal(describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }))[0].active, false);
  assert.equal(markdownState(doc, { anchor: inside }).doc.toString(), doc);
});

test('Live fenced code stays safe across labels, unknown languages, and fenced content', () => {
  // Unlabeled, known, and unknown-language blocks all project one block
  // without throwing; the label is only concealed markup, never parsed.
  for (const info of ['', 'ts', 'totally-unknown-language']) {
    const doc = '```' + info + '\nvalue\n```\n\nafter';
    const projected = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }));
    assert.equal(projected.filter((construct) => construct.kind === 'fenced-code').length, 1);
  }

  // Backticks mid-line are content, not a fence, so the block stays whole.
  const withTicks = '```\na ``` b\nc\n```\n\nafter';
  assert.equal(
    describeLiveMarkdownProjection(markdownState(withTicks, { anchor: withTicks.length }))
      .filter((construct) => construct.kind === 'fenced-code').length,
    1,
  );

  // An unterminated fence uses the parser-defined boundary and never throws.
  const unterminated = '```ts\nstill going';
  assert.doesNotThrow(() => describeLiveMarkdownProjection(markdownState(unterminated, { anchor: 0 })));

  // Reading View remains the independent authority for fenced rendering.
  assert.match(renderMarkdown('```ts\nconst x = 1;\n```'), /<pre><code class="language-ts">/);
});

test('Find and undo operate on fenced-code source through Live Editing concealment', () => {
  // Find searches the document, so concealed fences and content stay
  // reachable: the token inside the block is matched.
  const doc = '```ts\nconst needle = 42;\n```';
  let searchState = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), search()],
  });
  const searchView = {
    get state() { return searchState; },
    dispatch(spec: Parameters<EditorState['update']>[0]) { searchState = searchState.update(spec).state; },
  } as unknown as EditorView;
  assert.equal(applyEditorQuery(searchView, 'needle', false, false, false).total, 1);

  // The projection adds no history, so an edit inside a block undoes as
  // one ordinary edit back to the exact source.
  const editView = testView(markdownState(doc, { anchor: doc.indexOf('needle') }));
  editView.dispatch({ changes: { from: doc.indexOf('needle'), insert: 'X' } });
  assert.equal(editView.state.doc.toString(), doc.replace('needle', 'Xneedle'));
  assert.equal(undo(editView), true);
  assert.equal(editView.state.doc.toString(), doc);
});

test('Live projection limits work to visible parsed ranges and falls back to source while composing', () => {
  const lines = Array.from({ length: 400 }, (_, index) => `# Heading ${index}\n\nparagraph ${index}`);
  const doc = lines.join('\n\n');
  const target = doc.indexOf('# Heading 0');
  const state = markdownState(doc, { anchor: target + 3 });

  const visible = describeLiveMarkdownProjection(state, {
    ranges: [{ from: target, to: target + 24 }],
  });
  assert.deepEqual(visible.map(({ kind, from }) => ({ kind, from })), [{ kind: 'heading', from: target }]);

  const composing = describeLiveMarkdownProjection(state, {
    ranges: [{ from: target, to: target + 24 }],
    sourceFallbackRanges: [{ from: target, to: target + 12 }],
  });
  assert.deepEqual(composing, []);

  assert.deepEqual(describeLiveMarkdownProjection(state, { ranges: [] }), []);
});

test('Live projection starts and ends source fallback through composition lifecycle effects', () => {
  let state = EditorState.create({ extensions: [liveMarkdownCompositionGuard] });
  const view = { get state() { return state; }, compositionStarted: false } as Pick<EditorView, 'state' | 'compositionStarted'>;
  assert.equal(isLiveMarkdownComposition(view), false);

  state = state.update({ effects: setLiveMarkdownComposition.of(true) }).state;
  assert.equal(isLiveMarkdownComposition(view), true);

  state = state.update({ effects: setLiveMarkdownComposition.of(false) }).state;
  assert.equal(isLiveMarkdownComposition(view), false);
});

test('Live projection refreshes after a background parse-tree update', () => {
  assert.equal(shouldRefreshLiveMarkdownProjection({
    docChanged: false,
    selectionSet: false,
    viewportChanged: false,
    treeChanged: true,
  }), true);
});

test('Live projection keeps RTL source offsets and cross-direction selections authoritative', () => {
  const doc = 'قبل **مهم** אחרי';
  const start = doc.indexOf('**');
  const state = markdownState(doc, { anchor: start + 3, head: start + 7 });
  const projection = describeLiveMarkdownProjection(state);
  assert.deepEqual(projection, [{ kind: 'strong', from: start, to: start + 7, active: true }]);
  assert.equal(state.doc.toString(), doc);
});

test('Markdown strong and emphasis commands wrap, toggle, insert pairs, and undo as one edit', () => {
  const strongView = testView(markdownState('alpha', { anchor: 0, head: 5 }));
  assert.equal(toggleMarkdownStrong(strongView), true);
  assert.equal(strongView.state.doc.toString(), '**alpha**');
  assert.equal(strongView.state.selection.main.from, 2);
  assert.equal(strongView.state.selection.main.to, 7);
  assert.equal(undo(strongView), true);
  assert.equal(strongView.state.doc.toString(), 'alpha');

  const toggleView = testView(markdownState('**alpha**', { anchor: 3, head: 6 }));
  assert.equal(toggleMarkdownStrong(toggleView), true);
  assert.equal(toggleView.state.doc.toString(), 'alpha');
  assert.equal(toggleView.state.selection.main.from, 1);
  assert.equal(toggleView.state.selection.main.to, 4);

  const underscoreView = testView(markdownState('__alpha__', { anchor: 3, head: 6 }));
  assert.equal(toggleMarkdownStrong(underscoreView), true);
  assert.equal(underscoreView.state.doc.toString(), 'alpha');

  const underscoreEmphasisView = testView(markdownState('_alpha_', { anchor: 2, head: 5 }));
  assert.equal(toggleMarkdownEmphasis(underscoreEmphasisView), true);
  assert.equal(underscoreEmphasisView.state.doc.toString(), 'alpha');

  const insertView = testView(markdownState('', { anchor: 0 }));
  assert.equal(toggleMarkdownEmphasis(insertView), true);
  assert.equal(insertView.state.doc.toString(), '**');
  assert.equal(insertView.state.selection.main.anchor, 1);
});

test('Live links are projected only when complete and reveal their entire source on selection', () => {
  const doc = 'Before [StashBase](docs/guide.md#start) after [bad](javascript:alert(1)) [open](';
  const start = doc.indexOf('[StashBase]');
  const inactive = describeLiveMarkdownProjection(markdownState(doc, { anchor: 0 }));
  assert.deepEqual(inactive.filter((item) => item.kind === 'link'), [
    { kind: 'link', from: start, to: start + '[StashBase](docs/guide.md#start)'.length, active: false },
  ]);
  assert.deepEqual(
    describeLiveMarkdownProjection(markdownState(doc, { anchor: start + 3 }))
      .filter((item) => item.kind === 'link'),
    [{ kind: 'link', from: start, to: start + '[StashBase](docs/guide.md#start)'.length, active: true }],
  );
  assert.equal(markdownState(doc).doc.toString(), doc);
});

test('Markdown link command wraps selections, edits an enclosing destination, and inserts paired source', () => {
  const wrapView = testView(markdownState('alpha', { anchor: 0, head: 5 }));
  assert.equal(toggleMarkdownLink(wrapView), true);
  assert.equal(wrapView.state.doc.toString(), '[alpha](url)');
  assert.equal(wrapView.state.selection.main.from, 8);
  assert.equal(wrapView.state.selection.main.to, 11);
  assert.equal(undo(wrapView), true);
  assert.equal(wrapView.state.doc.toString(), 'alpha');

  const editView = testView(markdownState('[alpha](note.md)', { anchor: 3 }));
  assert.equal(toggleMarkdownLink(editView), true);
  assert.equal(editView.state.selection.main.from, 8);
  assert.equal(editView.state.selection.main.to, 15);

  const titledView = testView(markdownState('[alpha](note.md "A title")', { anchor: 3 }));
  assert.equal(toggleMarkdownLink(titledView), true);
  assert.equal(titledView.state.selection.main.from, 8);
  assert.equal(titledView.state.selection.main.to, 15);

  const insertView = testView(markdownState('', { anchor: 0 }));
  assert.equal(toggleMarkdownLink(insertView), true);
  assert.equal(insertView.state.doc.toString(), '[link text](url)');
  assert.equal(insertView.state.selection.main.from, 1);
  assert.equal(insertView.state.selection.main.to, 10);
});

test('Live link activation uses in-app note navigation and the system-browser boundary', () => {
  const calls: Array<[string, string | undefined]> = [];
  followLiveMarkdownLink({ label: 'Section', href: '../other.md#section' }, 'docs/note.md', async (path, anchor) => {
    calls.push([path, anchor]);
  });
  assert.deepEqual(calls, [['other.md', 'section']]);

  followLiveMarkdownLink({ label: 'Same heading', href: '#heading' }, 'renamed/note.md', async (path, anchor) => {
    calls.push([path, anchor]);
  });
  followLiveMarkdownLink({ label: 'Spaced note', href: 'StashBase%20Features.md' }, 'Examples/footnotes.md', async (path, anchor) => {
    calls.push([path, anchor]);
  });
  assert.deepEqual(calls, [
    ['other.md', 'section'],
    ['renamed/note.md', 'heading'],
    ['Examples/StashBase Features.md', undefined],
  ]);
});

test('Live Editing resolves same-note GitHub heading anchors without changing source', () => {
  const doc = '# Footnote verification\n\n## [Footnote verification](other.md)\n\n# &nbsp; Entity heading\n\nBody';
  const state = markdownState(doc);
  assert.equal(liveHeadingPosition(state, 'footnote-verification'), 0);
  assert.equal(liveHeadingPosition(state, 'footnote-verification-1'), doc.indexOf('##'));
  assert.equal(liveHeadingPosition(state, 'entity-heading'), doc.indexOf('# &nbsp; Entity heading'));
  assert.equal(liveHeadingPosition(state, 'missing'), null);
  assert.equal(state.doc.toString(), doc);

  // Anchor navigation cannot rely on the viewport-driven parser having
  // reached the destination already.
  const unparsed = EditorState.create({
    doc: '# Off-screen heading',
    extensions: [markdown({ base: markdownLanguage })],
  });
  assert.equal(liveHeadingPosition(unparsed, 'off-screen-heading'), 0);
});
