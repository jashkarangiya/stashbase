import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { search } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import {
  applyEditorQuery,
  copyLiveMarkdownSource,
  cutLiveMarkdownSource,
  followLiveMarkdownLink,
  liveHeadingPosition,
  liveMarkdownLanguage,
  pasteLiveMarkdownPlainText,
  selectedMarkdownSource,
} from '../components/CodeEditor.tsx';
import { renderMarkdown } from '../markdown.ts';
import {
  describeLiveMarkdownProjection,
  completeMarkdownBacktick,
  continueMarkdownBlockquote,
  continueMarkdownListItem,
  continueMarkdownListLine,
  hiddenMarkdownMarkupRanges,
  indentMarkdownListItem,
  isLiveMarkdownComposition,
  liveMarkdownCompositionGuard,
  setLiveMarkdownComposition,
  shouldRefreshLiveMarkdownProjection,
  toggleMarkdownEmphasis,
  toggleMarkdownLink,
  toggleMarkdownStrong,
} from '../components/liveMarkdown.ts';
import { sourceMatches, sourceMatchState } from '../components/editorMatches.ts';

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

function clipboardEvent(plainText = '', types = ['text/plain']) {
  const written = new Map<string, string>();
  let prevented = false;
  return {
    event: {
      clipboardData: {
        types,
        getData: (type: string) => type === 'text/plain' ? plainText : '<b>converted</b>',
        setData: (type: string, value: string) => written.set(type, value),
      },
      preventDefault: () => { prevented = true; },
    } as unknown as ClipboardEvent,
    written,
    wasPrevented: () => prevented,
  };
}

test('Live Editing clipboard operations use exact Markdown source through concealed constructs', () => {
  const doc = 'Before [StashBase](docs/guide.md) and **strong** after';
  const linkFrom = doc.indexOf('[');
  const linkTo = doc.indexOf(')') + 1;
  const strongFrom = doc.indexOf('**strong**');
  const state = markdownState(doc, EditorSelection.create([
    EditorSelection.range(linkFrom, linkTo),
    EditorSelection.range(strongFrom, strongFrom + '**strong**'.length),
  ]));
  const view = testView(state);
  assert.equal(selectedMarkdownSource(view.state), '[StashBase](docs/guide.md)\n**strong**');

  const copy = clipboardEvent();
  assert.equal(copyLiveMarkdownSource(copy.event, view), true);
  assert.equal(copy.written.get('text/plain'), '[StashBase](docs/guide.md)\n**strong**');
  assert.equal(copy.wasPrevented(), true);

  const cut = clipboardEvent();
  assert.equal(cutLiveMarkdownSource(cut.event, view), true);
  assert.equal(cut.written.get('text/plain'), '[StashBase](docs/guide.md)\n**strong**');
  assert.equal(view.state.doc.toString(), 'Before  and  after');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), doc);

  const cursorOnly = testView(markdownState('unchanged', { anchor: 3 }));
  const cursorCopy = clipboardEvent();
  const cursorCut = clipboardEvent();
  assert.equal(copyLiveMarkdownSource(cursorCopy.event, cursorOnly), false);
  assert.equal(cutLiveMarkdownSource(cursorCut.event, cursorOnly), false);
  assert.equal(cursorCopy.wasPrevented(), false);
  assert.equal(cursorCut.wasPrevented(), false);
  assert.equal(cursorOnly.state.doc.toString(), 'unchanged');
});

test('Live Editing pastes plain text at every selection and ignores clipboard HTML', () => {
  const view = testView(markdownState('one [label](url) two **three**', EditorSelection.create([
    EditorSelection.range(4, 16), EditorSelection.range(21, 30),
  ])));
  const paste = clipboardEvent('literal <b>text</b>');
  assert.equal(pasteLiveMarkdownPlainText(paste.event, view), true);
  assert.equal(paste.wasPrevented(), true);
  assert.equal(view.state.doc.toString(), 'one literal <b>text</b> two literal <b>text</b>');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), 'one [label](url) two **three**');

  const htmlOnly = clipboardEvent('', ['text/html']);
  assert.equal(pasteLiveMarkdownPlainText(htmlOnly.event, view), true);
  assert.equal(htmlOnly.wasPrevented(), true);
  assert.equal(view.state.doc.toString(), 'one [label](url) two **three**');
});

test('Live Find searches concealed Markdown source and reveals every matching construct', () => {
  const doc = '**concealed** [label](hidden-destination.md)\n<div data-hidden="source">raw</div>\n---\ntitle: source\n---\nunsupported :term:';
  let state = EditorState.create({
    doc,
    extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage }), search()],
  });
  ensureSyntaxTree(state, state.doc.length, 1_000);
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state; },
    plugin: () => null,
  } as unknown as EditorView;

  assert.deepEqual(applyEditorQuery(view, 'hidden-destination.md', false, false), { current: 1, total: 1 });
  const link = describeLiveMarkdownProjection(view.state).find((construct) => construct.kind === 'link');
  assert.deepEqual(link, {
    kind: 'link',
    from: doc.indexOf('[label]'),
    to: doc.indexOf(')') + 1,
    active: true,
  });
  assert.deepEqual(applyEditorQuery(view, 'data-hidden', false, false), { current: 1, total: 1 });
  assert.deepEqual(applyEditorQuery(view, 'title:', false, false), { current: 1, total: 1 });
  assert.deepEqual(applyEditorQuery(view, ':term:', false, false), { current: 1, total: 1 });
});

test('Live Find reveals non-current source matches so all result decorations remain visible', () => {
  const doc = '[first](hidden-destination.md) and [second](hidden-destination.md)';
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [sourceMatchState, markdown({ base: markdownLanguage }), search()],
  });
  ensureSyntaxTree(state, state.doc.length, 1_000);
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state; },
  } as unknown as EditorView;

  assert.deepEqual(applyEditorQuery(view, 'hidden-destination.md', false, false, false), { current: 0, total: 2 });
  assert.equal(sourceMatches(view.state).mode, 'find');
  const links = describeLiveMarkdownProjection(view.state).filter((construct) => construct.kind === 'link');
  assert.equal(links.length, 2);
  assert.ok(links.every((link) => link.active));
});

test('selected-word matching shares Find case rules and reveals matching headings', () => {
  const doc = '# Footnote verification\n\nfootnote';
  const selectedFrom = doc.lastIndexOf('footnote');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(selectedFrom, selectedFrom + 'footnote'.length),
    extensions: [sourceMatchState, markdown({ base: markdownLanguage }), search()],
  });
  ensureSyntaxTree(state, state.doc.length, 1_000);

  assert.deepEqual(sourceMatches(state), {
    mode: 'selection',
    matches: [
      { from: doc.indexOf('Footnote'), to: doc.indexOf('Footnote') + 'Footnote'.length },
      { from: selectedFrom, to: selectedFrom + 'footnote'.length },
    ],
    activeIndex: 1,
  });
  assert.equal(describeLiveMarkdownProjection(state).find((construct) => construct.kind === 'heading')?.active, true);
});

test('a secondary selection reveals its intersected Live Editing construct', () => {
  const doc = 'before [label](destination.md) after';
  const state = markdownState(doc, EditorSelection.create([
    EditorSelection.cursor(0),
    EditorSelection.range(doc.indexOf('destination.md'), doc.indexOf('destination.md') + 'destination.md'.length),
  ]));
  assert.deepEqual(describeLiveMarkdownProjection(state).find((construct) => construct.kind === 'link'), {
    kind: 'link',
    from: doc.indexOf('[label]'),
    to: doc.indexOf(')') + 1,
    active: true,
  });
});

function markdownState(doc: string, selection?: EditorSelection | { anchor: number; head?: number }) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage }), history()],
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

test('indented horizontal rules remain valid Live Editing constructs', () => {
  const doc = 'before\n\n   ---\n\nafter';
  const rule = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.length }))
    .find((construct) => construct.kind === 'horizontal-rule');
  assert.deepEqual(rule, {
    kind: 'horizontal-rule',
    from: doc.indexOf('---'),
    to: doc.indexOf('---') + 3,
    active: false,
  });
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

test('Live fenced TypeScript loads a parser and exposes highlighted syntax tokens', async () => {
  const typescript = languages.find((language) => language.name === 'TypeScript');
  assert.ok(typescript);
  await typescript.load();

  const doc = '```ts\nconst value = 42;\n```';
  const state = EditorState.create({ doc, extensions: [liveMarkdownLanguage] });
  ensureSyntaxTree(state, state.doc.length, 1_000);

  // resolveInner reaches the mounted code-language tree, whereas resolve()
  // returns the Markdown host node. This is the syntax source consumed by
  // CodeMirror's static token highlighter.
  assert.equal(syntaxTree(state).resolveInner(doc.indexOf('const'), 1).name, 'const');
  assert.equal(syntaxTree(state).resolveInner(doc.indexOf('value'), 1).name, 'VariableDefinition');
});

test('Live Editing completes inline backticks and empty-line fences', () => {
  const inline = testView(markdownState('', { anchor: 0 }));
  assert.equal(completeMarkdownBacktick(inline, 0, 0, '`'), true);
  assert.equal(inline.state.doc.toString(), '``');
  assert.equal(inline.state.selection.main.anchor, 1);

  const wrapped = testView(markdownState('hello', { anchor: 0, head: 5 }));
  assert.equal(completeMarkdownBacktick(wrapped, 0, 5, '`'), true);
  assert.equal(wrapped.state.doc.toString(), '`hello`');
  assert.deepEqual([wrapped.state.selection.main.from, wrapped.state.selection.main.to], [1, 6]);

  const fenced = testView(markdownState('', { anchor: 0 }));
  fenced.dispatch({ changes: { from: 0, insert: '`' }, selection: { anchor: 1 } });
  assert.equal(completeMarkdownBacktick(fenced, 1, 1, '`'), false);
  fenced.dispatch({ changes: { from: 1, insert: '`' }, selection: { anchor: 2 } });
  assert.equal(completeMarkdownBacktick(fenced, 2, 2, '`'), true);
  assert.equal(fenced.state.doc.toString(), '```\n```');
  assert.equal(fenced.state.selection.main.anchor, 3);

  // Inside an existing block, three ticks close that block; they must not
  // trigger a second auto-completed fence.
  const unterminated = '```ts\nconst value = 42;\n';
  const closing = testView(markdownState(unterminated, { anchor: unterminated.length }));
  for (let index = 0; index < 3; index++) {
    const position = closing.state.selection.main.from;
    assert.equal(completeMarkdownBacktick(closing, position, position, '`'), false);
    closing.dispatch({ changes: { from: position, insert: '`' }, selection: { anchor: position + 1 } });
  }
  assert.equal(closing.state.doc.toString(), `${unterminated}\`\`\``);
});

test('Live lists replace only the marker and reveal it only at its source position', () => {
  const doc = '- parent\n  - child\n- [ ] task';
  const projection = describeLiveMarkdownProjection(markdownState(doc, { anchor: doc.indexOf('child') }));
  const items = projection.filter((construct) => construct.kind === 'list-item');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.active), [false, false, false]);
  const markerProjection = describeLiveMarkdownProjection(markdownState(doc, { anchor: 0 }))
    .filter((construct) => construct.kind === 'list-item');
  assert.deepEqual(markerProjection.map((item) => item.active), [true, false, false]);
  const afterBullet = describeLiveMarkdownProjection(markdownState('- item', { anchor: 1 }))
    .find((item) => item.kind === 'list-item');
  assert.equal(afterBullet?.active, false);
  const afterTaskMarker = describeLiveMarkdownProjection(markdownState('- [ ] task', { anchor: 6 }))
    .find((item) => item.kind === 'list-item');
  assert.equal(afterTaskMarker?.active, false);
  assert.equal(markdownState(doc).doc.toString(), doc);
});

test('An empty Markdown list item becomes a projected list as soon as its marker has a space', () => {
  const projection = describeLiveMarkdownProjection(markdownState('- ', { anchor: 2 }));
  const item = projection.find((construct) => construct.kind === 'list-item');
  assert.ok(item);
  assert.equal(item.active, false);
});

test('Ordered list markers remain source-visible while retaining list presentation', () => {
  const projection = describeLiveMarkdownProjection(markdownState('2. second item', { anchor: 12 }));
  const item = projection.find((construct) => construct.kind === 'list-item');
  assert.ok(item);
  assert.equal(item.active, false);
});

test('Live list commands preserve branches, marker forms, and source fallback', () => {
  const ordered = testView(markdownState('009) first', { anchor: 10 }));
  assert.equal(continueMarkdownListItem(ordered), true);
  assert.equal(ordered.state.doc.toString(), '009) first\n010) ');
  assert.equal(undo(ordered), true);
  assert.equal(ordered.state.doc.toString(), '009) first');

  const task = testView(markdownState('- [x] done', { anchor: 10 }));
  assert.equal(continueMarkdownListItem(task), true);
  assert.equal(task.state.doc.toString(), '- [x] done\n- [ ] ');

  const detachAtContentStart = testView(markdownState('- first item\n- hello', { anchor: 15 }));
  assert.equal(continueMarkdownListItem(detachAtContentStart), true);
  assert.equal(detachAtContentStart.state.doc.toString(), '- first item\nhello');

  const nestedExit = testView(markdownState('- parent\n  - ', { anchor: 12 }));
  assert.equal(continueMarkdownListItem(nestedExit), true);
  assert.equal(nestedExit.state.doc.toString(), '- parent\n- ');

  const rootExit = testView(markdownState('- ', { anchor: 2 }));
  assert.equal(continueMarkdownListItem(rootExit), true);
  assert.equal(rootExit.state.doc.toString(), '');

  const rootBranchExit = testView(markdownState('- \n  - child\n    - grandchild', { anchor: 2 }));
  assert.equal(continueMarkdownListItem(rootBranchExit), true);
  assert.equal(rootBranchExit.state.doc.toString(), '- child\n  - grandchild');

  const nestedBranchExit = testView(markdownState('- parent\n  - \n    - child', { anchor: 12 }));
  assert.equal(continueMarkdownListItem(nestedBranchExit), true);
  assert.equal(nestedBranchExit.state.doc.toString(), '- parent\n- \n  - child');

  const quote = testView(markdownState('> first', { anchor: 7 }));
  assert.equal(continueMarkdownBlockquote(quote), true);
  assert.equal(quote.state.doc.toString(), '> first\n> ');
  const nestedQuote = testView(markdownState('> > ', { anchor: 4 }));
  assert.equal(continueMarkdownBlockquote(nestedQuote), true);
  assert.equal(nestedQuote.state.doc.toString(), '> ');

  const branch = testView(markdownState('- one\n- two\n  - child', { anchor: 8 }));
  assert.equal(indentMarkdownListItem(branch), true);
  assert.equal(branch.state.doc.toString(), '- one\n  - two\n    - child');
  assert.equal(indentMarkdownListItem(branch, true), true);
  assert.equal(branch.state.doc.toString(), '- one\n- two\n  - child');

  const firstItem = testView(markdownState('- only', { anchor: 2 }));
  assert.equal(indentMarkdownListItem(firstItem), false);

  const continuation = testView(markdownState('- first', { anchor: 7 }));
  assert.equal(continueMarkdownListLine(continuation), true);
  assert.equal(continuation.state.doc.toString(), '- first\n  ');

  const codeFallback = testView(markdownState('    - code', { anchor: 10 }));
  assert.equal(continueMarkdownListItem(codeFallback), false);
  assert.equal(indentMarkdownListItem(codeFallback), false);
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
