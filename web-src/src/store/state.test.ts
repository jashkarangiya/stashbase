import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialState,
  optimisticKeyBackfillPaths,
  reducer,
  renamedFilePath,
  stashingPaths,
  type State,
  type Tab,
} from './state.ts';

function tab(id: string, name: string): Tab {
  return {
    id,
    file: { name, format: 'md', content: '' },
    editMode: false,
    preview: false,
    pendingAnchor: null,
    pendingHighlight: null,
    saveStatus: { text: '', cls: '' },
  };
}

function stateWithTabs(): State {
  return {
    ...initialState,
    tabs: [
      tab('a', 'docs/one.md'),
      tab('b', 'docs/sub/two.md'),
      tab('c', 'other.md'),
    ],
    activeTabId: 'b',
    expanded: new Set(['docs', 'docs/sub', 'other-folder']),
    activeFolder: 'docs/sub',
    selectedPath: 'docs/sub/two.md',
  };
}

test('REMAP_PATHS updates every open tab under a renamed folder', () => {
  const next = reducer({
    ...stateWithTabs(),
    files: [
      { name: 'docs/one.md', format: 'md', heading: '', snippet: '' },
      { name: 'docs/sub/two.md', format: 'md', heading: '', snippet: '' },
      { name: 'other.md', format: 'md', heading: '', snippet: '' },
    ],
    folders: [{ path: 'docs' }, { path: 'docs/sub' }, { path: 'other-folder' }],
  }, {
    type: 'REMAP_PATHS',
    kind: 'folder',
    from: 'docs',
    to: 'notes',
  });

  assert.deepEqual(next.tabs.map((t) => t.file?.name), [
    'notes/one.md',
    'notes/sub/two.md',
    'other.md',
  ]);
  assert.deepEqual(next.files.map((f) => f.name), [
    'notes/one.md',
    'notes/sub/two.md',
    'other.md',
  ]);
  assert.deepEqual(next.folders.map((f) => f.path), ['notes', 'notes/sub', 'other-folder']);
  assert.deepEqual([...next.expanded].sort(), ['notes', 'notes/sub', 'other-folder']);
  assert.equal(next.activeFolder, 'notes/sub');
  assert.equal(next.selectedPath, 'notes/sub/two.md');
});

test('REMAP_PATHS carries manual file order through a renamed folder', () => {
  const next = reducer({
    ...stateWithTabs(),
    fileOrder: {
      '': ['docs', 'other.md'],
      docs: ['sub', 'one.md'],
      'docs/sub': ['two.md'],
    },
  }, {
    type: 'REMAP_PATHS',
    kind: 'folder',
    from: 'docs',
    to: 'notes',
  });

  assert.deepEqual(next.fileOrder, {
    '': ['notes', 'other.md'],
    notes: ['sub', 'one.md'],
    'notes/sub': ['two.md'],
  });
});

test('REMAP_PATHS updates one file without touching sibling prefixes', () => {
  const next = reducer({
    ...stateWithTabs(),
    tabs: [
      tab('a', 'note.md'),
      tab('b', 'note.md.backup'),
    ],
    files: [
      { name: 'note.md', format: 'md', heading: '', snippet: '' },
      { name: 'note.md.backup', format: 'md', heading: '', snippet: '' },
    ],
    selectedPath: 'note.md',
  }, {
    type: 'REMAP_PATHS',
    kind: 'file',
    from: 'note.md',
    to: 'renamed.md',
  });

  assert.deepEqual(next.tabs.map((t) => t.file?.name), ['renamed.md', 'note.md.backup']);
  assert.deepEqual(next.files.map((f) => f.name), ['renamed.md', 'note.md.backup']);
  assert.equal(next.selectedPath, 'renamed.md');
});

test('REMAP_PATHS carries manual file order through a file rename', () => {
  const next = reducer({
    ...stateWithTabs(),
    fileOrder: {
      docs: ['one.md', 'sub'],
    },
  }, {
    type: 'REMAP_PATHS',
    kind: 'file',
    from: 'docs/one.md',
    to: 'docs/renamed.md',
  });

  assert.deepEqual(next.fileOrder, {
    docs: ['renamed.md', 'sub'],
  });
});

test('renamedFilePath preserves viewer and editable file extensions', () => {
  assert.equal(renamedFilePath('docs/note.md', 'renamed'), 'docs/renamed.md');
  assert.equal(renamedFilePath('docs/page.html', 'renamed'), 'docs/renamed.html');
  assert.equal(renamedFilePath('docs/paper.pdf', 'renamed'), 'docs/renamed.pdf');
  assert.equal(renamedFilePath('docs/shot.PNG', 'renamed'), 'docs/renamed.PNG');
});

test('stashingPaths resumes pending note visibility when an embedder key is added', () => {
  const withoutKey = reducer({
    ...initialState,
    pendingNames: new Set(['note.md', '.paper.pdf.md']),
    pendingConversions: ['paper.pdf'],
  }, { type: 'EMBEDDER_KEY_STATE', hasKey: false });

  assert.deepEqual(stashingPaths(withoutKey), ['paper.pdf']);

  const withKey = reducer(withoutKey, { type: 'EMBEDDER_KEY_STATE', hasKey: true });

  assert.deepEqual(stashingPaths(withKey), ['note.md', 'paper.pdf']);
});

test('optimisticKeyBackfillPaths marks only visible searchable files', () => {
  assert.deepEqual(optimisticKeyBackfillPaths([
    { name: 'note.md', format: 'md', heading: '', snippet: '' },
    { name: 'page.html', format: 'html', heading: '', snippet: '' },
    { name: 'paper.pdf', format: 'pdf', heading: '', snippet: '' },
    { name: 'shot.png', format: 'image', heading: '', snippet: '' },
    { name: '.paper.pdf.md', format: 'md', heading: '', snippet: '' },
  ]), ['note.md', 'page.html', 'paper.pdf', 'shot.png']);
});

test('SEARCH_START clears stale semantic and keyword results', () => {
  const before: State = {
    ...initialState,
    searching: false,
    searchError: 'old error',
    searchHits: [{
      fileName: 'old.md',
      chunkIndex: 0,
      content: 'old',
      heading: '',
      score: 1,
    }],
    keywordResult: {
      query: 'old',
      space: 'Space A',
      files: [{ path: 'old.md', matches: [{ line: 1, text: 'old', ranges: [[0, 3]] }], totalMatches: 1 }],
      totalMatches: 1,
      truncated: false,
    },
  };

  const next = reducer(before, { type: 'SEARCH_START' });

  assert.equal(next.searching, true);
  assert.equal(next.searchError, null);
  assert.equal(next.searchHits, null);
  assert.equal(next.keywordResult, null);
});

test('FILE_OPEN and FILE_PATCH carry file versions for conflict-safe saves', () => {
  const opened = reducer(initialState, {
    type: 'FILE_OPEN',
    body: { name: 'note.md', format: 'md', content: 'first', version: 'v1' },
  });

  assert.equal(opened.tabs[0].file?.version, 'v1');

  const patched = reducer(opened, {
    type: 'FILE_PATCH',
    patch: { content: 'second', version: 'v2' },
  });

  assert.equal(patched.tabs[0].file?.content, 'second');
  assert.equal(patched.tabs[0].file?.version, 'v2');
});

test('SPACE_NAME updates only the current space label', () => {
  const before = {
    ...stateWithTabs(),
    files: [{ name: 'docs/one.md', format: 'md' as const, heading: '', snippet: '' }],
    space: 'Old',
  };
  const next = reducer(before, { type: 'SPACE_NAME', space: 'New' });

  assert.equal(next.space, 'New');
  assert.equal(next.tabs, before.tabs);
  assert.equal(next.files, before.files);
  assert.equal(next.selectedPath, 'docs/sub/two.md');
});

test('PRUNE_MISSING_FILE_TABS closes non-editing tabs that disappeared from disk', () => {
  const next = reducer(stateWithTabs(), {
    type: 'PRUNE_MISSING_FILE_TABS',
    names: ['docs/one.md', 'other.md'],
  });

  assert.deepEqual(next.tabs.map((t) => t.id), ['a', 'c']);
  assert.equal(next.activeTabId, 'c');
  assert.equal(next.selectedPath, 'other.md');
});

test('PRUNE_MISSING_FILE_TABS keeps edit buffers and kb tabs', () => {
  const editing = { ...tab('edit', 'missing.md'), editMode: true };
  const kb: Tab = {
    ...tab('kb', 'STASHBASE.md'),
    file: { name: 'STASHBASE.md', format: 'md', content: '', kind: 'kb' },
  };
  const next = reducer({
    ...initialState,
    tabs: [editing, kb, tab('stale', 'gone.md')],
    activeTabId: 'edit',
    selectedPath: 'missing.md',
  }, {
    type: 'PRUNE_MISSING_FILE_TABS',
    names: [],
  });

  assert.deepEqual(next.tabs.map((t) => t.id), ['edit', 'kb']);
  assert.equal(next.activeTabId, 'edit');
  assert.equal(next.selectedPath, 'missing.md');
});

test('PRUNE_MISSING_FILE_TABS preserves selection when only background tabs disappear', () => {
  const next = reducer({
    ...initialState,
    tabs: [
      { ...tab('blank', 'unused.md'), file: null },
      tab('stale', 'gone.md'),
    ],
    activeTabId: 'blank',
    selectedPath: 'folder',
  }, {
    type: 'PRUNE_MISSING_FILE_TABS',
    names: [],
  });

  assert.deepEqual(next.tabs.map((t) => t.id), ['blank']);
  assert.equal(next.activeTabId, 'blank');
  assert.equal(next.selectedPath, 'folder');
});
